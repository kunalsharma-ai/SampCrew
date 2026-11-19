import { categorizeApproval, type ApprovalMeta } from '@crew/contracts';
import type { MongoMigration } from '../migrator';

/**
 * Approval category cards: requests made before them get the facts they are grouped by (for leave, the leave type
 * code, whether it is paid and whether it is a half day; for expenses, the expense category) and their category.
 * Existing requests are otherwise untouched. Safe to run again.
 */
export const m0031ApprovalCategories: MongoMigration = {
  name: '0031_approval_categories',
  up: async (db) => {
    const requests = db.collection('approval_requests');
    const todo = await requests.find({ category: { $exists: false } }, { projection: { _id: 1, tenant_id: 1, resource_type: 1, resource_id: 1 } }).toArray();
    for (const r of todo) {
      let meta: ApprovalMeta = {};
      if (r.resource_type === 'leave_request') {
        const lr = await db.collection('leave_requests').findOne({ _id: r.resource_id, tenant_id: r.tenant_id } as never);
        const lt = lr ? await db.collection('leave_types').findOne({ _id: lr.leave_type_id, tenant_id: r.tenant_id } as never) : null;
        if (lr && lt) meta = { leaveTypeCode: lt.code, leaveTypeName: lt.name, paid: Boolean(lt.paid), halfDay: lr.start_half !== 'full' || lr.end_half !== 'full' };
      } else if (r.resource_type === 'expense_claim') {
        const c = await db.collection('expense_claims').findOne({ _id: r.resource_id, tenant_id: r.tenant_id } as never);
        const cat = c ? await db.collection('expense_categories').findOne({ _id: c.category_id, tenant_id: r.tenant_id } as never) : null;
        if (c) meta = { expenseCategoryId: c.category_id, ...(cat ? { expenseCategoryName: cat.name } : {}) };
      }
      await requests.updateOne({ _id: r._id }, { $set: { meta, category: categorizeApproval(r.resource_type, meta) } });
    }
  },
};
