import type { MongoMigration } from '../migrator';

/**
 * Feature management by level: the company document gains the HR Workspace and Employee Workspace level switches, and
 * each HR Workspace its Employee Workspace switches. All start empty, so nobody loses anything. Safe to run again.
 */
export const m0035FeatureManagement: MongoMigration = {
  name: '0035_feature_management',
  up: async (db) => {
    await db.collection('workspace_modules').updateMany({ hr_level_off: { $exists: false } }, { $set: { hr_level_off: [] } });
    await db.collection('workspace_modules').updateMany({ employee_level_off: { $exists: false } }, { $set: { employee_level_off: [] } });
    await db.collection('workspace_modules').updateMany({ employee_level_off_by_hr: { $exists: false } }, { $set: { employee_level_off_by_hr: [] } });
    await db.collection('hr_workspaces').updateMany({ employee_off_features: { $exists: false } }, { $set: { employee_off_features: [] } });
  },
};
