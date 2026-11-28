import type { MongoMigration } from '../migrator';

/**
 * Career Enquiry (28 November 2026): applications from the company's website, received by SampCrew.
 *
 *  - Every existing candidate gets `career_only: false`: they are already Candidate CRM records. Only website
 *    applicants not yet moved into the CRM carry true.
 *  - The Career Enquiry page (feature part recruitment.careers) is released as Active in Console > Feature
 *    management, because SAMPLEDGE asked for it; a choice someone made there is never changed.
 *
 * New collections (career_integrations, career_applications, career_application_events, career_notes,
 * career_interviews, career_sync_jobs, career_access, career_settings) are created by syncCollections. Nobody in an
 * HR Workspace sees Career Enquiry until Super Workspace switches it on. Safe to run again.
 */
export const m0230CareerEnquiry: MongoMigration = {
  name: '0230_career_enquiry',
  up: async (db) => {
    await db.collection('candidates').updateMany({ career_only: { $exists: false } }, { $set: { career_only: false } });
    const states = db.collection('platform_feature_states');
    const now = new Date();
    if (await states.countDocuments({}, { limit: 1 })) {
      const row = await states.findOne({ key: 'recruitment.careers' });
      if (!row) await states.insertOne({ _id: crypto.randomUUID() as never, key: 'recruitment.careers', state: 'active', reason: null, updated_by: 'migration 0230', created_at: now, updated_at: now });
      else if (row.state === 'pending' && row.updated_by === 'catalogue') await states.updateOne({ _id: row._id }, { $set: { state: 'active', updated_by: 'migration 0230', updated_at: now } });
    }
  },
};
