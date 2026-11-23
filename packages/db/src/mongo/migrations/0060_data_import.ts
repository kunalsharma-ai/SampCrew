import type { MongoMigration } from '../migrator';

/**
 * Data import and master data: custom fields gain "searchable" (off) and "available during import" (on), and each HR
 * Workspace an empty list of employee-data permissions switched off, so nobody loses anything. The new collections
 * (import_jobs, import_job_rows, master_values, client_contacts) are created from the schema. Safe to run again.
 */
export const m0060DataImport: MongoMigration = {
  name: '0060_data_import',
  up: async (db) => {
    await db.collection('custom_fields').updateMany({ searchable: { $exists: false } }, { $set: { searchable: false } });
    await db.collection('custom_fields').updateMany({ importable: { $exists: false } }, { $set: { importable: true } });
    await db.collection('hr_workspaces').updateMany({ permissions_off: { $exists: false } }, { $set: { permissions_off: [] } });
  },
};
