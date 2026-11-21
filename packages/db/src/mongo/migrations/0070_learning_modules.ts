import { randomUUID } from 'node:crypto';
import { legacyCourseBlocks } from '@crew/contracts';
import type { MongoMigration } from '../migrator';

/**
 * Learning modules: every course becomes a published module (version 1) whose one content item is its link, and every
 * course assignment gains progress, score and the version it is on. Completed records are kept exactly as they are
 * (100% progress, no score). Nothing is removed, so older screens and the phone app keep working. Safe to run again.
 */
export const m0070LearningModules: MongoMigration = {
  name: '0070_learning_modules',
  up: async (db) => {
    const courses = db.collection('courses');
    const versions = db.collection('learning_module_versions');
    for (const c of await courses.find({ status: { $exists: false } }).toArray()) {
      const blocks = legacyCourseBlocks({ title: c.title, description: c.description, format: c.format, content_url: c.content_url, duration_minutes: c.duration_minutes });
      const archived = !!c.archived_at;
      let versionId: string | null = null;
      if (!(await versions.findOne({ tenant_id: c.tenant_id, course_id: c._id, version: 1 }))) {
        versionId = randomUUID();
        await versions.insertOne({
          _id: versionId as never, tenant_id: c.tenant_id, course_id: c._id, version: 1, title: c.title, description: c.description ?? '', duration_minutes: c.duration_minutes ?? null,
          blocks, note: 'Created from the course', published_by_membership_id: c.created_by_membership_id ?? null, created_at: c.created_at ?? new Date(),
        });
      } else versionId = String((await versions.findOne({ tenant_id: c.tenant_id, course_id: c._id, version: 1 }))!._id);
      await courses.updateOne({ _id: c._id }, {
        $set: {
          status: archived ? 'archived' : 'published', short_description: '', topic: '', skill_names: [], difficulty: 'beginner', custom_difficulty: null, language: 'English', tags: [],
          cover_file_id: null, creator_name: null, creator_designation: null, creator_level: 'super', owner_hr_workspace_id: null, blocks, unpublished_changes: false, version: 1,
          published_version_id: versionId, published_at: c.created_at ?? new Date(), published_by_membership_id: c.created_by_membership_id ?? null, publish_at: null,
          scheduled_by_membership_id: null, certificate: false, default_due_days: null, updated_by_membership_id: null,
        },
      });
    }
    const versionOf = new Map<string, string>();
    for (const v of await versions.find({ version: 1 }, { projection: { course_id: 1 } }).toArray()) versionOf.set(String(v.course_id), String(v._id));
    for (const a of await db.collection('course_assignments').find({ progress: { $exists: false } }).toArray()) {
      const done = a.status === 'completed';
      await db.collection('course_assignments').updateOne({ _id: a._id }, {
        $set: {
          version: 1, version_id: versionOf.get(String(a.course_id)) ?? null, progress: done ? { course: { done: true } } : {}, progress_percent: done ? 100 : 0,
          score_percent: null, passed: null, time_spent_seconds: 0, last_activity_at: null, completed_at: null, certificate_no: null, audience_assignment_id: null,
        },
      });
    }
  },
};
