import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { ClientSession, Db, Document, MongoClient, TransactionOptions } from 'mongodb';
import { mongo } from '@crew/db';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { requestContext } from '../context/request-context';
import { ScopedCollection, ScopeViolationError, scopeFilter, type MongoDoc, type Scope } from './mongo-scope';

const TRANSACTION: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

/** Work queued to run inside the transaction just before it commits (the audit trail), in the order it was asked. */
abstract class BaseTx {
  private readonly jobs: Array<() => Promise<unknown>> = [];

  constructor(readonly session: ClientSession, protected readonly db: Db) {}

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

/** A transaction confined to one workspace. Everything it reads or writes carries that workspace's tenantId. */
export class TenantTx extends BaseTx {
  private readonly scope: Scope;

  constructor(session: ClientSession, db: Db, readonly tenantId: string, readonly userId: string | null, private readonly rules: Record<string, mongo.CollectionRule>) {
    super(session, db);
    this.scope = { kind: 'tenant', id: tenantId, rules };
  }

  /** Appends to this workspace's audit chain; an event for any other workspace is refused. */
  override audit(input: Omit<mongo.AuditEventInput, 'tenantId'> & { tenantId?: string | null }): void {
    if (input.tenantId !== undefined && input.tenantId !== this.tenantId) {
      throw new ScopeViolationError('Audit events from a workspace transaction must belong to that workspace');
    }
    super.audit({ ...input, tenantId: this.tenantId });
  }

  /** A workspace-owned collection, narrowed to this workspace. Shared reference data comes back read-only. */
  collection<T extends Document = MongoDoc>(name: string): ScopedCollection<T> {
    const restriction = scopeFilter(name, this.scope);
    if (!restriction) throw new ScopeViolationError(`${name} is shared reference data: use shared('${name}')`);
    const writable = mongo.collectionRule(name, this.rules)!.tenantWritable !== false;
    return new ScopedCollection<T>(this.db.collection<T>(name), restriction, this.scope, this.session, writable);
  }

  /** Shared reference data (no owner workspace), read-only. */
  shared<T extends Document = MongoDoc>(name: string) {
    return sharedCollection<T>(this.db, name, this.rules, this.session);
  }
}

/** Before a workspace is chosen: only the signed-in user's own documents (e.g. their memberships). */
export class UserTx extends BaseTx {
  private readonly scope: Scope;

  constructor(session: ClientSession, db: Db, readonly userId: string, private readonly rules: Record<string, mongo.CollectionRule>) {
    super(session, db);
    this.scope = { kind: 'user', id: userId, rules };
  }

  collection<T extends Document = MongoDoc>(name: string): ScopedCollection<T> {
    const restriction = scopeFilter(name, this.scope);
    if (!restriction) throw new ScopeViolationError(`${name} is shared reference data: use shared('${name}')`);
    return new ScopedCollection<T>(this.db.collection<T>(name), restriction, this.scope, this.session, false);
  }

  shared<T extends Document = MongoDoc>(name: string) {
    return sharedCollection<T>(this.db, name, this.rules, this.session);
  }
}

/**
 * Unrestricted access, for authentication bootstrap and the SAMPLEDGE Super Admin Console only. Call sites are few
 * and reviewed, as with crew_platform on PostgreSQL. Pass `session` to every operation.
 */
export class PlatformTx extends BaseTx {
  get database(): Db {
    return this.db;
  }
}

function sharedCollection<T extends Document>(db: Db, name: string, rules: Record<string, mongo.CollectionRule>, session: ClientSession) {
  const rule = mongo.collectionRule(name, rules);
  if (rule?.scope !== 'shared') throw new ScopeViolationError(`${name} is not shared reference data`);
  const coll = db.collection<T>(name);
  return {
    find: (filter: Document = {}, options: Document = {}) => coll.find(filter as never, { ...options, session }),
    findOne: (filter: Document = {}, options: Document = {}) => coll.findOne(filter as never, { ...options, session }),
    countDocuments: (filter: Document = {}) => coll.countDocuments(filter as never, { session }),
  };
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
  rules: Record<string, mongo.CollectionRule> = mongo.COLLECTION_RULES;

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
    return this.run((session, db) => new TenantTx(session, db, tenantId, userId ?? null, this.rules), fn);
  }

  user<T>(userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T> {
    if (!userId) throw new Error('user() called without a user');
    return this.run((session, db) => new UserTx(session, db, userId, this.rules), fn);
  }

  platform<T>(fn: (tx: PlatformTx) => Promise<T>): Promise<T> {
    return this.run((session, db) => new PlatformTx(session, db), fn);
  }

  private async run<X extends BaseTx, T>(make: (session: ClientSession, db: Db) => X, fn: (tx: X) => Promise<T>): Promise<T> {
    const client = await this.connect();
    const db = client.db(this.dbName!);
    const session = client.startSession({ causalConsistency: true });
    try {
      let result!: T;
      await session.withTransaction(async () => {
        // A fresh handle per attempt, so work deferred by an aborted attempt is not replayed.
        const tx = make(session, db);
        result = await fn(tx);
        await tx.flush();
      }, TRANSACTION);
      return result;
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
