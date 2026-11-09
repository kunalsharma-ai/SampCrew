import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { ClientSession, Db, MongoClient, TransactionOptions } from 'mongodb';
import { mongo } from '@crew/db';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { requestContext } from '../context/request-context';
import { ScopeViolationError, type Scope, type Table } from './mongo-scope';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const MAX_ATTEMPTS = 8;
/**
 * How long a transaction keeps retrying write conflicts. Writers to one hot document (a workspace's audit-chain head)
 * succeed one per round, so a burst of N of them needs about N rounds: retry on time, not on a small count, as
 * PostgreSQL made them wait on the row lock instead of failing.
 */
const CONFLICT_RETRY_MS = 30_000;

function hasLabel(err: unknown, label: string): boolean {
  return typeof (err as { hasErrorLabel?: unknown })?.hasErrorLabel === 'function' && (err as { hasErrorLabel(l: string): boolean }).hasErrorLabel(label);
}

/** A commit whose outcome is unknown (e.g. a network blip) is safe to repeat. */
async function commitWithRetry(session: ClientSession): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await session.commitTransaction();
      return;
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && hasLabel(err, 'UnknownTransactionCommitResult')) continue;
      throw err;
    }
  }
}

const TRANSACTION: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

/** Work queued to run inside the transaction just before it commits (the audit trail), in the order it was asked. */
abstract class BaseTx {
  private readonly jobs: Array<() => Promise<unknown>> = [];

  constructor(
    readonly session: ClientSession,
    protected readonly db: Db,
    protected readonly tables: Record<string, mongo.TableSpec>,
  ) {}

  /** Runs `job` inside this transaction, after the rest of the work and just before commit. */
  defer(job: () => Promise<unknown>): void {
    this.jobs.push(job);
  }

  /** Appends to the workspace's (or the platform's) audit chain as the transaction's last write. */
  audit(input: mongo.AuditEventInput): void {
    // Checked now, so a bad action fails where it is written rather than at commit.
    if (!mongo.AUDIT_ACTION.test(input.action)) throw new Error(`Invalid audit action "${input.action}"`);
    this.defer(() => mongo.appendAuditEvent(this.db, this.session, input));
  }

  /** @internal */
  async flush(): Promise<void> {
    for (const job of this.jobs.splice(0)) await job();
  }
}

/** A transaction confined to one workspace. Everything it reads or writes carries that workspace's tenant_id. */
export class TenantTx extends BaseTx {
  private readonly scope: Scope;

  constructor(session: ClientSession, db: Db, readonly tenantId: string, readonly userId: string | null, tables: Record<string, mongo.TableSpec>) {
    super(session, db, tables);
    this.scope = { kind: 'tenant', id: tenantId };
  }

  /** A table seen from this workspace: its own rows only, shared reference data read-only. */
  collection<T extends Row = Row>(name: string, options: { flags?: string[] } = {}): Table<T> {
    return new mongo.Table<T>(this.db, name, this.session, { scope: this.scope, tables: this.tables, readOnly: name === mongo.AUDIT_EVENTS, flags: options.flags });
  }

  /** People who are members of this workspace (invited, active or suspended), without password hashes or MFA secrets. */
  async users(): Promise<Table<Row>> {
    const ids = await this.db.collection('memberships').distinct('user_id', { tenant_id: this.tenantId }, { session: this.session });
    return new mongo.Table(this.db, 'users', this.session, { scope: null, tables: this.tables, readOnly: true, workspaceColumns: true, within: { _id: { $in: ids } } });
  }

  /**
   * A table without the workspace restriction, in this same transaction: for the few reviewed places where a workspace
   * action creates or changes a global record (a person's identity when they are invited). Prefer collection().
   */
  unscoped<T extends Row = Row>(name: string, options: { flags?: string[] } = {}): Table<T> {
    return new mongo.Table<T>(this.db, name, this.session, { scope: null, tables: this.tables, flags: options.flags });
  }

  /** Recomputes this workspace's audit hash chain. */
  verifyAuditChain(): Promise<{ checked: number; firstBrokenSeq: number | null }> {
    return mongo.verifyAuditChain(this.db, this.tenantId);
  }

  /** Appends to this workspace's audit chain; an event for any other workspace is refused. */
  override audit(input: Omit<mongo.AuditEventInput, 'tenant_id'> & { tenant_id?: string | null }): void {
    if (input.tenant_id !== undefined && input.tenant_id !== this.tenantId) {
      throw new ScopeViolationError('Audit events from a workspace transaction must belong to that workspace');
    }
    super.audit({ ...input, tenant_id: this.tenantId });
  }
}

/** Before a workspace is chosen: only the signed-in user's own documents (e.g. their memberships), read-only. */
export class UserTx extends BaseTx {
  private readonly scope: Scope;

  constructor(session: ClientSession, db: Db, readonly userId: string, tables: Record<string, mongo.TableSpec>) {
    super(session, db, tables);
    this.scope = { kind: 'user', id: userId };
  }

  collection<T extends Row = Row>(name: string): Table<T> {
    return new mongo.Table<T>(this.db, name, this.session, { scope: this.scope, tables: this.tables });
  }
}

/**
 * Unrestricted access, for authentication bootstrap, background workers and the SAMPLEDGE Super Admin Console.
 * Call sites are few and reviewed, as with crew_platform on PostgreSQL. Data rules still apply.
 */
export class PlatformTx extends BaseTx {
  collection<T extends Row = Row>(name: string): Table<T> {
    return new mongo.Table<T>(this.db, name, this.session, { scope: null, tables: this.tables });
  }

  /** The raw database, for the few operations tables do not cover. Pass `session` to every call. */
  get database(): Db {
    return this.db;
  }
}

/**
 * MongoDB access for the API, replacing DatabaseService module by module. The same three transaction kinds:
 *
 *  - tenant():   confined to the current request's workspace (or an explicit one for background workers).
 *  - user():     only the signed-in user's own documents, for flows that run before a workspace is chosen.
 *  - platform(): unrestricted, for authentication bootstrap and the Super Admin Console.
 *
 * Each runs as one multi-document transaction (snapshot reads, majority commit). MongoDB aborts one of two
 * transactions that write the same document, and the driver then runs the whole callback again, so callbacks must
 * not have side effects outside the database: queue email and webhooks through the outbox as today.
 *
 * Until the cut-over, MONGODB_URL is optional and nothing connects unless it is set.
 */
@Injectable()
export class MongoService implements OnModuleDestroy {
  private readonly logger = new Logger('MongoDB');
  private client: MongoClient | null = null;
  private connecting: Promise<MongoClient> | null = null;
  private readonly dbName: string | null;
  tables: Record<string, mongo.TableSpec> = mongo.TABLES;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.dbName = config.MONGODB_URL ? mongo.databaseName(config.MONGODB_URL) : null;
  }

  get configured(): boolean {
    return !!this.config.MONGODB_URL;
  }

  async onModuleDestroy() {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    await client?.close();
  }

  /** The connected database, connecting on first use. */
  async database(): Promise<Db> {
    return (await this.connect()).db(this.dbName!);
  }

  async ping(): Promise<boolean> {
    try {
      await (await this.database()).command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  /** A cluster-wide lock for work only one API server should do at a time; null when another server holds it. */
  async tryLease(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    return mongo.tryLease(await this.database(), key, ttlMs);
  }

  tenant<T>(fn: (tx: TenantTx) => Promise<T>, scope?: { tenantId: string; userId?: string }): Promise<T> {
    const actor = requestContext.get()?.actor;
    const tenantId = scope?.tenantId ?? (actor?.kind === 'user' ? actor.tenantId : undefined);
    const userId = scope?.userId ?? (actor?.kind === 'user' ? actor.userId : undefined);
    if (!tenantId) throw new Error('tenant() called without a tenant in context');
    return this.run((session, db) => new TenantTx(session, db, tenantId, userId ?? null, this.tables), fn);
  }

  user<T>(userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T> {
    if (!userId) throw new Error('user() called without a user');
    return this.run((session, db) => new UserTx(session, db, userId, this.tables), fn);
  }

  platform<T>(fn: (tx: PlatformTx) => Promise<T>): Promise<T> {
    return this.run((session, db) => new PlatformTx(session, db, this.tables), fn);
  }

  private async run<X extends BaseTx, T>(make: (session: ClientSession, db: Db) => X, fn: (tx: X) => Promise<T>): Promise<T> {
    const client = await this.connect();
    const db = client.db(this.dbName!);
    const session = client.startSession({ causalConsistency: true });
    try {
      // Two transactions writing the same document: MongoDB aborts one with a transient error and the whole callback
      // runs again, a bounded number of times. Anything else ends the transaction, as an error did in PostgreSQL.
      const started = Date.now();
      for (let attempt = 1; ; attempt++) {
        session.startTransaction(TRANSACTION);
        try {
          // A fresh handle per attempt, so work deferred by an aborted attempt is not replayed.
          const tx = make(session, db);
          const result = await fn(tx);
          await tx.flush();
          await commitWithRetry(session);
          return result;
        } catch (err) {
          if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
          if (hasLabel(err, 'TransientTransactionError') && Date.now() - started < CONFLICT_RETRY_MS) {
            await new Promise((r) => setTimeout(r, Math.min(5 * 2 ** Math.min(attempt, 6), 200) * Math.random()));
            continue;
          }
          throw err;
        }
      }
    } finally {
      await session.endSession();
    }
  }

  private connect(): Promise<MongoClient> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.config.MONGODB_URL) return Promise.reject(new Error('MongoDB is not configured: set MONGODB_URL'));
    this.connecting ??= (async () => {
      const client = mongo.createMongoClient({ url: this.config.MONGODB_URL!, maxPoolSize: this.config.MONGODB_POOL_MAX });
      try {
        await client.connect();
        await mongo.assertTransactionsSupported(client);
      } catch (err) {
        this.connecting = null;
        await client.close().catch(() => undefined);
        throw err;
      }
      client.on('error', (err) => this.logger.error(`MongoDB client error: ${err.message}`));
      this.client = client;
      return client;
    })();
    return this.connecting;
  }
}

/** How many rows of `table` point at each of `ids` through `field` (the SQL `select count(*) ... group by`). */
export async function countBy(tx: TenantTx | PlatformTx, table: string, field: string, ids: string[], filter: Record<string, unknown> = {}): Promise<Map<string, number>> {
  const rows = await tx.collection(table).aggregate<{ _id: string; n: number }>([{ $match: { ...filter, [field]: { $in: ids } } }, { $group: { _id: '$' + field, n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [r._id, r.n]));
}

/** Any of the three transaction kinds. */
export type AnyTx = TenantTx | UserTx | PlatformTx;

/** The users table as this transaction may see it: a workspace sees only its members, without secrets. */
export async function usersTable(tx: TenantTx | PlatformTx): Promise<Table<Row>> {
  return tx instanceof TenantTx ? tx.users() : tx.collection('users');
}

/** The full name of the login behind each membership (users.full_name), by membership id. */
export async function membershipUserNames(tx: TenantTx | PlatformTx, ids: unknown[]): Promise<Map<string, string | null>> {
  const wanted = [...new Set(ids.filter((x): x is string => typeof x === 'string'))];
  if (!wanted.length) return new Map();
  const ms = await tx.collection('memberships').find({ id: { $in: wanted } }, { projection: { user_id: 1 } });
  const users = new Map((await (await usersTable(tx)).find({ id: { $in: ms.map((m) => m.user_id) } }, { projection: { full_name: 1 } })).map((u) => [u.id as string, (u.full_name as string | null) ?? null]));
  return new Map(ms.map((m) => [m.id as string, users.get(m.user_id) ?? null]));
}

/** A case-insensitive "contains" match for user-typed search text (the SQL `ilike '%q%'`), with the text escaped. */
export function ilike(q: string): { $regex: string; $options: 'i' } {
  return { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
}

/** Matches the whole value without regard to case (PostgreSQL's citext equality). */
export function ieq(q: string): { $regex: string; $options: 'i' } {
  return { $regex: `^${ilike(q).$regex}$`, $options: 'i' };
}
