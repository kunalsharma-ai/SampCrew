import { mongo } from '@crew/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MongoService } from '../../src/platform/database/mongo.service';
import { id, mongoService } from './helpers';

describe('MongoDB catalogue sync and workspace provisioning', () => {
  let db: MongoService;

  beforeAll(async () => {
    db = mongoService();
    await db.platform((tx) => mongo.syncCatalogueMongo(tx));
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it('syncs the feature catalogue and plans, and is safe to run again', async () => {
    const before = await db.platform(async (tx) => ({
      features: await tx.collection('features').count(),
      plans: await tx.collection('plans').count(),
      planFeatures: await tx.collection('plan_features').count(),
    }));
    expect(before.features).toBeGreaterThan(10);
    expect(before.plans).toBeGreaterThan(1);
    await db.platform((tx) => mongo.syncCatalogueMongo(tx));
    const after = await db.platform(async (tx) => ({
      features: await tx.collection('features').count(),
      plans: await tx.collection('plans').count(),
      planFeatures: await tx.collection('plan_features').count(),
    }));
    expect(after).toEqual(before);
  });

  it('keeps a plan changed in the Console', async () => {
    const plan = await db.platform((tx) => tx.collection('plans').findOne({ key: 'business' }));
    await db.platform((tx) => tx.collection('plans').update({ id: plan!.id }, { $set: { name: 'Custom business', customised_at: new Date() } }));
    await db.platform((tx) => mongo.syncCatalogueMongo(tx));
    expect((await db.platform((tx) => tx.collection('plans').findOne({ id: plan!.id })))!.name).toBe('Custom business');
    await db.platform((tx) => tx.collection('plans').update({ id: plan!.id }, { $set: { name: plan!.name, customised_at: null } }));
  });

  it('provisions a workspace with its owner, roles, subscription and starting data', async () => {
    const slug = `p-${id().slice(0, 8)}`;
    const input = {
      name: 'Provisioned Ltd',
      slug,
      countryCode: 'IN',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      owner: { email: `owner@${slug}.test`, fullName: 'Owner Person', passwordHash: 'hash' },
      plan: { key: 'business', seats: 25, billingCycle: 'monthly' as const, trialDays: 14 },
    };
    const t = await db.platform((tx) => mongo.provisionTenantMongo(tx, input));
    expect(t.existingUser).toBe(false);

    const seen = await db.tenant(
      async (tx) => ({
        tenant: await tx.collection('tenants').findOne({}),
        roles: await tx.collection('roles').count(),
        ownerRoles: await tx.collection('role_assignments').count({ membership_id: t.ownerMembershipId }),
        subscription: await tx.collection('subscriptions').findOne({}),
        stages: await tx.collection('recruitment_stages').find({}, { sort: { position: 1 } }),
        lines: await tx.collection('salary_structure_lines').count(),
        categories: await tx.collection('helpdesk_categories').count(),
        policy: await tx.collection('attendance_policies').findOne({}),
      }),
      { tenantId: t.tenantId },
    );
    expect(seen.tenant).toMatchObject({ slug, region: 'in', is_demo: false });
    expect(seen.roles).toBeGreaterThan(3);
    expect(seen.ownerRoles).toBe(2);
    expect(seen.subscription).toMatchObject({ status: 'trialing', seats: 25, currency: 'INR' });
    expect(seen.subscription!.trial_ends_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(seen.stages.map((s) => s.kind)).toEqual(['new', 'screen', 'interview', 'offer', 'hired']);
    expect(seen.lines).toBe(3);
    expect(seen.categories).toBe(5);
    expect(seen.policy!.default_shift_id).toBeTruthy();

    // The same owner joining a second workspace keeps one identity; the same address is refused.
    const second = await db.platform((tx) => mongo.provisionTenantMongo(tx, { ...input, slug: `${slug}-2` }));
    expect(second).toMatchObject({ existingUser: true, ownerUserId: t.ownerUserId });
    await expect(db.platform((tx) => mongo.provisionTenantMongo(tx, input))).rejects.toBeInstanceOf(mongo.SlugTakenError);
  });
});
