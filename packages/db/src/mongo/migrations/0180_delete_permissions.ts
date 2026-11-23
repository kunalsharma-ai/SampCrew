import type { MongoMigration } from '../migrator';
import { syncConsoleRolesMongo, type Tables } from '../provision';
import { Table } from '../table';

/** Console permissions that already let a role delete or archive something in the Console. */
const CONSOLE_DELETING = ['tenants:manage', 'plans:manage', 'statutory:manage', 'integrations:manage', 'roles:manage', 'help:manage'];

/**
 * Password-confirmed, permission-gated deletion (2026-11-23, contracts delete-permissions.ts).
 *  - Every company starts with no delete area switched off by the Console (tenant_access_controls.delete_areas_off
 *    = []), so the Super Workspace keeps deleting as before, now with its password each time.
 *  - HR and Employee Workspace delete permissions start off: nothing is written for them, an unsaved switch is off.
 *  - Console roles: the new "Delete records" permission (records:delete) goes to every role that could already delete
 *    or archive something, so no Console Admin loses what they could do; built-in roles not changed by hand get it
 *    from the role list (provision syncConsoleRolesMongo), changed and custom roles here.
 * Safe to run again.
 */
export const m0180DeletePermissions: MongoMigration = {
  name: '0180_delete_permissions',
  up: async (db) => {
    await db.collection('tenant_access_controls').updateMany({ delete_areas_off: { $exists: false } }, { $set: { delete_areas_off: [] } });
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const tables = { collection: (name: string) => new Table(db, name, session, { scope: null }) } as unknown as Tables;
        await syncConsoleRolesMongo(tables);
      });
    } finally {
      await session.endSession();
    }
    await db.collection('platform_roles').updateMany(
      { permissions: { $in: CONSOLE_DELETING, $nin: ['records:delete'] } },
      { $addToSet: { permissions: 'records:delete' } },
    );
  },
};
