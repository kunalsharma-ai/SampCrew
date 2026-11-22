import type { MongoMigration } from '../migrator';

/**
 * Console admins get `seen_alerts`: the system alerts they have already seen in the Console bell. Existing admins start
 * with none, so every current alert shows as new once. Safe to run again.
 */
export const m0081ConsoleAlertsSeen: MongoMigration = {
  name: '0081_console_alerts_seen',
  up: async (db) => {
    await db.collection('platform_admins').updateMany({ seen_alerts: { $exists: false } }, { $set: { seen_alerts: [] } });
  },
};
