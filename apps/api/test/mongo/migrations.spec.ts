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

  it('carries the old leave setup into the rebuilt model, keeping what worked and running only once', async () => {
    const m = mongo.MONGO_MIGRATIONS.find((x) => x.name === '0040_leave_rebuild')!;
    const tenant = 'aaaaaaaa-0000-4000-8000-000000000001';
    const typeId = 'bbbbbbbb-0000-4000-8000-000000000001';
    const hrWs = 'cccccccc-0000-4000-8000-000000000001';
    const dept = 'dddddddd-0000-4000-8000-000000000001';
    await scratch.collection('leave_types').insertOne({ _id: typeId as never, tenant_id: tenant, code: 'CL', name: 'Casual leave', paid: true, allow_half_day: true });
    await scratch.collection('leave_policies').insertMany([
      { _id: 'p1' as never, tenant_id: tenant, leave_type_id: typeId, active: true, accrual_method: 'annual_upfront', annual_entitlement: '8', max_consecutive_days: '3', carry_forward_max: '0' },
      { _id: 'p2' as never, tenant_id: tenant, leave_type_id: typeId, active: true, department_id: dept, accrual_method: 'annual_upfront', annual_entitlement: '10', carry_forward_max: '0' },
      { _id: 'p3' as never, tenant_id: tenant, leave_type_id: typeId, active: false, annual_entitlement: '99' },
    ]);
    await scratch.collection('approval_policies').insertOne({ tenant_id: tenant, resource_type: 'leave_request', steps: [{ type: 'manager' }, { type: 'role', role: 'hr_admin' }] });
    await scratch.collection('hr_workspaces').insertOne({ _id: hrWs as never, tenant_id: tenant, name: 'Pune', status: 'active' });
    await scratch.collection('leave_requests').insertOne({ tenant_id: tenant, leave_type_id: typeId, status: 'approved' });
    await m.up!(scratch);
    await m.up!(scratch);
    const t = (await scratch.collection('leave_types').findOne({ _id: typeId as never }))!;
    expect(t.policy).toMatchObject({ accrualMethod: 'annual_upfront', annualEntitlement: '8', maxDaysPerRequest: '3', maxConsecutiveDays: null });
    expect(t.approval).toMatchObject({ routes: ['hr'], managerFirst: true });
    expect(t).toMatchObject({ version: 1, created_by_level: 'system', category: 'general' });
    expect(await scratch.collection('leave_type_versions').countDocuments({ leave_type_id: typeId })).toBe(1);
    const allocs = await scratch.collection('leave_allocations').find({ leave_type_id: typeId }).toArray();
    const toEmployees = allocs.filter((a) => a.target === 'employees');
    expect(toEmployees.map((a) => [a.criteria.all, a.criteria.departmentIds, a.entitlement_days?.toString() ?? null]).sort()).toEqual([[false, [dept], '10.00'], [true, [], null]]);
    expect(allocs.filter((a) => a.target === 'hr_workspace').map((a) => a.hr_workspace_id).sort()).toEqual([hrWs, null].sort());
    expect((await scratch.collection('leave_requests').findOne({ tenant_id: tenant }))!.document_ids).toEqual([]);
  });

  it('adds the workspace limits to plans on a database whose catalogue does not have them yet', async () => {
    const m = mongo.MONGO_MIGRATIONS.find((x) => x.name === '0130_workspace_limits')!;
    const planId = 'eeeeeeee-0000-4000-8000-000000000001';
    // An existing install: the catalogue sync that adds the new limits runs only after the migrations.
    await scratch.collection('features').insertOne({ key: 'max_employees', name: 'Employees', module: 'Organization', kind: 'limit', unit: 'employees' });
    await scratch.collection('plans').insertOne({ _id: planId as never, key: 'old_plan', name: 'Old plan' });
    await scratch.collection('plan_features').insertOne({ plan_id: planId, feature_key: 'max_employees', limit_value: 50 });
    await m.up!(scratch);
    await m.up!(scratch);
    expect((await scratch.collection('features').find({ key: { $in: ['max_hr_workspaces', 'max_employee_workspaces'] } }).toArray()).map((f) => f.kind)).toEqual(['limit', 'limit']);
    const rows = await scratch.collection('plan_features').find({ plan_id: planId }).toArray();
    const limit = (k: string) => rows.filter((r) => r.feature_key === k).map((r) => r.limit_value);
    expect(limit('max_employee_workspaces')).toEqual([50]);
    expect(limit('max_hr_workspaces')).toHaveLength(1);
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
