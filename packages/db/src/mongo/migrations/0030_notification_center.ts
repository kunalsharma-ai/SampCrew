import { categoryOfKind } from '@crew/contracts';
import type { MongoMigration } from '../migrator';

/**
 * The shared notification model: notices raised before it get the category their kind belongs to, normal priority,
 * a count of one and updated_at (the Notification Center sorts and filters on these). Safe to run again.
 */
export const m0030NotificationCenter: MongoMigration = {
  name: '0030_notification_center',
  up: async (db) => {
    const notes = db.collection('notifications');
    const kinds = await notes.distinct('kind', { category: { $exists: false } });
    for (const kind of kinds) {
      await notes.updateMany({ kind, category: { $exists: false } }, { $set: { category: categoryOfKind(String(kind)) } });
    }
    await notes.updateMany({ priority: { $exists: false } }, { $set: { priority: 'normal' } });
    await notes.updateMany({ count: { $exists: false } }, { $set: { count: 1 } });
    await notes.updateMany({ updated_at: { $exists: false } }, [{ $set: { updated_at: '$created_at' } }]);
  },
};
