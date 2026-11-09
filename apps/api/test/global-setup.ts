import { Client } from 'pg';
import { migrate, mongo, syncCatalogue } from '@crew/db';
import { applyTestEnv } from './env';

/** Recreates the test database, applies migrations and syncs the plan catalogue once per test run. */
export default async function setup() {
  applyTestEnv();
  const adminUrl = process.env.DATABASE_ADMIN_URL!;
  const server = new URL(adminUrl);
  const dbName = server.pathname.slice(1);
  if (!/test/.test(dbName)) throw new Error(`Refusing to recreate non-test database ${dbName}`);
  server.pathname = '/postgres';
  const root = new Client({ connectionString: server.toString() });
  await root.connect();
  await root.query(`drop database if exists ${dbName} with (force)`);
  await root.query(`create database ${dbName}`);
  await root.end();

  const db = new Client({ connectionString: adminUrl });
  await db.connect();
  await migrate(db);
  await db.query(`alter role crew_api with password ${db.escapeLiteral(process.env.DATABASE_API_PASSWORD!)}`);
  await syncCatalogue(db as never);
  await db.end();

  // MongoDB: drop the test database, create collections, validators and indexes, and sync the plan catalogue.
  const url = process.env.MONGODB_URL!;
  const name = mongo.databaseName(url);
  if (!/test/.test(name)) throw new Error(`Refusing to drop non-test database ${name}`);
  const client = mongo.createMongoClient({ url, appName: 'crew-test-setup' });
  await client.connect();
  try {
    await client.db(name).dropDatabase();
    await mongo.migrateMongo(client.db(name));
    const session = client.startSession();
    try {
      await session.withTransaction(() => mongo.syncCatalogueMongo({ collection: (t) => new mongo.Table(client.db(name), t, session, { scope: null }) }));
    } finally {
      await session.endSession();
    }
  } finally {
    await client.close();
  }
}
