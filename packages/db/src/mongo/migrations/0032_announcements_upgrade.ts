import type { MongoMigration } from '../migrator';

/**
 * Announcements gain a category, priority, attachments, versions (for edits after publishing) and scheduling.
 * Announcements made before get the defaults; their audience stays as it was (legal entity, department and
 * location, with `audience` left empty). Safe to run again.
 */
export const m0032AnnouncementsUpgrade: MongoMigration = {
  name: '0032_announcements_upgrade',
  up: async (db) => {
    const a = db.collection('announcements');
    await a.updateMany({ category: { $exists: false } }, { $set: { category: 'general' } });
    await a.updateMany({ priority: { $exists: false } }, { $set: { priority: 'normal' } });
    await a.updateMany({ file_ids: { $exists: false } }, { $set: { file_ids: [] } });
    await a.updateMany({ version: { $exists: false } }, { $set: { version: 1 } });
    await a.updateMany({ ack_version: { $exists: false } }, { $set: { ack_version: 1 } });
    // Acknowledgements given before refer to the only version there was.
    await db.collection('announcement_receipts').updateMany({ acknowledged_at: { $ne: null }, acknowledged_version: { $exists: false } }, { $set: { acknowledged_version: 1 } });
  },
};
