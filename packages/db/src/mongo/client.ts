import { MongoClient } from 'mongodb';

export interface MongoSettings {
  /** mongodb:// or mongodb+srv:// URL. The path names the database, e.g. mongodb://localhost:27017/crew?replicaSet=rs0 */
  url: string;
  maxPoolSize?: number;
  appName?: string;
}

/**
 * One client per process. Reads and writes are majority-acknowledged so a committed change survives a primary
 * failover, and `undefined` fields are dropped instead of being stored as null.
 */
export function createMongoClient(settings: MongoSettings): MongoClient {
  return new MongoClient(settings.url, {
    maxPoolSize: settings.maxPoolSize ?? 20,
    appName: settings.appName ?? 'crew-api',
    retryWrites: true,
    readConcern: { level: 'majority' },
    writeConcern: { w: 'majority' },
    ignoreUndefined: true,
  });
}

/** The database named in the URL path, or `fallback` when the URL has none. */
export function databaseName(url: string, fallback = 'crew'): string {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(url);
  const name = match?.[1] ? decodeURIComponent(match[1]) : '';
  return name || fallback;
}

/**
 * SampCrew relies on multi-document transactions (a change and its audit event commit together), which MongoDB only
 * offers on a replica set or a sharded cluster. Fails fast on a standalone server instead of failing on first write.
 */
export async function assertTransactionsSupported(client: MongoClient): Promise<void> {
  const hello = await client.db('admin').command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    throw new Error(
      'MongoDB is running as a standalone server. SampCrew needs a replica set (a single-node one is fine): start mongod with --replSet rs0 and run rs.initiate().',
    );
  }
}
