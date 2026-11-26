import type { MongoMigration } from '../migrator';

/**
 * Feedback of 25 November 2026 (issue #86). Fills the new fields on existing rows so they read the same as new ones:
 *  - companies that already finished setup have their registered information locked from now on;
 *  - every company's attendance settings get the location choice (at check-in and check-out, as before) and an empty
 *    office network list (no IP remark until HR adds the office addresses);
 *  - saved Home layouts hide the widgets Home no longer shows by default (announcements, Workspace at a glance,
 *    Recently viewed, Personal notes, Needs your attention, Your access); each can be added back from Customize;
 *  - chat messages get an empty set of emoji reactions.
 * Nothing existing is rewritten. Safe to run again.
 */
export const m0200Feedback25Nov: MongoMigration = {
  name: '0200_feedback_25_nov',
  up: async (db) => {
    await db.collection('tenants').updateMany(
      { setup_completed_at: { $ne: null }, company_locked_at: { $exists: false } },
      [{ $set: { company_locked_at: '$setup_completed_at' } }],
    );
    await db.collection('work_mode_settings').updateMany({ location_tracking: { $exists: false } }, { $set: { location_tracking: 'punch' } });
    await db.collection('work_mode_settings').updateMany({ office_ips: { $exists: false } }, { $set: { office_ips: [] } });
    await db.collection('member_preferences').updateMany(
      { 'dashboard.order.0': { $exists: true } },
      { $addToSet: { 'dashboard.hidden': { $each: ['announcements', 'headcount', 'recent', 'notes', 'attention', 'access'] } } },
    );
    await db.collection('chat_messages').updateMany({ reactions: { $exists: false } }, { $set: { reactions: {} } });
  },
};
