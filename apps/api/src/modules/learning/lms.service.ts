import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import {
  ALL_LEARNING_FILE_TYPES, audienceIsEmpty, blockIssues, type ContentBlock, DEFAULT_HR_LEARNING_CAPS, formatOf, LEARNING_CATEGORIES, LEARNING_FILE_MAX_BYTES,
  LEARNING_FILE_TYPES, LEARNING_LANGUAGES, LEARNING_MEDIA_MAX_BYTES, LEARNING_SKILLS, learningAudience, type AssignModuleInput, type LearningAudience, type LearningCap,
  type LearningModuleInput,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, loadSubject } from '../../platform/authz/authz.service';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { ieq, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { safeFileName } from '../../platform/http/content-disposition';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { sniffMatches, StorageService } from '../../platform/storage/storage.service';
import type { UploadedFile } from '../documents/documents.service';
import { safeHtml } from '../communication/audience';
import { displayName } from '../employees/employee-view';
import { CENTRAL, hrCapsMap, learningAccess, type LearningAccess } from './learning-access';
import { addDays, creatorOf, CURRENT, describeAudience, type Doc, OPEN, parseBlocks, resolveAudience, today } from './learning-common';

const OLE = [0xd0, 0xcf, 0x11, 0xe0];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** Checks a learning file's first bytes against its declared type. */
function contentMatches(type: string, head: Buffer): boolean {
  const starts = (bytes: number[], at = 0) => bytes.every((b, i) => head[at + i] === b);
  if (type === 'application/msword' || type === 'application/vnd.ms-powerpoint') return starts(OLE);
  if (type.startsWith('application/vnd.openxmlformats')) return starts(ZIP);
  if (type === 'video/mp4' || type === 'audio/mp4') return head.subarray(4, 8).toString('ascii') === 'ftyp';
  if (type === 'video/webm' || type === 'audio/webm') return starts([0x1a, 0x45, 0xdf, 0xa3]);
  if (type === 'audio/mpeg') return head.subarray(0, 3).toString('ascii') === 'ID3' || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0);
  if (type === 'audio/wav') return head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WAVE';
  if (type === 'audio/ogg') return head.subarray(0, 4).toString('ascii') === 'OggS';
  return sniffMatches(type, head);
}

/** Every file id a module's blocks use (content, covers, attachments, reference material). */
export function blockFileIds(blocks: ContentBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if ('source' in b && b.source.type === 'upload') out.push(b.source.fileId);
    if ('coverFileId' in b && b.coverFileId) out.push(b.coverFileId);
    if (b.kind === 'text') out.push(...b.attachmentFileIds);
    if (b.kind === 'assignment') out.push(...b.settings.referenceFileIds);
  }
  return [...new Set(out)];
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * Learning management: modules (create, edit, publish as versions, schedule, archive), who they are assigned to,
 * the learning library, files, categories and the HR Workspace permissions the Super Workspace sets. Learner
 * screens are in LearnerService and dashboards and reports in LearningReportsService.
 */
@Injectable()
export class LmsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Learning');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // Scheduled work -----------------------------------------------------------------------------------------------

  /** Scheduled modules go live, audiences that keep enrolling pick up new people, and deadline reminders go out. */
  onApplicationBootstrap() {
    if (this.config.CREW_DISABLE_DISPATCHER === 'true' || this.config.CREW_ENV === 'test') return;
    const tick = () => void this.runJobs().catch((err: Error) => this.logger.error(`Learning jobs failed: ${err.message}`));
    setTimeout(tick, 20_000).unref();
    this.timer = setInterval(tick, 5 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runJobs(onlyTenantId?: string) {
    const release = await this.db.tryLease('learning_jobs', 10 * 60_000);
    if (!release) return { published: 0, enrolled: 0, reminded: 0 };
    try {
      const tenants = onlyTenantId ? [onlyTenantId] : await this.db.platform(async (tx) => (await tx.collection('tenants').find({ status: 'active' }, { projection: { id: 1 } })).map((t) => t.id as string));
      const out = { published: 0, enrolled: 0, reminded: 0 };
      for (const tenantId of tenants) {
        const r = await this.db.tenant((tx) => this.jobsFor(tx), { tenantId });
        out.published += r.published;
        out.enrolled += r.enrolled;
        out.reminded += r.reminded;
      }
      return out;
    } finally {
      await release();
    }
  }

  private async jobsFor(tx: TenantTx) {
    let published = 0;
    for (const c of await tx.collection('courses').find({ status: 'scheduled', publish_at: { $lte: new Date() } }, { limit: 50 })) {
      await this.publishNow(tx, c, c.scheduled_by_membership_id ?? null, 'Scheduled publication');
      published++;
    }
    let enrolled = 0;
    for (const aud of await tx.collection('learning_audiences').find({ active: true, keep_enrolling: true })) {
      const c = await tx.collection('courses').findOne({ id: aud.course_id });
      if (!c || c.status !== 'published') continue;
      let access: LearningAccess | null = null;
      if (!(aud.scope as string[]).includes('super')) {
        const m = aud.assigned_by_membership_id ? await tx.collection('memberships').findOne({ id: aud.assigned_by_membership_id, status: 'active' }) : undefined;
        if (!m) {
          await tx.collection('learning_audiences').updateOne({ id: aud.id }, { $set: { active: false } });
          continue;
        }
        access = await learningAccess(tx, await loadSubject(tx, m.id, m.user_id, true));
      }
      const r = await this.enrol(tx, c, learningAudience.parse(aud.audience), access, { dueOn: aud.due_on ?? null, audienceId: aud.id, by: aud.assigned_by_membership_id ?? null, quiet: false, strict: false });
      enrolled += r.enrolled;
    }
    let reminded = 0;
    const now = today();
    for (const a of await tx.collection('course_assignments').find({ status: { $in: OPEN }, due_on: { $ne: null, $lte: addDays(now, 3) } }, { limit: 500 })) {
      const overdue = a.due_on < now;
      if (overdue ? a.overdue_notified_at : a.due_soon_notified_at) continue;
      const e = await tx.collection('employees').findOne({ id: a.employee_id }, { projection: { membership_id: 1, status: 1 } });
      const c = await tx.collection('courses').findOne({ id: a.course_id }, { projection: { title: 1 } });
      if (e?.membership_id && CURRENT.includes(e.status) && c) {
        await this.notifications.notify(tx, {
          membershipIds: [e.membership_id], kind: overdue ? 'learning.overdue' : 'learning.due_soon', priority: overdue ? 'high' : 'normal',
          title: overdue ? `${c.title} is overdue (it was due ${a.due_on})` : `${c.title} is due ${a.due_on === now ? 'today' : `on ${a.due_on}`}`,
          link: `/learning/my/${a.id}`, dedupeKey: `learning.deadline:${a.id}`, resource: { type: 'course_assignment', id: a.id },
        });
        reminded++;
      }
      await tx.collection('course_assignments').updateOne({ id: a.id, status: { $in: OPEN } }, { $set: overdue ? { overdue_notified_at: new Date() } : { due_soon_notified_at: new Date() } });
    }
    return { published, enrolled, reminded };
  }

  // Access and options -------------------------------------------------------------------------------------------

  access(tx: TenantTx) {
    return this.authz.subject(tx).then((s) => learningAccess(tx, s));
  }

  /** What the caller can do in Learning, for the screens. */
  myAccess() {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      const caps = Object.fromEntries((['view', 'create', 'edit', 'publish', 'assign', 'quiz', 'assignment', 'grade', 'reports', 'export'] as LearningCap[]).map((c) => [c, a.has(c)]));
      return {
        level: a.isSuper ? 'super' : a.manager ? 'hr' : 'employee', manager: a.manager, caps,
        scopes: a.scopes.map((s) => ({ key: s.key, name: s.name, caps: [...s.caps] })),
        learner: Boolean(a.subject.employeeId),
      };
    });
  }

  /** Lists for the module form and the audience picker, limited to what the caller may reach. */
  options() {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      const custom = (await tx.collection('learning_categories').find({}, { sort: { name: 1 } })).map((c) => ({ id: c.id as string, name: c.name as string }));
      const skills = [...new Set([...LEARNING_SKILLS, ...(await tx.collection('skills').distinct<string>('name', {}))])].sort((x, y) => x.localeCompare(y));
      const named = async (table: string) => (await tx.collection(table).find({ archived_at: null }, { projection: { name: 1 }, sort: { name: 1 } })).map((d) => ({ id: d.id as string, name: d.name as string }));
      const manager = a.manager;
      const assignScope = manager ? a.peopleFilter('assign') : { _id: { $in: [] } };
      const people = manager ? await tx.collection('employees').find({ status: { $in: CURRENT }, ...assignScope }, { projection: { first_name: 1, last_name: 1, preferred_name: 1, employee_code: 1, hr_workspace_id: 1 }, sort: { first_name: 1 }, limit: 2000 }) : [];
      const spaces = manager ? await tx.collection('hr_workspaces').find({ status: 'active', ...(a.isSuper ? {} : { id: { $in: a.scopesWith('assign').map((s) => s.key) } }) }, { projection: { name: 1 }, sort: { name: 1 } }) : [];
      return {
        categories: [...LEARNING_CATEGORIES], customCategories: custom, skills, languages: [...LEARNING_LANGUAGES],
        departments: manager ? await named('departments') : [], designations: manager ? await named('designations') : [], locations: manager ? await named('locations') : [],
        hrWorkspaces: spaces.map((w) => ({ id: w.id as string, name: w.name as string })),
        canAssignCentral: a.isSuper || a.scopesWith('assign').some((s) => s.key === CENTRAL),
        people: people.map((e) => ({ id: e.id as string, name: displayName(e as never), code: e.employee_code as string, hrWorkspaceId: (e.hr_workspace_id as string | null) ?? null })),
      };
    });
  }

  async addCategory(name: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      if (!a.isSuper) throw Errors.forbiddenCode('learning_permission', 'Only the Super Workspace manages learning categories.');
      if ((LEARNING_CATEGORIES as readonly string[]).some((c) => c.toLowerCase() === name.toLowerCase()) || (await tx.collection('learning_categories').exists({ name: ieq(name) }))) {
        throw Errors.validation([{ path: 'name', message: 'There is already a category with this name' }]);
      }
      const r = await tx.collection('learning_categories').insert({ name, created_by_membership_id: a.subject.membershipId });
      await this.audit.record(tx, { action: 'learning_category.created', resourceType: 'learning_category', resourceId: r.id, changes: { name } });
      return { id: r.id as string, name };
    });
  }

  async removeCategory(id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      if (!a.isSuper) throw Errors.forbiddenCode('learning_permission', 'Only the Super Workspace manages learning categories.');
      const c = await tx.collection('learning_categories').findOne({ id });
      if (!c) throw Errors.notFound('Category');
      // Modules keep the name they were saved with; it is only removed from the list.
      await tx.collection('learning_categories').deleteOne({ id });
      await this.audit.record(tx, { action: 'learning_category.removed', resourceType: 'learning_category', resourceId: id, changes: { name: c.name } });
    });
  }

  // HR Workspace permissions --------------------------------------------------------------------------------------

  permissions() {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      if (!a.isSuper) throw Errors.forbiddenCode('learning_permission', 'Only the Super Workspace sets what HR Workspaces can do in Learning.');
      const caps = await hrCapsMap(tx);
      const rows = await tx.collection('learning_hr_permissions').find({});
      const updated = new Map(rows.map((r) => [(r.hr_workspace_id as string | null) ?? CENTRAL, r.updated_at]));
      const spaces = await tx.collection('hr_workspaces').find({ status: { $ne: 'archived' } }, { sort: { name: 1 } });
      const counts = new Map<string, number>();
      for (const e of await tx.collection('employees').find({ status: { $in: CURRENT } }, { projection: { hr_workspace_id: 1 } })) counts.set(e.hr_workspace_id ?? CENTRAL, (counts.get(e.hr_workspace_id ?? CENTRAL) ?? 0) + 1);
      const row = (key: string, name: string, status = 'active') => ({ hrWorkspaceId: key === CENTRAL ? null : key, name, status, employees: counts.get(key) ?? 0, caps: caps.get(key) ?? [...DEFAULT_HR_LEARNING_CAPS], customised: caps.has(key), updatedAt: updated.get(key) ?? null });
      return [row(CENTRAL, 'Company-wide HR (central group)'), ...spaces.map((w) => row(w.id as string, w.name as string, w.status as string))];
    });
  }

  setPermissions(hrWorkspaceId: string | null, caps: LearningCap[]) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      if (!a.isSuper) throw Errors.forbiddenCode('learning_permission', 'Only the Super Workspace sets what HR Workspaces can do in Learning.');
      if (hrWorkspaceId && !(await tx.collection('hr_workspaces').exists({ id: hrWorkspaceId, status: { $ne: 'archived' } }))) throw Errors.notFound('HR Workspace');
      // Every other power works through viewing, so it comes with them.
      const set = caps.length && !caps.includes('view') ? ['view', ...caps] : caps;
      const before = (await hrCapsMap(tx)).get(hrWorkspaceId ?? CENTRAL) ?? [...DEFAULT_HR_LEARNING_CAPS];
      await tx.collection('learning_hr_permissions').upsert({ hr_workspace_id: hrWorkspaceId }, { hr_workspace_id: hrWorkspaceId, caps: set, updated_by_membership_id: a.subject.membershipId }, { $set: { caps: set, updated_by_membership_id: a.subject.membershipId } });
      await this.audit.record(tx, { action: 'learning.permissions_changed', resourceType: 'hr_workspace', resourceId: hrWorkspaceId, changes: { caps: { from: before, to: set } } });
      return { hrWorkspaceId, caps: set };
    });
  }

  // Files -------------------------------------------------------------------------------------------------------

  async upload(file: UploadedFile | undefined, purpose: 'content' | 'submission') {
    if (!file) throw Errors.badRequest('no_file', 'Choose a file');
    if (!ALL_LEARNING_FILE_TYPES.includes(file.mimetype)) throw Errors.badRequest('unsupported_type', 'Upload a video (MP4, WebM), audio (MP3, M4A, WAV, OGG), PDF, Word, PowerPoint, text or image file');
    const media = (LEARNING_FILE_TYPES.video as readonly string[]).includes(file.mimetype) || (LEARNING_FILE_TYPES.audio as readonly string[]).includes(file.mimetype);
    const max = media ? LEARNING_MEDIA_MAX_BYTES : LEARNING_FILE_MAX_BYTES;
    if (file.size <= 0 || file.size > max) throw Errors.badRequest('file_too_large', media ? 'Videos and audio can be up to 50 MB. For longer videos, use a link to where it is hosted.' : 'Files can be up to 25 MB');
    if (!contentMatches(file.mimetype, file.buffer.subarray(0, 512))) throw Errors.badRequest('content_mismatch', 'The file content does not match its type');
    const actor = requestContext.tenantActor();
    const employeeId = await this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      if (purpose === 'content' && !(a.has('create') || a.has('edit'))) throw Errors.forbiddenCode('learning_permission', 'You cannot add learning content.');
      if (purpose === 'submission' && !a.subject.employeeId) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet. Ask HR to link it.');
      return purpose === 'submission' ? a.subject.employeeId! : null;
    });
    const key = this.storage.newKey(actor.tenantId);
    await this.storage.put(key, file.buffer, { upload: true });
    try {
      return await this.db.tenant(async (tx) => {
        const row = await tx.collection('learning_files').insert({
          name: safeFileName(file.originalname, 'file').slice(0, 200), type: file.mimetype, size: file.size, storage_key: key, purpose, employee_id: employeeId,
          sha256: createHash('sha256').update(file.buffer).digest('hex'), uploaded_by_membership_id: actor.membershipId,
        });
        return { id: row.id as string, name: row.name as string, type: file.mimetype, size: file.size };
      });
    } catch (err) {
      await this.storage.remove(key);
      throw err;
    }
  }

  /** A short signed link to a learning file, after checking the caller may see it. */
  link(id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      const f = await tx.collection('learning_files').findOne({ id });
      if (!f) throw Errors.notFound('File');
      let ok = f.uploaded_by_membership_id === a.subject.membershipId;
      if (!ok && f.purpose === 'submission') {
        const e = f.employee_id ? await tx.collection('employees').findOne({ id: f.employee_id }) : undefined;
        ok = !!e && (e.id === a.subject.employeeId || a.covers('grade', e) || a.covers('view', e));
      }
      if (!ok && f.purpose === 'content') {
        ok = a.has('view');
        if (!ok && a.subject.employeeId) {
          const versionIds = await tx.collection('course_assignments').distinct<string>('version_id', { employee_id: a.subject.employeeId, status: { $ne: 'cancelled' } });
          ok = await tx.collection('learning_module_versions').exists({
            id: { $in: versionIds },
            $or: [{ 'blocks.source.fileId': id }, { 'blocks.coverFileId': id }, { 'blocks.attachmentFileIds': id }, { 'blocks.settings.referenceFileIds': id }],
          });
          // Covers of modules open to everyone in the library.
          if (!ok) ok = await tx.collection('courses').exists({ cover_file_id: id, status: 'published' });
        }
      }
      if (!ok) throw Errors.notFound('File');
      return this.storage.sign(id, 600, 'learning');
    });
  }

  async open(id: string, exp: number, sig: string) {
    if (!this.storage.verify(id, exp, sig, 'learning')) throw Errors.notFound('File');
    const f = await this.db.platform((tx) => tx.collection<{ storage_key: string; name: string; type: string; size: number }>('learning_files').findOne({ id }));
    if (!f) throw Errors.notFound('File');
    return { key: f.storage_key, fileName: f.name, contentType: f.type, size: f.size };
  }

  openRange(key: string, start?: number, end?: number) {
    return this.storage.open(key, start === undefined ? undefined : { start, end });
  }

  // Modules -------------------------------------------------------------------------------------------------------

  private async stats(tx: TenantTx, ids: string[], peopleFilter: Doc) {
    const people = await tx.collection('employees').distinct<string>('id', peopleFilter);
    const rows = await tx.collection('course_assignments').find({ course_id: { $in: ids }, employee_id: { $in: people }, status: { $ne: 'cancelled' } }, { projection: { course_id: 1, status: 1 } });
    const out = new Map<string, { assigned: number; completed: number }>();
    for (const r of rows) {
      const s = out.get(r.course_id) ?? { assigned: 0, completed: 0 };
      s.assigned++;
      if (r.status === 'completed') s.completed++;
      out.set(r.course_id, s);
    }
    return out;
  }

  private async summary(tx: TenantTx, c: Doc, a: LearningAccess, stats?: { assigned: number; completed: number }) {
    const blocks = parseBlocks(c.blocks);
    return {
      id: c.id as string, title: c.title as string, shortDescription: (c.short_description as string) || (c.description as string)?.slice(0, 200) || '', category: c.category as string,
      topic: c.topic as string, skills: (c.skill_names as string[]) ?? [], difficulty: c.difficulty as string, customDifficulty: (c.custom_difficulty as string | null) ?? null,
      durationMinutes: (c.duration_minutes as number | null) ?? null, format: c.format as string, status: c.status as string, version: c.version as number,
      unpublishedChanges: !!c.unpublished_changes, publishedAt: c.published_at ?? null, publishAt: c.publish_at ?? null, coverFileId: (c.cover_file_id as string | null) ?? null,
      tags: (c.tags as string[]) ?? [], language: c.language as string, selfEnrol: !!c.self_enrol, certificate: !!c.certificate,
      creator: await creatorOf(tx, c), createdAt: c.created_at, contentKinds: [...new Set(blocks.map((b) => b.kind))], blockCount: blocks.length,
      assigned: stats?.assigned ?? 0, completed: stats?.completed ?? 0, completionRate: stats?.assigned ? Math.round((stats.completed / stats.assigned) * 100) : null,
      can: { edit: c.status !== 'archived' && a.canOnModule('edit', c), publish: a.canOnModule('publish', c), assign: c.status === 'published' && a.has('assign') },
    };
  }

  /** The library: every module for the Super Workspace; for an HR Workspace its own modules and every published one. */
  library(q: { q?: string; status: string; category?: string; skill?: string; difficulty?: string; format?: string }) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('view');
      const filter: Doc = {};
      if (!a.isSuper) {
        const keys = a.scopes.map((s) => s.key);
        filter.$or = [{ status: { $in: ['published', 'archived'] } }, { creator_level: 'hr', owner_hr_workspace_id: { $in: keys.filter((k) => k !== CENTRAL) } }, ...(keys.includes(CENTRAL) ? [{ creator_level: 'hr', owner_hr_workspace_id: null }] : [])];
      }
      if (q.status !== 'all') filter.status = q.status;
      if (q.category) filter.category = q.category;
      if (q.skill) filter.skill_names = q.skill;
      if (q.difficulty) filter.difficulty = q.difficulty;
      if (q.format) filter.format = q.format;
      let rows = await tx.collection('courses').find(filter);
      if (q.q) {
        const needle = q.q.toLowerCase();
        rows = rows.filter((c) => [c.title, c.short_description, c.description, c.topic, c.category, ...(c.skill_names ?? []), ...(c.tags ?? []), c.creator_name].some((x) => String(x ?? '').toLowerCase().includes(needle)));
      }
      rows.sort((x, y) => Number(x.status === 'archived') - Number(y.status === 'archived') || new Date(y.updated_at).getTime() - new Date(x.updated_at).getTime());
      const stats = await this.stats(tx, rows.map((r) => r.id), a.peopleFilter('view'));
      return Promise.all(rows.slice(0, 500).map((c) => this.summary(tx, c, a, stats.get(c.id))));
    });
  }

  private async loadModule(tx: TenantTx, id: string, a: LearningAccess) {
    const c = await tx.collection('courses').findOne({ id });
    // HR sees its own modules and published ones; anything else is reported as missing.
    if (!c || !(a.isSuper || ['published', 'archived'].includes(c.status) || a.canOnModule('view', c))) throw Errors.notFound('Learning module');
    return c;
  }

  module(id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('view');
      const c = await this.loadModule(tx, id, a);
      const stats = (await this.stats(tx, [id], a.peopleFilter('view'))).get(id);
      const versions = await tx.collection('learning_module_versions').find({ course_id: id }, { sort: { version: -1 }, projection: { version: 1, note: 1, created_at: 1, published_by_membership_id: 1, title: 1 } });
      const audiences = await tx.collection('learning_audiences').find({ course_id: id }, { sort: { created_at: -1 } });
      const canEdit = a.canOnModule('edit', c);
      return {
        ...(await this.summary(tx, c, a, stats)),
        description: c.description as string, customDifficulty: c.custom_difficulty ?? '', creatorName: c.creator_name ?? '', creatorDesignation: c.creator_designation ?? '',
        defaultDueDays: c.default_due_days ?? null, hrWorkspaceId: c.owner_hr_workspace_id ?? null,
        // Answers and marking schemes only for people who may edit the module.
        blocks: canEdit || a.isSuper ? parseBlocks(c.blocks) : [],
        versions: versions.map((v) => ({ version: v.version as number, note: v.note as string, publishedAt: v.created_at, title: v.title as string })),
        audiences: await Promise.all(audiences.map(async (x) => ({ id: x.id as string, description: await describeAudience(tx, learningAudience.parse(x.audience)), dueOn: x.due_on ?? null, keepEnrolling: !!x.keep_enrolling, active: !!x.active, enrolled: x.enrolled as number, createdAt: x.created_at }))),
      };
    });
  }

  /** Checks the content against the caller's powers and the files it names, and records new skill names. */
  private async checkContent(tx: TenantTx, a: LearningAccess, input: LearningModuleInput, ownerKey: string | null) {
    const issues = blockIssues(input.blocks);
    if (issues.length) throw Errors.validation(issues);
    const has = (cap: LearningCap) => a.isSuper || a.scopes.some((s) => s.key === (ownerKey ?? CENTRAL) && s.caps.has(cap));
    if (input.blocks.some((b) => b.kind === 'quiz') && !has('quiz')) throw Errors.forbiddenCode('learning_permission', 'Your Super Workspace has not let you create quizzes.');
    if (input.blocks.some((b) => b.kind === 'assignment') && !has('assignment')) throw Errors.forbiddenCode('learning_permission', 'Your Super Workspace has not let you create assignments.');
    const ids = [...blockFileIds(input.blocks), ...(input.coverFileId ? [input.coverFileId] : [])];
    if (ids.length && (await tx.collection('learning_files').count({ id: { $in: ids }, purpose: 'content' })) !== new Set(ids).size) throw Errors.badRequest('unknown_file', 'A file is missing. Upload it again.');
    for (const name of input.skills) {
      if (!(await tx.collection('skills').exists({ name: ieq(name) }))) await tx.collection('skills').insert({ name, category: null });
    }
  }

  private fields(input: LearningModuleInput) {
    return {
      title: input.title, short_description: input.shortDescription, description: input.description, category: input.category, topic: input.topic,
      skill_names: [...new Set(input.skills)], difficulty: input.difficulty, custom_difficulty: input.difficulty === 'custom' ? input.customDifficulty || null : null,
      duration_minutes: input.durationMinutes, creator_name: input.creatorName, creator_designation: input.creatorDesignation || null, cover_file_id: input.coverFileId,
      tags: [...new Set(input.tags)], language: input.language, self_enrol: input.selfEnrol, certificate: input.certificate, default_due_days: input.defaultDueDays,
      // Rich text keeps only safe formatting, so it can be shown to learners as it was written.
      blocks: input.blocks.map((b) => (b.kind === 'text' ? { ...b, body: safeHtml(b.body) } : b)), format: formatOf(input.blocks),
    };
  }

  private async titleFree(tx: TenantTx, title: string, except?: string) {
    if (await tx.collection('courses').exists({ title: ieq(title), archived_at: null, ...(except ? { id: { $ne: except } } : {}) })) {
      throw Errors.validation([{ path: 'title', message: 'Another learning module already has this title' }]);
    }
  }

  createModule(input: LearningModuleInput) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('create');
      let ownerKey: string | null = null;
      if (!a.isSuper) {
        const scopes = a.scopesWith('create');
        const chosen = input.hrWorkspaceId ? scopes.find((s) => s.key === input.hrWorkspaceId) : scopes.length === 1 ? scopes[0] : scopes.find((s) => s.key === CENTRAL) ?? scopes[0];
        if (!chosen) throw Errors.forbiddenCode('learning_permission', 'You cannot create learning modules for that HR Workspace.');
        ownerKey = chosen.key;
      }
      await this.checkContent(tx, a, input, ownerKey);
      await this.titleFree(tx, input.title);
      const r = await tx.collection('courses').insert({
        ...this.fields(input), status: 'draft', version: 0, creator_level: a.isSuper ? 'super' : 'hr', owner_hr_workspace_id: ownerKey && ownerKey !== CENTRAL ? ownerKey : null,
        created_by_membership_id: a.subject.membershipId, updated_by_membership_id: a.subject.membershipId, validity_months: null,
      });
      await this.audit.record(tx, { action: 'learning_module.created', resourceType: 'course', resourceId: r.id, metadata: { title: input.title, blocks: input.blocks.length } });
      return { id: r.id as string };
    });
  }

  updateModule(id: string, input: LearningModuleInput) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      const c = await this.loadModule(tx, id, a);
      if (!a.canOnModule('edit', c)) throw Errors.forbiddenCode('learning_permission', c.creator_level === 'super' ? 'Only the Super Workspace edits its learning modules.' : 'Your Super Workspace has not let you edit learning modules.');
      if (c.status === 'archived') throw Errors.conflict('archived', 'Restore the module before changing it');
      await this.checkContent(tx, a, input, c.creator_level === 'hr' ? (c.owner_hr_workspace_id ?? CENTRAL) : null);
      await this.titleFree(tx, input.title, id);
      const set = { ...this.fields(input), updated_by_membership_id: a.subject.membershipId, unpublished_changes: (c.version as number) > 0 };
      await tx.collection('courses').updateOne({ id }, { $set: set });
      await this.audit.record(tx, { action: 'learning_module.updated', resourceType: 'course', resourceId: id, metadata: { title: input.title, blocks: input.blocks.length, publishedVersion: c.version } });
      return { id, unpublishedChanges: set.unpublished_changes };
    });
  }

  /** Freezes the working copy as the next version and makes it the one new learners get. */
  private async publishNow(tx: TenantTx, c: Doc, by: string | null, note: string) {
    const blocks = parseBlocks(c.blocks);
    const version = ((c.version as number) ?? 0) + 1;
    const v = await tx.collection('learning_module_versions').insert({ course_id: c.id, version, title: c.title, description: c.description ?? '', duration_minutes: c.duration_minutes ?? null, blocks, note, published_by_membership_id: by });
    await tx.collection('courses').updateOne({ id: c.id }, {
      $set: { status: 'published', version, published_version_id: v.id, published_at: new Date(), published_by_membership_id: by, publish_at: null, unpublished_changes: false, archived_at: null, format: formatOf(blocks) },
    });
    await this.audit.record(tx, { action: 'learning_module.published', resourceType: 'course', resourceId: c.id, metadata: { version, note } });
    return { version };
  }

  publish(id: string, publishAt: string | null, note: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      const c = await this.loadModule(tx, id, a);
      if (!a.canOnModule('publish', c)) throw Errors.forbiddenCode('learning_permission', c.creator_level === 'super' ? 'Only the Super Workspace publishes its learning modules.' : 'Your Super Workspace has not let you publish learning modules.');
      if (c.status === 'archived') throw Errors.conflict('archived', 'Restore the module before publishing it');
      if (!parseBlocks(c.blocks).length) throw Errors.badRequest('no_content', 'Add at least one content item before publishing');
      if (c.status === 'published' && !c.unpublished_changes) throw Errors.conflict('no_changes', 'There are no changes to publish');
      if (publishAt && new Date(publishAt).getTime() > Date.now() + 60_000) {
        if (c.status === 'published') throw Errors.badRequest('already_published', 'Changes to a published module are published straight away');
        await tx.collection('courses').updateOne({ id }, { $set: { status: 'scheduled', publish_at: new Date(publishAt), scheduled_by_membership_id: a.subject.membershipId } });
        await this.audit.record(tx, { action: 'learning_module.scheduled', resourceType: 'course', resourceId: id, metadata: { publishAt } });
        return { status: 'scheduled', publishAt };
      }
      const r = await this.publishNow(tx, c, a.subject.membershipId, note || (c.version ? 'Changes published' : 'First version'));
      return { status: 'published', version: r.version };
    });
  }

  /** Back to draft: a scheduled module that should not go out yet. */
  unschedule(id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      const c = await this.loadModule(tx, id, a);
      if (!a.canOnModule('publish', c)) throw Errors.forbiddenCode('learning_permission', 'You cannot change when this module is published.');
      if (c.status !== 'scheduled') throw Errors.conflict('invalid_state', 'This module is not scheduled');
      await tx.collection('courses').updateOne({ id, status: 'scheduled' }, { $set: { status: 'draft', publish_at: null } });
      await this.audit.record(tx, { action: 'learning_module.unscheduled', resourceType: 'course', resourceId: id });
      return { status: 'draft' };
    });
  }

  archive(id: string, restore = false) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      const c = await this.loadModule(tx, id, a);
      if (!a.canOnModule('publish', c)) throw Errors.forbiddenCode('learning_permission', 'You cannot archive this module.');
      if (restore) {
        if (c.status !== 'archived') throw Errors.conflict('invalid_state', 'This module is not archived');
        await this.titleFree(tx, c.title, id);
        const status = c.version ? 'published' : 'draft';
        await tx.collection('courses').updateOne({ id }, { $set: { status, archived_at: null } });
        await this.audit.record(tx, { action: 'learning_module.restored', resourceType: 'course', resourceId: id });
        return { status };
      }
      if (c.status === 'archived') throw Errors.conflict('invalid_state', 'This module is already archived');
      // People keep their records and can finish what they started; nobody new is enrolled.
      await tx.collection('courses').updateOne({ id }, { $set: { status: 'archived', archived_at: new Date(), publish_at: null } });
      await tx.collection('learning_audiences').update({ course_id: id, active: true }, { $set: { active: false } });
      await this.audit.record(tx, { action: 'learning_module.archived', resourceType: 'course', resourceId: id });
      return { status: 'archived' };
    });
  }

  // Assigning ----------------------------------------------------------------------------------------------------

  /**
   * Enrols the people an audience reaches (within `access`, or everyone for the Super Workspace / a null access in
   * jobs run for the Super Workspace). People with the module open, or finished on its current version, are skipped.
   */
  private async enrol(tx: TenantTx, c: Doc, audience: LearningAudience, access: LearningAccess | null, opts: { dueOn: string | null; audienceId: string | null; by: string | null; quiet: boolean; strict: boolean }) {
    if (access && !access.isSuper && opts.strict) {
      // Naming people or HR Workspaces outside one's reach is refused, not quietly narrowed.
      if (audience.all && !access.scopesWith('assign').some((s) => s.key === CENTRAL)) throw Errors.forbiddenCode('learning_scope', 'You can only assign learning to the people your HR Workspace looks after. Choose your HR Workspace or people in it.');
      const allowedSpaces = new Set(access.scopesWith('assign').map((s) => s.key));
      if (audience.hrWorkspaceIds.some((x) => !allowedSpaces.has(x))) throw Errors.forbiddenCode('learning_scope', 'You can only assign learning to your own HR Workspace.');
      if (audience.central && !allowedSpaces.has(CENTRAL)) throw Errors.forbiddenCode('learning_scope', 'You cannot assign learning to the central group.');
      if (audience.employeeIds.length) {
        const named = await tx.collection('employees').find({ id: { $in: audience.employeeIds } });
        if (named.length !== new Set(audience.employeeIds).size || named.some((e) => !access.covers('assign', e))) throw Errors.forbiddenCode('learning_scope', 'One of the people chosen is outside the HR Workspace you look after.');
      }
    }
    const reached = (await resolveAudience(tx, audience)).filter((e) => !access || access.covers('assign', e));
    const table = tx.collection('course_assignments');
    let enrolled = 0;
    let already = 0;
    const now = today();
    const due = opts.dueOn ?? (c.default_due_days ? addDays(now, c.default_due_days) : null);
    const notify: string[] = [];
    for (const e of reached) {
      if (await table.exists({ employee_id: e.id, course_id: c.id, $or: [{ status: { $in: OPEN } }, { status: 'completed', version: c.version }] })) {
        already++;
        continue;
      }
      await table.insert({
        employee_id: e.id, course_id: c.id, source: opts.audienceId ? 'audience' : 'assigned', assigned_by_membership_id: opts.by, due_on: due,
        version: c.version, version_id: c.published_version_id, audience_assignment_id: opts.audienceId,
      });
      enrolled++;
      if (e.membership_id) notify.push(e.membership_id);
    }
    if (notify.length) {
      const creator = await creatorOf(tx, c);
      await this.notifications.notify(tx, {
        membershipIds: notify, kind: 'learning.assigned', title: `New learning assigned: ${c.title}${due ? `, due ${due}` : ''}`,
        body: `From ${[creator.name, creator.workspace].filter(Boolean).join(', ')}`, link: '/learning', actorMembershipId: opts.by,
      });
    }
    if (opts.audienceId && enrolled) await tx.collection('learning_audiences').updateOne({ id: opts.audienceId }, { $inc: { enrolled } });
    return { enrolled, alreadyEnrolled: already, reached: reached.length };
  }

  assign(id: string, input: AssignModuleInput) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('assign');
      const c = await this.loadModule(tx, id, a);
      if (c.status !== 'published') throw Errors.conflict('not_published', 'Publish the module before assigning it');
      if (audienceIsEmpty(input.audience)) throw Errors.validation([{ path: 'audience', message: 'Choose who should receive this learning' }]);
      if (input.dueOn && input.dueOn < today()) throw Errors.validation([{ path: 'dueOn', message: 'The due date cannot be in the past' }]);
      const aud = await tx.collection('learning_audiences').insert({
        course_id: id, audience: input.audience, due_on: input.dueOn, keep_enrolling: input.keepEnrolling, assigned_by_membership_id: a.subject.membershipId, scope: a.scopeKeys('assign'),
      });
      const r = await this.enrol(tx, c, input.audience, a, { dueOn: input.dueOn, audienceId: aud.id, by: a.subject.membershipId, quiet: false, strict: true });
      await this.audit.record(tx, { action: 'learning.assigned', resourceType: 'course', resourceId: id, metadata: { ...r, dueOn: input.dueOn, keepEnrolling: input.keepEnrolling, audience: await describeAudience(tx, input.audience) } });
      return { ...r, audience: await describeAudience(tx, input.audience) };
    });
  }

  stopAudience(moduleId: string, audienceId: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('assign');
      const aud = await tx.collection('learning_audiences').findOne({ id: audienceId, course_id: moduleId });
      if (!aud) throw Errors.notFound('Assignment');
      if (!a.isSuper && !(aud.scope as string[]).every((k) => a.scopesWith('assign').some((s) => s.key === k))) throw Errors.forbidden('Only who assigned it, or the Super Workspace, can change this');
      await tx.collection('learning_audiences').updateOne({ id: audienceId }, { $set: { keep_enrolling: false } });
      await this.audit.record(tx, { action: 'learning.audience_stopped', resourceType: 'course', resourceId: moduleId, metadata: { audienceId } });
    });
  }

  /** Removes one person's open enrolment (their history stays). */
  cancelEnrolment(id: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('assign');
      const row = await tx.collection('course_assignments').findOne({ id });
      const e = row && (await tx.collection('employees').findOne({ id: row.employee_id }));
      if (!row || !e || !a.covers('assign', e)) throw Errors.notFound('Enrolment');
      if (!OPEN.includes(row.status)) throw Errors.conflict('invalid_state', 'Only learning that is not finished can be removed');
      await tx.collection('course_assignments').updateOne({ id }, { $set: { status: 'cancelled', cancelled_reason: reason } });
      await this.audit.record(tx, { action: 'learning.cancelled', resourceType: 'course_assignment', resourceId: id, metadata: { reason } });
      return { status: 'cancelled' };
    });
  }
}

export { num };
