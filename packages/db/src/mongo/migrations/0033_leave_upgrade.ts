import type { MongoMigration } from '../migrator';

/**
 * Leave types gain a kind, gender eligibility and calendar-day counting; policies gain department, designation and
 * location scopes; requests can be changed. Everything made before keeps working as it did: types are standard time
 * off for everyone, policies stay as wide as they were, and requests have no changes recorded. Safe to run again.
 */
export const m0033LeaveUpgrade: MongoMigration = {
  name: '0033_leave_upgrade',
  up: async (db) => {
    const types = db.collection('leave_types');
    await types.updateMany({ kind: { $exists: false } }, { $set: { kind: 'standard' } });
    await types.updateMany({ eligible_gender: { $exists: false } }, { $set: { eligible_gender: 'any' } });
    await types.updateMany({ counts_calendar_days: { $exists: false } }, { $set: { counts_calendar_days: false } });
    const policies = db.collection('leave_policies');
    for (const f of ['department_id', 'designation_id', 'location_id']) await policies.updateMany({ [f]: { $exists: false } }, { $set: { [f]: null } });
    await db.collection('leave_requests').updateMany({ modifications: { $exists: false } }, { $set: { modifications: [] } });
  },
};
