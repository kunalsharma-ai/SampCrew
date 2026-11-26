import { randomBytes } from 'node:crypto';
import {
  certificateNumber, contentBlock, type ContentBlock, dueState, learnerStatus, type LearningAudience, moduleProgress, moduleScore, type BlockState,
} from '@crew/contracts';
import type { TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import type { NotificationService } from '../../platform/notify/notification.service';
import { displayName } from '../employees/employee-view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any>;

export const CURRENT = ['pre_boarding', 'probation', 'active', 'notice'];
export const OPEN = ['assigned', 'in_progress'];
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

/** Blocks as saved (parsed again, so older shapes get the current defaults). */
export function parseBlocks(raw: unknown): ContentBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((b) => contentBlock.parse(b));
}

/** The published version an enrolment uses (its own, or the module's current one). */
export async function versionOf(tx: TenantTx, a: Doc): Promise<{ id: string | null; version: number; blocks: ContentBlock[]; title: string }> {
  const v = a.version_id ? await tx.collection('learning_module_versions').findOne({ id: a.version_id }) : undefined;
  const c = await tx.collection('courses').findOne({ id: a.course_id });
  if (v) {
    // A learner keeps the version they were assigned, but links follow the published module (issue #89): when HR
    // corrects a link, "Open the resource" opens the link HR gave now, not the one at the time of assignment.
    const pinned = parseBlocks(v.blocks);
    const latest = c?.published_version_id && c.published_version_id !== v.id ? await tx.collection('learning_module_versions').findOne({ id: c.published_version_id }) : undefined;
    return { id: v.id, version: v.version, blocks: latest ? withLatestLinks(pinned, parseBlocks(latest.blocks)) : pinned, title: v.title };
  }
  const cv = c?.published_version_id ? await tx.collection('learning_module_versions').findOne({ id: c.published_version_id }) : undefined;
  if (cv) return { id: cv.id, version: cv.version, blocks: parseBlocks(cv.blocks), title: cv.title };
  return { id: null, version: c?.version ?? 1, blocks: parseBlocks(c?.blocks ?? []), title: c?.title ?? '' };
}

/** Who the module is from, as every learner and admin screen shows it. */
export async function creatorOf(tx: TenantTx, c: Doc) {
  const ws = c.owner_hr_workspace_id ? await tx.collection('hr_workspaces').findOne({ id: c.owner_hr_workspace_id }, { projection: { name: 1 } }) : undefined;
  const workspace = c.creator_level === 'hr' ? (ws ? `${ws.name as string} HR Workspace` : 'HR Workspace') : 'Super Workspace';
  return { name: (c.creator_name as string | null) ?? null, designation: (c.creator_designation as string | null) ?? null, workspace, level: c.creator_level as 'super' | 'hr' };
}

/** Current employees an audience reaches, before any limit of the person assigning. */
export async function resolveAudience(tx: TenantTx, a: LearningAudience): Promise<Doc[]> {
  const base = { status: { $in: CURRENT } };
  if (a.all) return tx.collection('employees').find(base);
  const or: Doc[] = [];
  if (a.employeeIds.length) or.push({ id: { $in: a.employeeIds } });
  if (a.hrWorkspaceIds.length) or.push({ hr_workspace_id: { $in: a.hrWorkspaceIds } });
  if (a.central) or.push({ hr_workspace_id: null });
  if (a.departmentIds.length) {
    const depts = await tx.collection('departments').find({}, { projection: { parent_id: 1 } });
    const children = new Map<string, string[]>();
    for (const d of depts) if (d.parent_id) children.set(d.parent_id, [...(children.get(d.parent_id) ?? []), d.id]);
    const all = new Set(a.departmentIds);
    for (let f = [...a.departmentIds]; f.length; ) f = f.flatMap((x) => children.get(x) ?? []).filter((x) => !all.has(x) && !!all.add(x));
    or.push({ current_department_id: { $in: [...all] } });
  }
  if (a.designationIds.length) or.push({ current_designation_id: { $in: a.designationIds } });
  if (a.locationIds.length) or.push({ current_location_id: { $in: a.locationIds } });
  if (a.employmentTypes.length) or.push({ employment_type: { $in: a.employmentTypes } });
  if (!or.length) return [];
  return tx.collection('employees').find({ ...base, $or: or });
}

/** People, groups and places named in an audience, for the screens ("Everyone", "Delhi HR and 3 people"). */
export async function describeAudience(tx: TenantTx, a: LearningAudience): Promise<string> {
  if (a.all) return 'All employees';
  const parts: string[] = [];
  const names = async (table: string, ids: string[]) => (ids.length ? (await tx.collection(table).find({ id: { $in: ids } }, { projection: { name: 1 } })).map((d) => d.name as string) : []);
  parts.push(...(await names('hr_workspaces', a.hrWorkspaceIds)).map((n) => `${n} HR Workspace`));
  if (a.central) parts.push('Central group');
  parts.push(...(await names('departments', a.departmentIds)));
  parts.push(...(await names('designations', a.designationIds)));
  parts.push(...(await names('locations', a.locationIds)));
  parts.push(...a.employmentTypes.map((t) => t.replace('_', ' ')));
  if (a.employeeIds.length) parts.push(a.employeeIds.length === 1 ? '1 person' : `${a.employeeIds.length} people`);
  if (!parts.length) return 'Nobody';
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** Placement of employees (names, workspace, department, job role) for tables. */
export async function placements(tx: TenantTx, ids: string[]) {
  const people = await tx.collection('employees').find({ id: { $in: [...new Set(ids)] } });
  const ref = async (table: string, field: string) => new Map((await tx.collection(table).find({ id: { $in: [...new Set(people.map((p) => p[field]).filter(Boolean))] } }, { projection: { name: 1 } })).map((d) => [d.id as string, d.name as string]));
  const [depts, desigs, spaces] = await Promise.all([ref('departments', 'current_department_id'), ref('designations', 'current_designation_id'), ref('hr_workspaces', 'hr_workspace_id')]);
  return new Map(people.map((e) => [e.id as string, {
    id: e.id as string, name: displayName(e as never), code: e.employee_code as string, membershipId: (e.membership_id as string | null) ?? null, status: e.status as string,
    department: depts.get(e.current_department_id) ?? null, departmentId: (e.current_department_id as string | null) ?? null,
    designation: desigs.get(e.current_designation_id) ?? null, designationId: (e.current_designation_id as string | null) ?? null,
    hrWorkspaceId: (e.hr_workspace_id as string | null) ?? null, hrWorkspace: e.hr_workspace_id ? (spaces.get(e.hr_workspace_id) ?? null) : null,
    doc: e,
  }]));
}

/** An enrolment row as management tables show it. */
export function enrolmentRow(a: Doc, course: Doc | undefined, p: Doc | undefined, now = today()) {
  const status = learnerStatus(a.status, a.due_on, now);
  return {
    id: a.id as string, moduleId: a.course_id as string, moduleTitle: (course?.title as string) ?? '', version: (a.version as number | null) ?? 1,
    employeeId: a.employee_id as string, employeeName: (p?.name as string) ?? '', employeeCode: (p?.code as string) ?? '',
    hrWorkspace: (p?.hrWorkspace as string | null) ?? null, hrWorkspaceId: (p?.hrWorkspaceId as string | null) ?? null,
    department: (p?.department as string | null) ?? null, designation: (p?.designation as string | null) ?? null,
    status, rawStatus: a.status as string, progressPercent: (a.progress_percent as number) ?? 0, scorePercent: num(a.score_percent), passed: (a.passed as boolean | null) ?? null,
    dueOn: (a.due_on as string | null) ?? null, due: dueState(a.due_on, now, a.status === 'completed'),
    assignedOn: a.created_at ? new Date(a.created_at).toISOString().slice(0, 10) : null, completedOn: (a.completed_on as string | null) ?? null,
    completedAt: a.completed_at ? new Date(a.completed_at).toISOString() : null, timeSpentMinutes: Math.round(((a.time_spent_seconds as number) ?? 0) / 60),
    certificateNo: (a.certificate_no as string | null) ?? null, source: a.source as string,
  };
}
export type EnrolmentRow = ReturnType<typeof enrolmentRow>;

/**
 * Works out an enrolment's progress, score and status from its records and saves them; completes it when every
 * required item is done (with a certificate when the module issues one) and tells the learner.
 */
export async function recompute(tx: TenantTx, notifications: NotificationService, a: Doc, extra: Doc = {}): Promise<Doc> {
  const v = await versionOf(tx, a);
  const state = { ...(a.progress ?? {}), ...(extra.progress ?? {}) } as Record<string, BlockState>;
  const scores: Record<string, number | null> = {};
  for (const b of v.blocks.filter((x) => x.kind === 'assignment')) {
    const last = await tx.collection('learning_submissions').findOne({ assignment_id: a.id, block_id: b.id }, { sort: { created_at: -1 } });
    scores[b.id] = last?.status === 'approved' ? num(last.score) : null;
  }
  const p = moduleProgress(v.blocks, state);
  const score = moduleScore(v.blocks, state, scores);
  const quizzes = v.blocks.filter((b) => b.kind === 'quiz' && b.required);
  const passed = quizzes.length ? quizzes.every((q) => state[q.id]?.passed === true) : p.complete ? true : null;
  const set: Doc = { ...extra, progress: state, progress_percent: p.percent, score_percent: score, passed: quizzes.some((q) => state[q.id]?.passed === false) && !p.complete ? false : passed, last_activity_at: new Date() };
  if (a.status === 'assigned') { set.status = 'in_progress'; set.started_at = a.started_at ?? new Date(); }
  let completed = false;
  if (p.complete && OPEN.includes(a.status)) {
    const c = await tx.collection('courses').findOne({ id: a.course_id });
    const on = today();
    Object.assign(set, {
      status: 'completed', completed_on: on, completed_at: new Date(), started_at: a.started_at ?? new Date(),
      expires_on: c?.validity_months ? addMonthsIso(on, c.validity_months) : null,
      certificate_no: c?.certificate ? certificateNumber(new Date().getUTCFullYear(), randomBytes(6).toString('hex')) : null,
    });
    completed = true;
  }
  await tx.collection('course_assignments').updateOne({ id: a.id, status: { $in: OPEN } }, { $set: set });
  if (completed) {
    const e = await tx.collection('employees').findOne({ id: a.employee_id }, { projection: { membership_id: 1 } });
    if (e?.membership_id) {
      await notifications.notify(tx, {
        membershipIds: [e.membership_id], kind: 'learning.completed', title: `You completed ${v.title}${score !== null ? ` with ${score}%` : ''}`,
        link: `/learning/my/${a.id}`, resource: { type: 'course_assignment', id: a.id },
      });
    }
  }
  return { ...a, ...set };
}

function addMonthsIso(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** The learner's own open or finished enrolment, or a 404 for anyone else (the same answer as a missing one). */
export async function ownEnrolment(tx: TenantTx, id: string, employeeId: string | null | undefined): Promise<Doc> {
  const a = await tx.collection('course_assignments').findOne({ id });
  if (!a || !employeeId || a.employee_id !== employeeId || a.status === 'cancelled') throw Errors.notFound('Learning');
  return a;
}

/** The pinned blocks with each link (external URL, linked video, audio or document) taken from the same block now. */
export function withLatestLinks(pinned: ContentBlock[], latest: ContentBlock[]): ContentBlock[] {
  const now = new Map(latest.map((b) => [b.id, b]));
  return pinned.map((b) => {
    const n = now.get(b.id);
    if (!n || n.kind !== b.kind) return b;
    if (b.kind === 'external' && n.kind === 'external') return { ...b, url: n.url };
    if ('source' in b && 'source' in n && b.source?.type === 'url' && n.source?.type === 'url') return { ...b, source: n.source } as ContentBlock;
    return b;
  });
}
