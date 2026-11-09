import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { ClientSession, Db, MongoClient, TransactionOptions } from 'mongodb';
import { mongo } from '@crew/db';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { requestContext } from '../context/request-context';
import { ScopeViolationError, type Scope, type Table } from './mongo-scope';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const MAX_ATTEMPTS = 8;

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
  collection<T extends Row = Row>(name: string): Table<T> {
    return new mongo.Table<T>(this.db, name, this.session, { scope: this.scope, tables: this.tables, readOnly: name === mongo.AUDIT_EVENTS });
  }

  /** People who are members of this workspace (invited, active or suspended), without password hashes or MFA secrets. */
  async users(): Promise<Table<Row>> {
    const ids = await this.db.collection('memberships').distinct('user_id', { tenant_id: this.tenantId }, { session: this.session });
    return new mongo.Table(this.db, 'users', this.session, { scope: null, tables: this.tables, readOnly: true, workspaceColumns: true, within: { _id: { $in: ids } } });
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
          if (attempt < MAX_ATTEMPTS && hasLabel(err, 'TransientTransactionError')) {
            await new Promise((r) => setTimeout(r, Math.min(5 * 2 ** attempt, 200) * Math.random()));
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
