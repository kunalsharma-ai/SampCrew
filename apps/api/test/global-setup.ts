import { Client } from 'pg';
import { migrate, syncCatalogue } from '@crew/db';
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
}
