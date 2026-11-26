import type { MongoMigration } from '../migrator';

/** The Learning parts that companies could not open (issue #89 point 5). */
const LEARNING_PARTS = ['learning.mine', 'learning.manage', 'learning.catalogue'];

/**
 * Issue #89 and the onboarding document checklist (26 November 2026).
 *
 *  - Learning management: on installations that existed before the LMS shipped, the catalogue sync wrote its pages as
 *    Pending in Console > Feature management, so they showed as Restricted for the Console, the Super Workspace and
 *    HR (point 5). They are made Active, as every page was on the first sync. A Console choice (off, or switched by a
 *    person) is never changed.
 *
 *  - Notification sounds (point 7): sound is now on by default. A saved organisation policy whose starting choice was
 *    "no sound" is switched to "sound on" for people who never chose; anyone who saved their own settings keeps them,
 *    and an organisation that does not allow sound at all keeps that.
 *
 * New collections (onboarding document library, templates, checklists, document requests to Super Workspace, leave
 * status rules, comp-off requests, form field settings, company email templates) are created by syncCollections. Safe to run again.
 */
export const m0210OnboardingDocuments: MongoMigration = {
  name: '0210_onboarding_documents',
  up: async (db) => {
    const states = db.collection('platform_feature_states');
    await states.updateMany(
      { key: { $in: LEARNING_PARTS }, state: 'pending', updated_by: 'catalogue' },
      { $set: { state: 'active', updated_by: 'migration 0210', updated_at: new Date() } },
    );
    await db.collection('notification_policies').updateMany({ 'policy.defaults.sound': false, 'policy.allowSound': { $ne: false } }, { $set: { 'policy.defaults.sound': true } });
  },
};
