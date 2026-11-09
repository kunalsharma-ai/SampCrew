import { createMongoClient, databaseName } from '../src/mongo/client';

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing environment variable ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

/** The MongoDB connection the scripts use (migrations, seed, reset), and its database. */
export function connect(appName: string) {
  const url = requireEnv('MONGODB_URL');
  const client = createMongoClient({ url, appName });
  return { client, db: client.db(databaseName(url)), name: databaseName(url) };
}
