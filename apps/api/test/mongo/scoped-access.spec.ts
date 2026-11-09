import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScopeViolationError } from '../../src/platform/database/mongo-scope';
import type { MongoService } from '../../src/platform/database/mongo.service';
import { id, mongoService } from './helpers';

/**
 * Workspace isolation without row-level security: what PostgreSQL RLS guaranteed (tenant-isolation.spec.ts), the
 * scoped MongoDB handles must guarantee too, and fail loudly rather than quietly when code asks for too much.
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
      await tx.database.collection('t_plans').insertMany([{ _id: 'growth', name: 'Growth' }, { _id: 'scale', name: 'Scale' }] as never, { session: tx.session });
      await tx.database.collection('t_secrets').insertOne({ _id: 'k1', value: 'platform only' } as never, { session: tx.session });
    });
    await db.tenant(async (tx) => {
      await tx.collection('t_items').insertMany([
        { _id: 'a1', name: 'A one', planKey: 'growth', tagId: 'ta1' },
        { _id: 'a2', name: 'A two', planKey: 'scale', tagId: 'tb1' },
      ]);
      await tx.collection('t_tags').insertOne({ _id: 'ta1', label: 'A tag' });
      await tx.collection('t_memberships').insertOne({ _id: id(), user_id: userA, role: 'owner' });
    }, { tenantId: tenantA });
    await db.tenant(async (tx) => {
      await tx.collection('t_items').insertOne({ _id: 'b1', name: 'B one', planKey: 'growth', tagId: 'ta1' });
      // Same _id space, different workspace: B's tag uses the id A's item points at, to prove lookups do not cross.
      await tx.collection('t_tags').insertOne({ _id: 'tb1', label: 'B tag' });
      await tx.collection('t_memberships').insertMany([
        { _id: id(), user_id: userA, role: 'member' },
        { _id: id(), user_id: userB, role: 'owner' },
      ]);
    }, { tenantId: tenantB });
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it('stamps inserts with the workspace and only reads that workspace', async () => {
    const a = await db.tenant((tx) => tx.collection('t_items').find().sort({ _id: 1 }).toArray(), { tenantId: tenantA });
    expect(a.map((d) => d._id)).toEqual(['a1', 'a2']);
    expect(a.every((d) => d.tenant_id === tenantA)).toBe(true);
    const b = await db.tenant(async (tx) => ({
      one: await tx.collection('t_items').findOne({ _id: 'a1' }),
      count: await tx.collection('t_items').countDocuments(),
      plans: await tx.collection('t_items').distinct('planKey'),
    }), { tenantId: tenantB });
    expect(b).toEqual({ one: null, count: 1, plans: ['growth'] });
  });

  it('refuses a filter, document or update that names another workspace', async () => {
    await db.tenant(async (tx) => {
      const items = tx.collection('t_items');
      expect(() => items.find({ tenant_id: tenantA })).toThrow(ScopeViolationError);
      expect(() => items.insertOne({ _id: 'x', tenant_id: tenantA })).toThrow(ScopeViolationError);
      expect(() => items.updateOne({ _id: 'b1' }, { $set: { tenant_id: tenantA } })).toThrow(ScopeViolationError);
      expect(() => items.updateOne({ _id: 'b1' }, { $rename: { name: 'tenant_id' } })).toThrow(ScopeViolationError);
      expect(() => items.updateOne({ _id: 'b1' }, { $unset: { tenant_id: '' } })).toThrow(ScopeViolationError);
      expect(() => items.updateOne({ _id: 'b1' }, [{ $set: { tenant_id: tenantA } }])).toThrow(ScopeViolationError);
      expect(() => items.updateOne({ _id: 'b1' }, [{ $replaceWith: { _id: 'b1' } }])).toThrow(ScopeViolationError);
      expect(() => items.updateOne({ _id: 'b1' }, { name: 'whole doc' } as never)).toThrow(ScopeViolationError);
      expect(() => items.replaceOne({ _id: 'b1' }, { name: 'x', tenant_id: tenantA })).toThrow(ScopeViolationError);
    }, { tenantId: tenantB });
  });

  it('updates and deletes only touch the current workspace', async () => {
    await db.tenant(async (tx) => {
      const r = await tx.collection('t_items').updateMany({}, { $set: { touched: true } });
      expect(r.matchedCount).toBe(1);
      const d = await tx.collection('t_items').deleteMany({ _id: { $in: ['a1', 'a2'] } });
      expect(d.deletedCount).toBe(0);
      // An upsert in B creates B's document, never A's.
      await tx.collection('t_items').updateOne({ _id: 'b2' }, { $set: { name: 'B two' } }, { upsert: true });
      await tx.collection('t_items').replaceOne({ _id: 'b2' }, { name: 'B two, replaced' });
    }, { tenantId: tenantB });
    const all = await db.platform((tx) => tx.database.collection<{ _id: string; [k: string]: unknown }>('t_items').find({ tenant_id: { $in: [tenantA, tenantB] } }, { session: tx.session }).sort({ _id: 1 }).toArray());
    expect(all.map((d) => [d._id, d.tenant_id, d.touched ?? false])).toEqual([
      ['a1', tenantA, false],
      ['a2', tenantA, false],
      ['b1', tenantB, true],
      ['b2', tenantB, false],
    ]);
    expect(all.find((d) => d._id === 'b2')?.name).toBe('B two, replaced');
  });

  it('keeps $lookup, $facet and $graphLookup inside the workspace', async () => {
    const rows = await db.tenant((tx) =>
      tx.collection('t_items').aggregate([
        { $sort: { _id: 1 } },
        { $lookup: { from: 't_tags', localField: 'tagId', foreignField: '_id', as: 'tag' } },
        { $lookup: { from: 't_plans', localField: 'planKey', foreignField: '_id', as: 'plan' } },
        { $project: { _id: 1, tags: '$tag.label', plan: { $first: '$plan.name' } } },
      ]).toArray(), { tenantId: tenantA });
    // a2 points at tb1, which exists only in workspace B: it must not be joined.
    expect(rows).toEqual([
      { _id: 'a1', tags: ['A tag'], plan: 'Growth' },
      { _id: 'a2', tags: [], plan: 'Scale' },
    ]);

    const facet = await db.tenant((tx) =>
      tx.collection('t_items').aggregate([
        { $facet: { joined: [{ $lookup: { from: 't_tags', pipeline: [{ $project: { label: 1 } }], as: 'every' } }, { $limit: 1 }] } },
      ]).toArray(), { tenantId: tenantA });
    expect(facet[0]!.joined[0].every.map((t: { label: string }) => t.label)).toEqual(['A tag']);

    await db.tenant(async (tx) => {
      await tx.collection('t_nodes').insertMany([{ _id: 'n1', parent: null }, { _id: 'n2', parent: 'n1' }]);
    }, { tenantId: tenantA });
    await db.tenant(async (tx) => {
      await tx.collection('t_nodes').insertOne({ _id: 'n3', parent: 'n2' });
    }, { tenantId: tenantB });
    const tree = await db.tenant((tx) =>
      tx.collection('t_nodes').aggregate([
        { $match: { _id: 'n1' } },
        { $graphLookup: { from: 't_nodes', startWith: '$_id', connectFromField: '_id', connectToField: 'parent', as: 'below' } },
      ]).toArray(), { tenantId: tenantA });
    expect(tree[0]!.below.map((n: { _id: string }) => n._id)).toEqual(['n2']);
  });

  it('refuses pipelines that write elsewhere or read outside the workspace', async () => {
    await db.tenant(async (tx) => {
      const items = tx.collection('t_items');
      expect(() => items.aggregate([{ $out: 'stolen' }])).toThrow(ScopeViolationError);
      expect(() => items.aggregate([{ $merge: { into: 't_items' } }])).toThrow(ScopeViolationError);
      expect(() => items.aggregate([{ $lookup: { from: 't_secrets', pipeline: [], as: 's' } }])).toThrow(/platform-only/);
      expect(() => items.aggregate([{ $lookup: { from: 'not_registered', pipeline: [], as: 's' } }])).toThrow(/not registered/);
      // Not allowed inside a MongoDB transaction at all; refused here with a clear message instead.
      expect(() => items.aggregate([{ $unionWith: 't_tags' }])).toThrow(/\$unionWith is not allowed/);
      expect(() => items.aggregate([{ $documents: [{ x: 1 }] }])).toThrow(ScopeViolationError);
      expect(() => items.aggregate([{ $match: {}, $limit: 1 }])).toThrow(/exactly one operator/);
    }, { tenantId: tenantA });
  });

  it('gives shared reference data read-only and keeps platform and unregistered collections out', async () => {
    await db.tenant(async (tx) => {
      expect(await tx.shared('t_plans').countDocuments()).toBe(2);
      expect(() => tx.collection('t_plans')).toThrow(/shared reference data/);
      expect(() => tx.collection('t_secrets')).toThrow(/platform-only/);
      expect(() => tx.collection('anything_else')).toThrow(/not registered/);
      expect(() => tx.shared('t_items')).toThrow(/not shared/);
      // The audit trail is the workspace's to read, never to write.
      await expect(tx.collection('audit_events').find().toArray()).resolves.toEqual([]);
      expect(() => tx.collection('audit_events').insertOne({ _id: 'fake' })).toThrow(/read-only/);
      expect(() => tx.collection('audit_events').deleteMany({})).toThrow(/read-only/);
    }, { tenantId: tenantA });
  });

  it('lets a user, before choosing a workspace, read only their own memberships', async () => {
    const mine = await db.user(userA, (tx) => tx.collection('t_memberships').find().toArray());
    expect(mine.map((m) => [m.tenant_id, m.role]).sort()).toEqual([[tenantA, 'owner'], [tenantB, 'member']].sort());
    await db.user(userA, async (tx) => {
      expect(await tx.collection('t_memberships').findOne({ user_id: userA, tenant_id: tenantB })).not.toBeNull();
      expect(() => tx.collection('t_memberships').find({ user_id: userB })).toThrow(ScopeViolationError);
      expect(() => tx.collection('t_memberships').insertOne({ _id: 'x', role: 'owner' })).toThrow(/read-only/);
      expect(() => tx.collection('t_items')).toThrow(/before a workspace is chosen/);
    });
  });

  it('needs a workspace in context for tenant()', () => {
    expect(() => db.tenant(async () => 1)).toThrow(/without a tenant/);
  });
});
