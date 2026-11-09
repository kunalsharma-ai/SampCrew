import { createHash, randomUUID } from 'node:crypto';
import { MongoServerError, type CreateIndexesOptions, type Db, type Document, type IndexSpecification } from 'mongodb';
import { canonicalJson } from './canonical';
import { MONGO_MIGRATIONS } from './migrations';

export interface MongoIndex {
  key: IndexSpecification;
  options: CreateIndexesOptions & { name: string };
}

export interface MongoCollectionSpec {
  name: string;
  /** A $jsonSchema (or other query) validator. Documents that fail it are rejected on insert and update. */
  validator?: Document;
  indexes?: MongoIndex[];
}

/**
 * A schema step. Collections, validators and indexes are declared as data, so the checksum is the same whether the
 * code runs from TypeScript sources (tsx) or compiled JavaScript, and an edit after release is caught. `up` is for
 * data changes and must be safe to run again: it is not covered by the checksum.
 */
export interface MongoMigration {
  name: string;
  collections?: MongoCollectionSpec[];
  up?: (db: Db) => Promise<void>;
}

export const MIGRATIONS_COLLECTION = '_migrations';
const LOCK_COLLECTION = '_migration_lock';
const LOCK_TTL_MS = 10 * 60_000;

export function migrationChecksum(m: MongoMigration): string {
  return createHash('sha256').update(canonicalJson({ name: m.name, collections: m.collections ?? [] })).digest('hex');
}

/**
 * Applies pending migrations in order under a lock document, so two deploys starting together cannot both run them.
 * Refuses to run when an applied migration was edited afterwards (add a new migration instead).
 */
export async function migrateMongo(
  db: Db,
  log: (m: string) => void = () => {},
  migrations: MongoMigration[] = MONGO_MIGRATIONS,
): Promise<string[]> {
  const names = migrations.map((m) => m.name);
  if (names.some((n, i) => !/^\d{4}_[a-z0-9_]+$/.test(n) || (i > 0 && n <= names[i - 1]!))) {
    throw new Error('MongoDB migrations must be named NNNN_snake_case and listed in ascending order');
  }
  const release = await acquireLock(db);
  try {
    const applied = new Map(
      (await db.collection<{ _id: string; checksum: string }>(MIGRATIONS_COLLECTION).find().toArray()).map((r) => [r._id, r.checksum]),
    );
    const ran: string[] = [];
    for (const m of migrations) {
      const checksum = migrationChecksum(m);
      const prev = applied.get(m.name);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migration ${m.name} was modified after being applied. Add a new migration instead.`);
        continue;
      }
      log(`applying ${m.name}`);
      try {
        for (const c of m.collections ?? []) await applyCollection(db, c);
        await m.up?.(db);
      } catch (err) {
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
      await db.collection<Document>(MIGRATIONS_COLLECTION).insertOne({ _id: m.name as never, checksum, appliedAt: new Date() });
      ran.push(m.name);
    }
    return ran;
  } finally {
    await release();
  }
}

async function applyCollection(db: Db, spec: MongoCollectionSpec): Promise<void> {
  const exists = (await db.listCollections({ name: spec.name }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) {
    await db.createCollection(spec.name, spec.validator ? { validator: spec.validator, validationLevel: 'strict', validationAction: 'error' } : {});
  } else if (spec.validator) {
    await db.command({ collMod: spec.name, validator: spec.validator, validationLevel: 'strict', validationAction: 'error' });
  }
  for (const index of spec.indexes ?? []) {
    await db.collection(spec.name).createIndex(index.key, index.options);
  }
}

async function acquireLock(db: Db): Promise<() => Promise<void>> {
  const locks = db.collection<{ _id: string; holder: string; expiresAt: Date }>(LOCK_COLLECTION);
  const holder = randomUUID();
  const deadline = Date.now() + 60_000;
  for (;;) {
    const now = new Date();
    try {
      // Takes a free or expired lock; a held one makes the upsert collide on _id.
      await locks.updateOne(
        { _id: 'migrate', expiresAt: { $lt: now } },
        { $set: { holder, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) } },
        { upsert: true },
      );
      return async () => {
        await locks.deleteOne({ _id: 'migrate', holder });
      };
    } catch (err) {
      if (!(err instanceof MongoServerError && err.code === 11000)) throw err;
      if (Date.now() > deadline) throw new Error('Another process is applying MongoDB migrations (lock held for over a minute)');
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
