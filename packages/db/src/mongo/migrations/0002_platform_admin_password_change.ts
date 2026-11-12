import type { MongoMigration } from '../migrator';

/**
 * Console admins get `must_change_password` (set when another admin or the recovery command gives them a temporary
 * password). Admins created before it have no value, and the collection's validator requires one, so they get false
 * before the new validator is applied. Safe to run again.
 */
export const m0002PlatformAdminPasswordChange: MongoMigration = {
  name: '0002_platform_admin_password_change',
  up: async (db) => {
    await db.collection('platform_admins').updateMany({ must_change_password: { $exists: false } }, { $set: { must_change_password: false } });
  },
};
