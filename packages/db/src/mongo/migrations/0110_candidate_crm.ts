import type { MongoMigration } from '../migrator';

/**
 * Candidate CRM. Existing candidates become CRM records without losing anything: each gets the empty CRM sections,
 * a candidate number (CAN-000001 ...) in the order they were added, and a CRM stage taken from where their job
 * applications stand (hired: Joined; every application closed as rejected: Rejected; otherwise New Candidate). They
 * stay with the Super Workspace and company-wide HR (no HR Workspace owner). Notes and files get their new defaults.
 * No HR Workspace gets the CRM until Super Workspace switches it on. Safe to run again.
 */
export const m0110CandidateCrm: MongoMigration = {
  name: '0110_candidate_crm',
  up: async (db) => {
    const candidates = db.collection('candidates');
    const empty: Record<string, unknown> = {
      compensation: {}, insights: {}, links: {}, notice: {}, personal: {}, preferences: {}, professional: {},
      crm_shared_hr_workspace_ids: [], reference_types: [], skills: [],
    };
    for (const [field, value] of Object.entries(empty)) {
      await candidates.updateMany({ [field]: { $exists: false } }, { $set: { [field]: value } });
    }
    await db.collection('candidate_notes').updateMany({ category: { $exists: false } }, { $set: { category: 'general' } });
    await db.collection('candidate_notes').updateMany({ restricted: { $exists: false } }, { $set: { restricted: false } });
    await db.collection('candidate_files').updateMany({ version: { $exists: false } }, { $set: { version: 1 } });

    const tenants = await candidates.distinct('tenant_id', { candidate_code: { $exists: false } });
    for (const tenantId of tenants) {
      const settings = db.collection('candidate_crm_settings');
      let next = ((await settings.findOne({ tenant_id: tenantId }))?.next_number as number | undefined) ?? 1;
      const rows = await candidates.find({ tenant_id: tenantId, candidate_code: { $exists: false } }, { projection: { _id: 1, created_at: 1 } }).sort({ created_at: 1, _id: 1 }).toArray();
      for (const c of rows) {
        const apps = await db.collection('applications').find({ tenant_id: tenantId, candidate_id: c._id }, { projection: { status: 1 } }).toArray();
        const stage = apps.some((a) => a.status === 'hired') ? 'joined' : apps.length && apps.every((a) => a.status === 'rejected') ? 'rejected' : 'new';
        await candidates.updateOne(
          { _id: c._id },
          { $set: { candidate_code: `CAN-${String(next).padStart(6, '0')}`, crm_stage: stage, crm_stage_entered_at: c.created_at ?? new Date() } },
        );
        next++;
      }
      const now = new Date();
      await settings.updateOne(
        { tenant_id: tenantId },
        {
          $set: { next_number: next, updated_at: now },
          $setOnInsert: { _id: crypto.randomUUID() as never, stages: [], sources: [], match_fields: ['email', 'phone', 'candidate_code'], created_at: now },
        },
        { upsert: true },
      );
    }
  },
};
