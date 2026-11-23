import { randomUUID } from 'node:crypto';
import type { MongoMigration } from '../migrator';

/** The old per-HR-Workspace employee-data switches and the Workspace Permissions switch each one became. */
const SWITCH_ITEMS: Record<string, string> = {
  'employees:update': 'employees.edit',
  'employees:create': 'employees.create',
  'imports:run': 'employees.import',
  'employees:export': 'employees.export',
  'fields:manage': 'settings.fields',
};

/**
 * Simplified leave and Workspace Permissions (2026-11-23).
 *  - Every leave type gains a visibility ("both": it stays where it was used) and an owner (the Super Workspace).
 *    Allocations, the ledger and requests are not changed; allocations are kept as history and no longer read, and
 *    automatic accruals are no longer posted or counted. Nothing is deleted.
 *  - The Super Workspace's employee-data switches of each HR Workspace (hr_workspaces.permissions_off) move to
 *    Settings > Workspace Permissions (level_permissions, subject hr_workspace), so there is one place for them. The old
 *    field is left as it was, for rollback, and is no longer read.
 * Safe to run again: types that already have a visibility, and switches already saved, are left alone.
 */
export const m0160SimpleLeavePermissions: MongoMigration = {
  name: '0160_simple_leave_permissions',
  up: async (db) => {
    // Both fields in one write: the collection's validator may already require them.
    await db.collection('leave_types').updateMany({ $or: [{ visibility: { $exists: false } }, { owner_level: { $exists: false } }] }, [
      { $set: { visibility: { $ifNull: ['$visibility', 'both'] }, owner_level: { $ifNull: ['$owner_level', 'super'] }, owner_hr_workspace_id: { $ifNull: ['$owner_hr_workspace_id', null] } } },
    ]);
    const spaces = await db.collection('hr_workspaces').find({ 'permissions_off.0': { $exists: true } }, { projection: { _id: 1, tenant_id: 1, permissions_off: 1 } }).toArray();
    for (const w of spaces) {
      const id = String(w._id);
      const off = ((w.permissions_off ?? []) as string[]).map((k) => SWITCH_ITEMS[k]).filter((k): k is string => Boolean(k));
      if (!off.length) continue;
      const existing = await db.collection('level_permissions').findOne({ tenant_id: w.tenant_id, subject_type: 'hr_workspace', subject_id: id });
      const permissions = { ...Object.fromEntries(off.map((k) => [k, false])), ...((existing?.permissions ?? {}) as Record<string, boolean>) };
      const now = new Date();
      if (existing) await db.collection('level_permissions').updateOne({ _id: existing._id }, { $set: { permissions, updated_at: now } });
      else await db.collection('level_permissions').insertOne({ _id: randomUUID() as never, tenant_id: w.tenant_id, subject_type: 'hr_workspace', subject_id: id, permissions, scope_hr_workspace_ids: null, created_at: now, updated_at: now });
    }
  },
};
