import { kindNeedsAction } from '@crew/contracts';
import type { MongoMigration } from '../migrator';

/**
 * The central notification framework: notices raised before it get `action_required` from their kind (an approval
 * waiting for you, a task assigned to you ...), so the bell, Home and each module can show "Action needed" and filter
 * on it for old notices too. Notification policies (notification_policies) start empty: a workspace without one uses
 * the default policy, which changes nothing for anyone. Safe to run again.
 */
export const m0170NotificationFramework: MongoMigration = {
  name: '0170_notification_framework',
  up: async (db) => {
    const notes = db.collection('notifications');
    const kinds = await notes.distinct('kind', { action_required: { $exists: false } });
    for (const kind of kinds) {
      await notes.updateMany({ kind, action_required: { $exists: false } }, { $set: { action_required: kindNeedsAction(String(kind)) } });
    }
  },
};
