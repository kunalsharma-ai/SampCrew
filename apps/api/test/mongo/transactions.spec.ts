import { mongo } from '@crew/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MongoService } from '../../src/platform/database/mongo.service';
import { auditInput, id, mongoService } from './helpers';

describe('MongoDB transactions, concurrency and the audit chain', () => {
  let db: MongoService;

  beforeAll(() => {
    db = mongoService();
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it('rolls the whole transaction back when it fails, deferred work included', async () => {
    const tenantId = id();
    await expect(
      db.tenant(async (tx) => {
        await tx.collection('t_items').insertOne({ _id: 'lost', name: 'never committed' });
        tx.audit(auditInput({ action: 'item.created' }));
        throw new Error('boom');
      }, { tenantId }),
    ).rejects.toThrow('boom');
    await expect(
      db.tenant(async (tx) => {
        await tx.collection('t_items').insertOne({ _id: 'lost2' });
        tx.defer(async () => {
          throw new Error('late failure');
        });
      }, { tenantId }),
    ).rejects.toThrow('late failure');
    const left = await db.tenant(async (tx) => ({
      items: await tx.collection('t_items').countDocuments(),
      audit: await tx.collection('audit_events').countDocuments(),
    }), { tenantId });
    expect(left).toEqual({ items: 0, audit: 0 });
  });

  it('runs deferred work last, inside the transaction, in the order it was asked', async () => {
    const tenantId = id();
    const order: string[] = [];
    await db.tenant(async (tx) => {
      tx.defer(async () => order.push('first deferred'));
      tx.defer(async () => order.push('second deferred'));
      await tx.collection('t_items').insertOne({ _id: 'k' });
      order.push('body');
      expect(tx.session.inTransaction()).toBe(true);
    }, { tenantId });
    expect(order).toEqual(['body', 'first deferred', 'second deferred']);
  });

  it('serialises read-then-write updates on one document, replacing SELECT ... FOR UPDATE', async () => {
    const tenantId = id();
    await db.tenant((tx) => tx.collection('t_items').insertOne({ _id: 'balance', days: 0 }), { tenantId });
    // 20 requests each read the balance and write balance + 1. Without isolation some would overwrite each other.
    await Promise.all(
      Array.from({ length: 20 }, () =>
        db.tenant(async (tx) => {
          const row = await tx.collection<{ _id: string; days: number }>('t_items').findOne({ _id: 'balance' });
          await tx.collection('t_items').updateOne({ _id: 'balance' }, { $set: { days: row!.days + 1 } });
        }, { tenantId }),
      ),
    );
    const final = await db.tenant((tx) => tx.collection<{ _id: string; days: number }>('t_items').findOne({ _id: 'balance' }), { tenantId });
    expect(final!.days).toBe(20);
  });

  it('keeps each workspace audit chain linear under concurrent writes and verifiable', async () => {
    const tenantId = id();
    const other = id();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        db.tenant(async (tx) => {
          await tx.collection('t_items').insertOne({ _id: `c${i}` });
          tx.audit(auditInput({ action: 'item.created', resourceType: 'item', resourceId: `c${i}`, changes: { n: { from: null, to: i } } }));
        }, { tenantId: i % 5 === 0 ? other : tenantId }),
      ),
    );
    const database = await db.database();
    expect(await mongo.verifyAuditChain(database, tenantId)).toEqual({ checked: 20, firstBrokenSeq: null });
    expect(await mongo.verifyAuditChain(database, other)).toEqual({ checked: 5, firstBrokenSeq: null });
    const seqs = (await database.collection('audit_events').find({ tenantId }).sort({ chainSeq: 1 }).toArray()).map((e) => e.chainSeq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    // Editing a stored event breaks the chain at that event.
    await database.collection('audit_events').updateOne({ tenantId, chainSeq: 7 }, { $set: { 'changes.n.to': 999 } });
    expect(await mongo.verifyAuditChain(database, tenantId)).toEqual({ checked: 7, firstBrokenSeq: 7 });
  });

  it('keeps platform events on their own chain and refuses cross-workspace events', async () => {
    const tenantId = id();
    await db.platform(async (tx) => {
      tx.audit(auditInput({ tenantId: null, actorType: 'platform_admin', actorId: id(), action: 'tenant.suspended' }));
    });
    const before = await mongo.verifyAuditChain(await db.database(), null);
    expect(before.firstBrokenSeq).toBeNull();
    expect(before.checked).toBeGreaterThan(0);

    await expect(db.tenant(async (tx) => tx.audit(auditInput({ tenantId: id() })), { tenantId })).rejects.toThrow(/belong to that workspace/);
    await expect(db.tenant(async (tx) => tx.audit(auditInput({ action: 'Not Valid' })), { tenantId })).rejects.toThrow(/Invalid audit action/);
  });

  it('rejects documents that fail the collection validator', async () => {
    const database = await db.database();
    await expect(database.collection('audit_events').insertOne({ _id: 'not-a-uuid' } as never)).rejects.toThrow(/validation/i);
  });
});
