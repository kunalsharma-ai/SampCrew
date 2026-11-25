import type { MongoMigration } from '../migrator';

/**
 * Office / home / hybrid attendance (2026-11-25, contracts work-mode.ts). Collections and indexes come from the
 * schema (work_mode_settings, work_sites, work_assignments, attendance_locations, work_mode_changes,
 * attendance_saved_reports); this fills the new required fields on existing rows so they read the same as new ones:
 *  - every company gets its settings row with the defaults, classifying from today: days before stay unclassified,
 *    so no existing attendance changes and nobody's history is suddenly "pending verification".
 *  - locations with a geofence stay office geofences (geofence_active true).
 *  - existing attendance days and corrections get the empty defaults of the new fields.
 * Nothing is rewritten beyond adding those fields. Safe to run again.
 */
export const m0190WorkModeAttendance: MongoMigration = {
  name: '0190_work_mode_attendance',
  up: async (db) => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const tenants = await db.collection('tenants').find({}, { projection: { _id: 1 } }).toArray();
    for (const t of tenants) {
      await db.collection('work_mode_settings').updateOne(
        { tenant_id: t._id },
        {
          $setOnInsert: {
            _id: crypto.randomUUID() as never, tenant_id: t._id, classify_from: today, enabled: true, labels: {}, min_office_minutes: 60, min_remote_minutes: 60,
            transition: 'split', max_accuracy_m: 150, other_offices: 'office', office_requirement: 'none', location_retention_days: 90,
            employee_can_request_correction: true, standard_minutes: 480, created_at: now, updated_at: now,
          },
        },
        { upsert: true },
      );
    }
    await db.collection('locations').updateMany({ geofence_active: { $exists: false } }, { $set: { geofence_active: true } });
    await db.collection('attendance_corrections').updateMany({ category: { $exists: false } }, { $set: { category: 'other' } });
    await db.collection('attendance_days').updateMany(
      { work_mode_provisional: { $exists: false } },
      { $set: { work_mode_provisional: false, office_minutes: 0, remote_minutes: 0, unverified_minutes: 0, work_mode_places: [], work_mode_issues: [], work_mode_explanation: [], notices_sent: [] } },
    );
  },
};
