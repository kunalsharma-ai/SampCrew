import type { MongoMigration } from '../migrator';

/**
 * Centralized document management. Every existing document stays where it is and keeps its status: it becomes
 * version 1 of an employee-owned document, filed under the HR Workspace its employee belongs to today, with a
 * reference people can search for. New collections (requests, activity, access switches, custom categories and types)
 * are created by syncCollections. Safe to run again.
 */
export const m0100DocumentCenter: MongoMigration = {
  name: '0100_document_center',
  up: async (db) => {
    const docs = db.collection('employee_documents');
    await docs.updateMany({ owner_type: { $exists: false } }, { $set: { owner_type: 'employee' } });
    await docs.updateMany({ version: { $exists: false } }, { $set: { version: 1 } });
    const missing = await docs.find({ reference: { $exists: false } }, { projection: { _id: 1, employee_id: 1, tenant_id: 1 } }).toArray();
    const placements = new Map<string, string | null>();
    for (const d of missing) {
      const empId = d.employee_id as string | null | undefined;
      if (empId && !placements.has(empId)) {
        const e = await db.collection('employees').findOne({ _id: empId as never }, { projection: { hr_workspace_id: 1 } });
        placements.set(empId, (e?.hr_workspace_id as string | null | undefined) ?? null);
      }
      const ref = `DOC-${String(d._id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      await db.collection('employee_documents').updateOne({ _id: d._id }, { $set: { reference: ref, hr_workspace_id: empId ? placements.get(empId) ?? null : null } });
    }
  },
};
