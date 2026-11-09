import { mongo } from '@crew/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MongoService, PlatformTx } from '../../src/platform/database/mongo.service';
import { id, mongoService } from './helpers';

/**
 * The PostgreSQL data rules, carried over to MongoDB by packages/db/src/mongo (engine.ts, table.ts) for every table
 * in schema.generated.ts: defaults, types, NOT NULL, enums, unique keys, foreign keys and ON DELETE rules.
 */
describe('MongoDB data rules carried over from PostgreSQL', () => {
  let db: MongoService;
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (err) {
      return (err as { code?: string }).code ?? (err as Error).message;
    }
  };

  const newTenant = async (tx: PlatformTx, slug = `t-${id().slice(0, 8)}`) => {
    const t = await tx.collection('tenants').insert({ slug, name: `Tenant ${slug}`, contact_email: 'Ops@Example.COM' });
    const le = await tx.collection('legal_entities').insert({ tenant_id: t.id, name: 'Main', country_code: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' });
    return { tenantId: t.id as string, legalEntityId: le.id as string, slug };
  };

  beforeAll(() => {
    db = mongoService();
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it('fills column defaults and converts values the way PostgreSQL stored them', async () => {
    const t = await db.platform(async (tx) => {
      const { tenantId } = await newTenant(tx);
      return tx.collection('tenants').findOne({ id: tenantId });
    });
    expect(t).toMatchObject({ status: 'active', region: 'in', timezone: 'UTC', currency: 'USD', locale: 'en', require_mfa: false, is_demo: false, setup_step: 0 });
    expect(t!.contact_email).toBe('ops@example.com'); // citext: compared case-insensitively
    expect(t!.created_at).toBeInstanceOf(Date);
    expect(t!.id).toMatch(/^[0-9a-f-]{36}$/);

    const plan = await db.platform(async (tx) => {
      const p = await tx.collection('plans').insert({ key: `p_${id().slice(0, 6).replace(/-/g, '')}`, name: 'Test plan' });
      await tx.collection('plan_prices').insert({ plan_id: p.id, currency: 'INR', monthly_per_seat: '149.50', annual_per_seat_month: 120 });
      return tx.collection('plan_prices').findOne({ plan_id: p.id });
    });
    // numeric comes back as a string, exactly as node-postgres returned it.
    expect(plan).toMatchObject({ monthly_per_seat: '149.50', annual_per_seat_month: '120' });
  });

  it('refuses NOT NULL, enum, unknown-column and wrong-type values with the PostgreSQL error codes', async () => {
    const insert = (table: string, row: Record<string, unknown>) => code(db.platform((tx) => tx.collection(table).insert(row)));
    expect(await insert('tenants', { slug: 'no-name' })).toBe('23502');
    expect(await insert('tenants', { slug: `s-${id().slice(0, 6)}`, name: 'x', status: 'gone' })).toBe('23514');
    expect(await insert('tenants', { slug: `s-${id().slice(0, 6)}`, name: 'x', nonsense: 1 })).toBe('22P02');
    expect(await insert('legal_entities', { tenant_id: 'not-a-uuid', name: 'x', country_code: 'IN', currency: 'INR', timezone: 'UTC' })).toBe('22P02');
  });

  it('enforces unique keys, including case-insensitive and partial ones', async () => {
    const slug = `u-${id().slice(0, 8)}`;
    await db.platform((tx) => newTenant(tx, slug));
    expect(await code(db.platform((tx) => newTenant(tx, slug)))).toBe('23505');

    const { tenantId } = await db.platform((tx) => newTenant(tx));
    const depts = <R>(fn: (t: ReturnType<Parameters<Parameters<MongoService['tenant']>[0]>[0]['collection']>) => Promise<R>) =>
      db.tenant((tx) => fn(tx.collection('departments')), { tenantId });
    // A failed write ends its transaction (as in PostgreSQL), so each attempt runs in its own.
    await depts((d) => d.insert({ name: 'Sales' }));
    // departments_name_per_parent: lower(name), only while not archived.
    expect(await code(depts((d) => d.insert({ name: 'SALES' })))).toBe('23505');
    await depts((d) => d.update({ name: 'Sales' }, { $set: { archived_at: new Date() } }));
    await depts((d) => d.insert({ name: 'sales' }));
    // Bringing the archived one back would make two active "sales".
    expect(await code(depts((d) => d.update({ name: 'Sales' }, { $set: { archived_at: null } })))).toBe('23505');
    // The failed update rolled back with its transaction; the archived department is still archived.
    const archived = await db.tenant((tx) => tx.collection('departments').findOne({ name: 'Sales' }), { tenantId });
    expect(archived!.archived_at).toBeInstanceOf(Date);
  });

  it('checks foreign keys within the workspace and applies ON DELETE rules', async () => {
    const a = await db.platform((tx) => newTenant(tx));
    const b = await db.platform((tx) => newTenant(tx));
    // A location in A cannot point at B's legal entity (composite key tenant_id + legal_entity_id).
    expect(await code(db.tenant((tx) => tx.collection('locations').insert({ name: 'Pune', legal_entity_id: b.legalEntityId, timezone: 'Asia/Kolkata', country_code: 'IN' }), { tenantId: a.tenantId }))).toBe('23503');
    await db.tenant((tx) => tx.collection('locations').insert({ name: 'Pune', legal_entity_id: a.legalEntityId, timezone: 'Asia/Kolkata', country_code: 'IN' }), { tenantId: a.tenantId });
    // NO ACTION: a legal entity with locations cannot be deleted.
    expect(await code(db.tenant((tx) => tx.collection('legal_entities').delete({ id: a.legalEntityId }), { tenantId: a.tenantId }))).toBe('23503');

    // CASCADE: deleting a role removes its permissions and assignments.
    const userId = await db.platform(async (tx) => (await tx.collection('users').insert({ email: `${id()}@example.com`, full_name: 'Role Person' })).id as string);
    await db.tenant(async (tx) => {
      const role = await tx.collection('roles').insert({ key: 'auditor', name: 'Auditor' });
      await tx.collection('role_permissions').insert({ role_id: role.id, permission: 'audit:read', scope: 'tenant' });
      const m = await tx.collection('memberships').insert({ user_id: userId, legal_entity_id: a.legalEntityId });
      await tx.collection('role_assignments').insert({ membership_id: m.id, role_id: role.id });
      expect(await tx.collection('roles').delete({ id: role.id })).toBe(1);
      expect(await tx.collection('role_permissions').count({ role_id: role.id })).toBe(0);
      expect(await tx.collection('role_assignments').count({ role_id: role.id })).toBe(0);
    }, { tenantId: a.tenantId });
  });

  it('sets updated_at on update and keeps append-only tables append-only', async () => {
    const { tenantId } = await db.platform((tx) => newTenant(tx));
    const before = await db.platform((tx) => tx.collection('tenants').findOne({ id: tenantId }));
    await new Promise((r) => setTimeout(r, 5));
    await db.tenant((tx) => tx.collection('tenants').update({ id: tenantId }, { $set: { name: 'Renamed' } }), { tenantId });
    const after = await db.platform((tx) => tx.collection('tenants').findOne({ id: tenantId }));
    expect(after!.name).toBe('Renamed');
    expect((after!.updated_at as Date).getTime()).toBeGreaterThan((before!.updated_at as Date).getTime());

    // A workspace may change only its settings columns, not its status or address.
    await expect(db.tenant((tx) => tx.collection('tenants').update({ id: tenantId }, { $set: { status: 'active' } }), { tenantId })).rejects.toThrow(/cannot be changed/);
    await expect(db.tenant((tx) => tx.collection('tenants').update({ id: tenantId }, { $set: { slug: 'taken-over' } }), { tenantId })).rejects.toThrow(/cannot be changed/);
    await expect(db.platform((tx) => tx.collection('leave_ledger').update({}, { $set: { note: 'x' } }))).rejects.toThrow(/not allowed/);
  });

  it('shows a workspace only its members, without password hashes or MFA secrets', async () => {
    const { tenantId, legalEntityId } = await db.platform((tx) => newTenant(tx));
    const [member, stranger] = await db.platform(async (tx) => {
      const m = await tx.collection('users').insert({ email: `${id()}@example.com`, full_name: 'Member', password_hash: 'secret-hash', mfa_secret_enc: 'enc' });
      const s = await tx.collection('users').insert({ email: `${id()}@example.com`, full_name: 'Stranger' });
      await tx.collection('memberships').insert({ tenant_id: tenantId, user_id: m.id, legal_entity_id: legalEntityId });
      return [m, s];
    });
    const seen = await db.tenant(async (tx) => (await tx.users()).find(), { tenantId });
    expect(seen.map((u) => u.id)).toEqual([member!.id]);
    expect(seen[0]).not.toHaveProperty('password_hash');
    expect(seen[0]).not.toHaveProperty('mfa_secret_enc');
    expect(await db.tenant(async (tx) => (await tx.users()).findOne({ id: stranger!.id }), { tenantId })).toBeUndefined();
    await expect(db.tenant(async (tx) => (await tx.users()).find({ password_hash: 'secret-hash' }), { tenantId })).rejects.toThrow(/hidden columns/);
  });

  it('numbers identity columns in order', async () => {
    const database = await db.database();
    const next = async () => (await database.collection(mongo.SEQUENCES).findOneAndUpdate({ _id: 'probe' as never }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' }))!.value;
    const a = await next();
    expect(await next()).toBe(a + 1);
  });
});
