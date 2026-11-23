import { UNLIMITED } from '@crew/contracts';
import type { MongoMigration } from '../migrator';
import { Table } from '../table';

/**
 * Plan-based workspace limits: every plan gains the Employee Workspaces limit (max_employee_workspaces), and plans made
 * in the Console before HR Workspaces existed gain the HR Workspaces limit (max_hr_workspaces).
 *
 * Nobody loses anything: a plan's Employee Workspaces start at its "Employees included" figure (the seats it already
 * enforced on logins), and a missing HR Workspaces limit starts unlimited, as it behaved. SAMPLEDGE then sets the real
 * figures in Console > Plans. Built-in plans not edited in the Console get the catalogue figures from the next
 * catalogue sync. Safe to run again: a plan that already has the limit is left alone.
 */
export const m0130WorkspaceLimits: MongoMigration = {
  name: '0130_workspace_limits',
  up: async (db) => {
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const planFeatures = new Table(db, 'plan_features', session, { scope: null });
        const plans = await db.collection('plans').find({}, { session, projection: { _id: 1 } }).toArray();
        for (const p of plans) {
          const planId = String(p._id);
          const rows = await planFeatures.find({ plan_id: planId, feature_key: { $in: ['max_employees', 'max_hr_workspaces', 'max_employee_workspaces'] } });
          const has = (k: string) => rows.find((r) => r.feature_key === k);
          if (!has('max_employee_workspaces')) {
            const seats = has('max_employees')?.limit_value;
            await planFeatures.insert({ plan_id: planId, feature_key: 'max_employee_workspaces', limit_value: typeof seats === 'number' ? seats : UNLIMITED });
          }
          if (!has('max_hr_workspaces')) await planFeatures.insert({ plan_id: planId, feature_key: 'max_hr_workspaces', limit_value: UNLIMITED });
        }
      });
    } finally {
      await session.endSession();
    }
  },
};
