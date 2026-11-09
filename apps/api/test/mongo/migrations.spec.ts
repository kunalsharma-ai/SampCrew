import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { mongo } from '@crew/db';
import type { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('MongoDB migrations', () => {
  let client: MongoClient;
  let scratch: Db;

  beforeAll(async () => {
    client = mongo.createMongoClient({ url: process.env.MONGODB_URL! });
    await client.connect();
    scratch = client.db(`${mongo.databaseName(process.env.MONGODB_URL!)}_migrations`);
    await scratch.dropDatabase();
  });

  afterAll(async () => {
    await scratch.dropDatabase();
    await client.close();
  });

  const step = (name: string, extraIndex = false): mongo.MongoMigration => ({
    name,
    collections: [
      {
        name: 'things',
        validator: { $jsonSchema: { bsonType: 'object', required: ['label'] } },
        indexes: [
          { key: { label: 1 }, options: { name: 'things_label', unique: true } },
          ...(extraIndex ? [{ key: { createdAt: -1 }, options: { name: 'things_time' } }] : []),
        ],
      },
    ],
  });

  it('applies the shipped migrations to the test database once', async () => {
    const db = client.db(mongo.databaseName(process.env.MONGODB_URL!));
    expect(await mongo.migrateMongo(db)).toEqual([]);
    const indexes = (await db.collection('audit_events').indexes()).map((i) => i.name);
    expect(indexes).toContain('audit_events_chain');
  });

  it('applies pending steps in order, skips applied ones and refuses edits', async () => {
    let calls = 0;
    const data: mongo.MongoMigration = { name: '0002_backfill', up: async (db) => { calls += 1; await db.collection('things').insertOne({ label: 'seeded' }); } };
    expect(await mongo.migrateMongo(scratch, () => {}, [step('0001_things'), data])).toEqual(['0001_things', '0002_backfill']);
    expect(await mongo.migrateMongo(scratch, () => {}, [step('0001_things'), data])).toEqual([]);
    expect(calls).toBe(1);
    await expect(scratch.collection('things').insertOne({ nope: true })).rejects.toThrow(/validation/i);
    await expect(mongo.migrateMongo(scratch, () => {}, [step('0001_things', true), data])).rejects.toThrow(/modified after being applied/);
    await expect(mongo.migrateMongo(scratch, () => {}, [data, step('0001_things')])).rejects.toThrow(/ascending order/);
  });

  it('lets only one of two concurrent deploys apply a step', async () => {
    let runs = 0;
    const slow: mongo.MongoMigration = { name: '0003_slow', up: async () => { runs += 1; await new Promise((r) => setTimeout(r, 300)); } };
    const list = [step('0001_things'), { name: '0002_backfill' } as mongo.MongoMigration, slow];
    // 0002 was applied with an `up`; the checksum covers only collections, so listing it without one is fine.
    const [a, b] = await Promise.all([mongo.migrateMongo(scratch, () => {}, list), mongo.migrateMongo(scratch, () => {}, list)]);
    expect([...a, ...b]).toEqual(['0003_slow']);
    expect(runs).toBe(1);
  });

  it('reads the database name from the URL', () => {
    expect(mongo.databaseName('mongodb://localhost:27017/crew_prod?replicaSet=rs0')).toBe('crew_prod');
    expect(mongo.databaseName('mongodb+srv://u:p@cluster0.example.net/?retryWrites=true')).toBe('crew');
  });
});

/**
 * Only the data layer may use the driver directly. Everything else goes through MongoService's scoped handles, the
 * way every query used to go through DatabaseService's RLS transactions. Type-only imports are fine.
 */
describe('MongoDB driver access', () => {
  it('is confined to src/platform/database', () => {
    const root = join(__dirname, '../../src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) {
          const rel = relative(root, path);
          if (rel.startsWith(join('platform', 'database'))) continue;
          const source = readFileSync(path, 'utf8');
          if (/^\s*import\s+(?!type\b)[^;]*from\s+['"]mongodb['"]/m.test(source) || /require\(['"]mongodb['"]\)/.test(source)) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
