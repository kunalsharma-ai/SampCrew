import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client, Pool, PoolClient } from 'pg';

export const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Applies pending migrations in order, each in its own transaction, under an advisory lock so
 * concurrent deploys cannot race. Refuses to run if an applied migration was edited afterwards.
 */
export async function migrate(db: Pool | Client | PoolClient, log: (m: string) => void = () => {}): Promise<string[]> {
  await db.query(`create table if not exists schema_migrations (
    name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  await db.query('select pg_advisory_lock(727274)');
  try {
    const applied = new Map<string, string>(
      (await db.query<{ name: string; checksum: string }>('select name, checksum from schema_migrations')).rows.map((r) => [r.name, r.checksum]),
    );
    const ran: string[] = [];
    for (const m of readMigrations()) {
      const prev = applied.get(m.name);
      if (prev) {
        if (prev !== m.checksum) throw new Error(`Migration ${m.name} was modified after being applied. Add a new migration instead.`);
        continue;
      }
      log(`applying ${m.name}`);
      await db.query('begin');
      try {
        await db.query(m.sql);
        await db.query('insert into schema_migrations (name, checksum) values ($1, $2)', [m.name, m.checksum]);
        await db.query('commit');
      } catch (err) {
        await db.query('rollback');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
      ran.push(m.name);
    }
    return ran;
  } finally {
    await db.query('select pg_advisory_unlock(727274)');
  }
}
