import { randomUUID } from 'node:crypto';
import { SYSTEM_ROLES } from '@crew/contracts';
import type { MongoMigration } from '../migrator';

/** Permissions added with the employee workspace (HR Tasks, Manager Tasks, profile change review). */
const NEW_PERMISSIONS = ['tasks:assign', 'tasks:hr', 'profiles:review'];

/**
 * Existing workspaces get the new employee workspace permissions on their system roles, at the scope the role
 * template gives them, so managers can assign Manager Tasks and HR can assign HR Tasks and review profile changes
 * without anyone editing roles. Only these permissions are added, and only where missing. Safe to run again.
 */
export const m0020EmployeeWorkspacePermissions: MongoMigration = {
  name: '0020_employee_workspace_permissions',
  up: async (db) => {
    for (const template of SYSTEM_ROLES) {
      const grants = Object.entries(template.grants).filter(([p]) => NEW_PERMISSIONS.includes(p));
      if (!grants.length) continue;
      const roles = await db.collection('roles').find({ key: template.key, is_system: true }, { projection: { _id: 1, tenant_id: 1 } }).toArray();
      for (const role of roles) {
        for (const [permission, scope] of grants) {
          await db.collection('role_permissions').updateOne(
            { role_id: role._id, permission },
            { $setOnInsert: { _id: randomUUID() as never, tenant_id: role.tenant_id, role_id: role._id, permission, scope } },
            { upsert: true },
          );
        }
      }
    }
  },
};
