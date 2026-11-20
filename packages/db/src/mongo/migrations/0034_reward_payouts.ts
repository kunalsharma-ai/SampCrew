import type { MongoMigration } from '../migrator';

/**
 * Attendance reward rules gain a payout (a payroll bonus or extra leave days) that HR can grant to each month's
 * winners. Rules made before pay nothing, as they did: recognition only. Safe to run again.
 */
export const m0034RewardPayouts: MongoMigration = {
  name: '0034_reward_payouts',
  up: async (db) => {
    const rules = db.collection('attendance_reward_rules');
    await rules.updateMany({ payout_type: { $exists: false } }, { $set: { payout_type: 'none', payout_amount: null, payout_days: null, payout_leave_type_id: null } });
  },
};
