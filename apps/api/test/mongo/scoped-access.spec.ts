import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScopeViolationError } from '../../src/platform/database/mongo-scope';
import type { MongoService } from '../../src/platform/database/mongo.service';
import { id, mongoService } from './helpers';

/**
 * Workspace isolation without row-level security: what PostgreSQL RLS guaranteed (tenant-isolation.spec.ts), the
 * scoped MongoDB tables must guarantee too, and fail loudly rather than quietly when code asks for too much.
 */
describe('MongoDB workspace-scoped access', () => {
  let db: MongoService;
  const tenantA = id();
  const tenantB = id();
  const userA = id();
  const userB = id();

  beforeAll(async () => {
    db = mongoService();
    await db.platform(async (tx) => {
      await tx.collection('t_plans').insertMany([{ id: 'growth', name: 'Growth' }, { id: 'scale', name: 'Scale' }]);
      await tx.collection('t_secrets').insert({ id: 'k1', value: 'platform only' });
    });
    await db.tenant(async (tx) => {
      await tx.collection('t_items').insertMany([
        { id: 'a1', name: 'A one', plan_key: 'growth', tag_id: 'ta1' },
        { id: 'a2', name: 'A two', plan_key: 'scale', tag_id: 'tb1' },
      ]);
      await tx.collection('t_tags').insert({ id: 'ta1', label: 'A tag' });
      await tx.collection('t_memberships').insert({ id: id(), user_id: userA, role: 'owner' });
    }, { tenantId: tenantA });
    await db.tenant(async (tx) => {
      await tx.collection('t_items').insert({ id: 'b1', name: 'B one', plan_key: 'growth', tag_id: 'ta1' });
      // B's tag uses the id A's item points at, to prove lookups do not cross workspaces.
      await tx.collection('t_tags').insert({ id: 'tb1', label: 'B tag' });
      await tx.collection('t_memberships').insertMany([
        { id: id(), user_id: userA, role: 'member' },
        { id: id(), user_id: userB, role: 'owner' },
      ]);
    }, { tenantId: tenantB });
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it('stamps inserts with the workspace and only reads that workspace', async () => {
    const a = await db.tenant((tx) => tx.collection('t_items').find({}, { sort: { id: 1 } }), { tenantId: tenantA });
    expect(a.map((d) => d.id)).toEqual(['a1', 'a2']);
    expect(a.every((d) => d.tenant_id === tenantA)).toBe(true);
    const b = await db.tenant(async (tx) => ({
      one: await tx.collection('t_items').findOne({ id: 'a1' }),
      count: await tx.collection('t_items').count(),
      plans: await tx.collection('t_items').distinct('plan_key'),
    }), { tenantId: tenantB });
    expect(b).toEqual({ one: undefined, count: 1, plans: ['growth'] });
  });

  it('refuses a filter, row or update that names another workspace', async () => {
    await db.tenant(async (tx) => {
      const items = tx.collection('t_items');
      await expect(items.find({ tenant_id: tenantA })).rejects.toThrow(ScopeViolationError);
      await expect(items.insert({ id: 'x', tenant_id: tenantA })).rejects.toThrow(ScopeViolationError);
      await expect(items.update({ id: 'b1' }, { $set: { tenant_id: tenantA } })).rejects.toThrow(ScopeViolationError);
      await expect(items.update({ id: 'b1' }, { $rename: { name: 'tenant_id' } })).rejects.toThrow(ScopeViolationError);
      await expect(items.update({ id: 'b1' }, { $unset: { tenant_id: '' } })).rejects.toThrow(ScopeViolationError);
      await expect(items.update({ id: 'b1' }, { name: 'whole doc' })).rejects.toThrow(/operators/);
    }, { tenantId: tenantB });
  });

  it('updates and deletes only touch the current workspace', async () => {
    await db.tenant(async (tx) => {
      expect(await tx.collection('t_items').update({}, { $set: { touched: true } })).toBe(1);
      expect(await tx.collection('t_items').delete({ id: { $in: ['a1', 'a2'] } })).toBe(0);
      await tx.collection('t_items').upsert({ id: 'b2' }, { id: 'b2', name: 'B two' });
      await tx.collection('t_items').upsert({ id: 'b2' }, { id: 'b2' }, { $set: { name: 'B two, updated' } });
    }, { tenantId: tenantB });
    const all = await db.platform((tx) => tx.collection('t_items').find({ tenant_id: { $in: [tenantA, tenantB] } }, { sort: { id: 1 } }));
    expect(all.map((d) => [d.id, d.tenant_id, d.touched ?? false])).toEqual([
      ['a1', tenantA, false],
      ['a2', tenantA, false],
      ['b1', tenantB, true],
      ['b2', tenantB, false],
    ]);
    expect(all.find((d) => d.id === 'b2')?.name).toBe('B two, updated');
  });

  it('keeps $lookup, $facet and $graphLookup inside the workspace', async () => {
    const rows = await db.tenant((tx) =>
      tx.collection('t_items').aggregate([
        { $sort: { _id: 1 } },
        { $lookup: { from: 't_tags', localField: 'tag_id', foreignField: '_id', as: 'tag' } },
        { $lookup: { from: 't_plans', localField: 'plan_key', foreignField: '_id', as: 'plan' } },
        { $project: { _id: 1, tags: '$tag.label', plan: { $first: '$plan.name' } } },
      ]), { tenantId: tenantA });
    // a2 points at tb1, which exists only in workspace B: it must not be joined.
    expect(rows).toEqual([
      { id: 'a1', tags: ['A tag'], plan: 'Growth' },
      { id: 'a2', tags: [], plan: 'Scale' },
    ]);

    const facet = await db.tenant((tx) =>
      tx.collection('t_items').aggregate([
        { $facet: { joined: [{ $lookup: { from: 't_tags', pipeline: [{ $project: { label: 1 } }], as: 'every' } }, { $limit: 1 }] } },
      ]), { tenantId: tenantA });
    expect(facet[0]!.joined[0].every.map((t: { label: string }) => t.label)).toEqual(['A tag']);

    await db.tenant((tx) => tx.collection('t_nodes').insertMany([{ id: 'n1', parent: null }, { id: 'n2', parent: 'n1' }]), { tenantId: tenantA });
    await db.tenant((tx) => tx.collection('t_nodes').insert({ id: 'n3', parent: 'n2' }), { tenantId: tenantB });
    const tree = await db.tenant((tx) =>
      tx.collection('t_nodes').aggregate([
        { $match: { _id: 'n1' } },
        { $graphLookup: { from: 't_nodes', startWith: '$_id', connectFromField: '_id', connectToField: 'parent', as: 'below' } },
      ]), { tenantId: tenantA });
    expect(tree[0]!.below.map((n: { id: string }) => n.id)).toEqual(['n2']);
  });

  it('refuses pipelines that write elsewhere or read outside the workspace', async () => {
    await db.tenant(async (tx) => {
      const items = tx.collection('t_items');
      await expect(items.aggregate([{ $out: 'stolen' }])).rejects.toThrow(ScopeViolationError);
      await expect(items.aggregate([{ $merge: { into: 't_items' } }])).rejects.toThrow(ScopeViolationError);
      await expect(items.aggregate([{ $lookup: { from: 't_secrets', pipeline: [], as: 's' } }])).rejects.toThrow(/not reachable/);
      await expect(items.aggregate([{ $lookup: { from: 'not_registered', pipeline: [], as: 's' } }])).rejects.toThrow(/Unknown collection/);
      // Not allowed inside a MongoDB transaction at all; refused here with a clear message instead.
      await expect(items.aggregate([{ $unionWith: 't_tags' }])).rejects.toThrow(/\$unionWith is not allowed/);
      await expect(items.aggregate([{ $documents: [{ x: 1 }] }])).rejects.toThrow(ScopeViolationError);
      await expect(items.aggregate([{ $match: {}, $limit: 1 }])).rejects.toThrow(/exactly one operator/);
    }, { tenantId: tenantA });
  });

  it('gives shared reference data read-only and keeps platform and unregistered tables out', async () => {
    await db.tenant(async (tx) => {
      expect(await tx.collection('t_plans').count()).toBe(2);
      await expect(tx.collection('t_plans').insert({ id: 'x' })).rejects.toThrow(/insert is not allowed/);
      expect(() => tx.collection('t_secrets')).toThrow(/not reachable/);
      expect(() => tx.collection('anything_else')).toThrow(/Unknown collection/);
      expect(() => tx.collection('sessions')).toThrow(/not reachable/);
      // The audit trail is the workspace's to read, never to write.
      await expect(tx.collection('audit_events').find()).resolves.toEqual([]);
      await expect(tx.collection('audit_events').insert({ chain_seq: 1 })).rejects.toThrow(/not allowed/);
      await expect(tx.collection('audit_events').delete({})).rejects.toThrow(/not allowed/);
    }, { tenantId: tenantA });
  });

  it('lets a user, before choosing a workspace, read only their own memberships', async () => {
    const mine = await db.user(userA, (tx) => tx.collection('t_memberships').find());
    expect(mine.map((m) => [m.tenant_id, m.role]).sort()).toEqual([[tenantA, 'owner'], [tenantB, 'member']].sort());
    await db.user(userA, async (tx) => {
      expect(await tx.collection('t_memberships').findOne({ user_id: userA, tenant_id: tenantB })).toBeDefined();
      await expect(tx.collection('t_memberships').find({ user_id: userB })).rejects.toThrow(ScopeViolationError);
      await expect(tx.collection('t_memberships').insert({ id: 'x', role: 'owner' })).rejects.toThrow(/not allowed/);
      expect(() => tx.collection('t_items')).toThrow(/before a workspace is chosen/);
    });
  });

  it('needs a workspace in context for tenant()', () => {
    expect(() => db.tenant(async () => 1)).toThrow(/without a tenant/);
  });
});
