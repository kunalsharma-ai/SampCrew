import type { MongoMigration } from '../migrator';

/**
 * Learning notices get their own category (they were filed under Appraisals), so the Learning menu item can show its
 * unread dot and people can mute learning separately. Only notices of learning kinds move. Safe to run again.
 */
export const m0080LearningNotifications: MongoMigration = {
  name: '0080_learning_notifications',
  up: async (db) => {
    await db.collection('notifications').updateMany({ category: 'appraisal', kind: { $regex: '^(learning|course)\\.' } }, { $set: { category: 'learning' } });
  },
};
