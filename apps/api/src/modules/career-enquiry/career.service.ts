import { Injectable } from '@nestjs/common';
import {
  CAREER_CALL_OUTCOMES, CAREER_CAPS, CAREER_CENTRAL, CAREER_INTERVIEW_TYPES, CAREER_SUMMARY_CARDS, CAREER_TARGET_FIELDS, careerLabel, experienceShown, type CareerCallInput,
  type CareerInterviewInput, type CareerListQuery, type CareerStage,
} from '@crew/contracts';
import type { z } from 'zod';
import type { careerAssignInput, careerEmailInput, careerFollowUpInput, careerInterviewUpdate, careerNoteInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { ilike, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { StorageService } from '../../platform/storage/storage.service';
import { crmSettings, recordActivity, refreshNextFollowUp, stagesOf } from '../candidate-crm/crm-common';
import { type CareerActor, CareerAccessService } from './career-access.service';
import { careerEvent, careerSettings, careerStagesOf, crmTimeline, type Doc, namesOf } from './career-common';
import { CareerCrmService } from './career-crm.service';
import { CareerSyncService } from './career-sync.service';

const CRM_STAGE_FOR: Record<string, string> = {
  new_application: 'new', under_review: 'screening', shortlisted: 'shortlisted', contacted: 'contacted', interview_scheduled: 'interview_scheduled',
  interview_completed: 'interview_completed', selected: 'selected', offer_sent: 'offer_released', offer_accepted: 'offer_accepted', joined: 'joined', rejected: 'rejected', on_hold: 'on_hold',
};
const DAY = 86_400_000;
const csvCell = (v: unknown) => {
  let t = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/**
 * Career Enquiry: the dashboard, the applications list and pipeline, the candidate profile with CV, calls, emails,
 * notes, follow-ups and interviews, and Move to Candidate CRM. Every read and change goes through the person's
 * Career Enquiry access, and every change is in the application's history and the audit log.
 */
@Injectable()
export class CareerService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: CareerAccessService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
    private readonly sync: CareerSyncService,
    private readonly crm: CareerCrmService,
  ) {}

  // ------------------------------------------------------------------------------------------------------------
  // Reading
  // ------------------------------------------------------------------------------------------------------------

  async context() {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const spaces = await tx.collection('hr_workspaces').find({ status: 'active' }, { projection: { name: 1 }, sort: { name: 1 } });
      const names = new Map(spaces.map((w) => [w.id as string, w.name as string]));
      const integ = await tx.collection('career_integrations').findOne({}, { projection: { website_name: 1, website_url: 1, enabled: 1, api_key_hash: 1, last_received_at: 1, last_error: 1, last_error_at: 1, last_success_at: 1 } });
      return {
        level: a.level,
        caps: CAREER_CAPS.filter((c) => this.access.has(a, c)),
        canManage: a.canManage,
        canConfigure: a.level === 'super',
        workspaces: a.keys.map((k) => ({ key: k, name: k === CAREER_CENTRAL ? (a.level === 'super' ? 'Super Workspace' : 'Company-wide HR') : names.get(k) ?? 'HR Workspace', scope: a.scope.get(k) ?? 'all' })),
        stages: careerStagesOf(await careerSettings(tx)),
        assignees: await this.access.assignees(tx, a),
        hrWorkspaces: a.level === 'super' ? spaces.map((w) => ({ id: w.id as string, name: w.name as string })) : [],
        integration: integ ? {
          websiteName: integ.website_name, websiteUrl: integ.website_url, enabled: integ.enabled, connected: !!integ.api_key_hash,
          lastReceivedAt: integ.last_received_at ?? null, lastSuccessAt: integ.last_success_at ?? null, lastError: integ.last_error ?? null, lastErrorAt: integ.last_error_at ?? null,
        } : null,
      };
    });
  }

  /** The list filter inside what the person may see. */
  private async filterFor(tx: TenantTx, a: CareerActor, q: Partial<CareerListQuery>): Promise<Doc> {
    const and: Doc[] = [this.access.filter(a)];
    if (q.stage) and.push({ stage: q.stage });
    if (q.position) and.push({ position: ilike(q.position) });
    if (q.department) and.push({ department: ilike(q.department) });
    if (q.kind) and.push({ kind: q.kind });
    if (q.assigned === 'me') and.push({ $or: [{ assigned_hr_membership_id: a.membershipId }, { assigned_recruiter_membership_id: a.membershipId }] });
    if (q.assigned === 'none') and.push({ assigned_hr_membership_id: null, assigned_recruiter_membership_id: null });
    if (q.crm === 'in') and.push({ moved_to_crm_at: { $ne: null } });
    if (q.crm === 'out') and.push({ moved_to_crm_at: null });
    if (q.from) and.push({ submitted_at: { $gte: new Date(`${q.from}T00:00:00Z`) } });
    if (q.to) and.push({ submitted_at: { $lt: new Date(Date.parse(`${q.to}T00:00:00Z`) + DAY) } });
    if (q.q) {
      const m = ilike(q.q);
      const digits = q.q.replace(/\D/g, '');
      const cands = await tx.collection('candidates').distinct<string>('id', {
        $or: [
          { $expr: { $regexMatch: { input: { $concat: ['$first_name', ' ', { $ifNull: ['$last_name', ''] }] }, regex: m.$regex, options: 'i' } } }, { email: m }, { candidate_code: m },
          ...(digits.length >= 5 ? [{ phone: { $regex: digits.split('').join('\\D*') } }] : []),
        ],
      });
      and.push({ $or: [{ candidate_id: { $in: cands } }, { code: m }, { position: m }, { department: m }] });
    }
    return { $and: and };
  }

  /** Applications as lists and boards show them. */
  private async views(tx: TenantTx, apps: Doc[], stages: CareerStage[]) {
    if (!apps.length) return [];
    const cands = new Map((await tx.collection('candidates').find({ id: { $in: [...new Set(apps.map((x) => x.candidate_id))] } }, {
      projection: { first_name: 1, last_name: 1, email: 1, phone: 1, location_text: 1, candidate_code: 1, career_only: 1, photo_storage_key: 1, anonymized_at: 1 },
    })).map((c) => [c.id as string, c]));
    const names = await namesOf(tx, apps.flatMap((x) => [x.assigned_hr_membership_id, x.assigned_recruiter_membership_id]));
    const spaces = new Map((await tx.collection('hr_workspaces').find({}, { projection: { name: 1 } })).map((w) => [w.id as string, w.name as string]));
    const stageOf = new Map(stages.map((s) => [s.key, s]));
    const ints = await tx.collection('career_interviews').find({ application_id: { $in: apps.map((x) => x.id) }, status: 'scheduled', starts_at: { $gte: new Date(Date.now() - 2 * 3_600_000) } }, { sort: { starts_at: 1 }, projection: { application_id: 1, starts_at: 1 } });
    return apps.map((x) => {
      const c = cands.get(x.candidate_id) ?? {};
      const s = stageOf.get(x.stage);
      return {
        id: x.id as string, code: x.code as string, kind: x.kind as 'application' | 'enquiry', candidateId: x.candidate_id as string, candidateCode: (c.candidate_code as string | null) ?? null,
        name: c.anonymized_at ? 'Erased candidate' : `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim(), email: c.email ?? null, phone: c.phone ?? null, location: c.location_text ?? null,
        hasPhoto: !!c.photo_storage_key, position: x.position ?? null, department: x.department ?? null, stage: x.stage as string, stageLabel: s?.label ?? x.stage, stageKind: s?.kind ?? 'open',
        submittedAt: x.submitted_at, lastActivityAt: x.last_activity_at, stageEnteredAt: x.stage_entered_at,
        hrName: x.assigned_hr_membership_id ? names.get(x.assigned_hr_membership_id) ?? null : null, hrMembershipId: x.assigned_hr_membership_id ?? null,
        recruiterName: x.assigned_recruiter_membership_id ? names.get(x.assigned_recruiter_membership_id) ?? null : null, recruiterMembershipId: x.assigned_recruiter_membership_id ?? null,
        hrWorkspaceName: x.hr_workspace_id ? spaces.get(x.hr_workspace_id) ?? 'HR Workspace' : 'Company-wide',
        cvState: x.cv_state as string, inCrm: c.career_only === false, movedToCrmAt: x.moved_to_crm_at ?? null,
        nextFollowUpAt: x.next_follow_up_at ?? null, nextInterviewAt: ints.find((i) => i.application_id === x.id)?.starts_at ?? null, resubmissions: x.resubmissions ?? 0,
        source: x.source as string,
      };
    });
  }

  async list(q: CareerListQuery) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const stages = careerStagesOf(await careerSettings(tx));
      const filter = await this.filterFor(tx, a, q);
      const table = tx.collection('career_applications');
      const total = await table.count(filter);
      const sort: Doc = q.sort === 'oldest' ? { submitted_at: 1 } : { submitted_at: -1 };
      let rows = await this.views(tx, await table.find(filter, { sort, limit: q.limit }), stages);
      if (q.sort === 'name') rows = rows.sort((x, y) => x.name.localeCompare(y.name));
      if (q.sort === 'stage') { const pos = new Map(stages.map((s) => [s.key, s.position])); rows = rows.sort((x, y) => (pos.get(x.stage) ?? 99) - (pos.get(y.stage) ?? 99)); }
      return { total, rows, stages };
    });
  }

  async dashboard(q: Partial<CareerListQuery>) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const stages = careerStagesOf(await careerSettings(tx));
      const table = tx.collection('career_applications');
      const filter = await this.filterFor(tx, a, { ...q, stage: undefined });
      const byStage = new Map((await table.aggregate<{ id: string; n: number }>([{ $match: filter }, { $group: { _id: '$stage', n: { $sum: 1 } } }])).map((x) => [x.id, x.n]));
      const total = [...byStage.values()].reduce((s, n) => s + n, 0);
      const cards = CAREER_SUMMARY_CARDS.map((c) => ({ key: c.key, label: c.label, count: c.stages ? c.stages.reduce((s, k) => s + (byStage.get(k) ?? 0), 0) : total }));
      const scoped = await this.filterFor(tx, a, q);
      const now = new Date();
      const weeks: { week: string; received: number }[] = [];
      const start = new Date(now.getTime() - 7 * 7 * DAY);
      start.setUTCHours(0, 0, 0, 0);
      const recentDates = await table.find({ $and: [scoped, { submitted_at: { $gte: start } }] }, { projection: { submitted_at: 1 } });
      for (let i = 0; i < 8; i++) {
        const from = new Date(start.getTime() + i * 7 * DAY), to = new Date(from.getTime() + 7 * DAY);
        weeks.push({ week: from.toISOString().slice(0, 10), received: recentDates.filter((d) => d.submitted_at >= from && d.submitted_at < to).length });
      }
      const recent = await this.views(tx, await table.find(scoped, { sort: { submitted_at: -1 }, limit: 8 }), stages);
      const visibleIds = await table.distinct<string>('id', this.access.filter(a));
      const ints = await tx.collection('career_interviews').find({ application_id: { $in: visibleIds }, status: 'scheduled', starts_at: { $gte: new Date(now.getTime() - 3_600_000) } }, { sort: { starts_at: 1 }, limit: 8 });
      const intApps = new Map((await this.views(tx, await table.find({ id: { $in: ints.map((i) => i.application_id) } }), stages)).map((v) => [v.id, v]));
      const intNames = await namesOf(tx, ints.map((i) => i.interviewer_membership_id));
      const ups = await tx.collection('candidate_follow_ups').find({ career_application_id: { $in: visibleIds }, status: { $in: ['pending', 'rescheduled'] }, due_at: { $lt: new Date(now.getTime() + 2 * DAY) } }, { sort: { due_at: 1 }, limit: 8 });
      const upApps = new Map((await this.views(tx, await table.find({ id: { $in: ups.map((u) => u.career_application_id) } }), stages)).map((v) => [v.id, v]));
      const positions = (await table.aggregate<{ id: string | null; n: number }>([{ $match: scoped }, { $group: { _id: '$position', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 6 }])).map((x) => ({ position: x.id ?? 'Career enquiry (no position)', count: x.n }));
      const base = this.access.filter(a);
      const integ = await tx.collection('career_integrations').findOne({});
      const jobs = tx.collection('career_sync_jobs');
      return {
        cards,
        pipeline: stages.filter((s) => s.active || byStage.get(s.key)).map((s) => ({ key: s.key, label: s.label, kind: s.kind, count: byStage.get(s.key) ?? 0 })),
        weeks,
        recent,
        upcomingInterviews: ints.map((i) => ({
          id: i.id as string, applicationId: i.application_id as string, name: intApps.get(i.application_id)?.name ?? '', position: intApps.get(i.application_id)?.position ?? null,
          startsAt: i.starts_at, type: i.type as string, typeLabel: careerLabel(CAREER_INTERVIEW_TYPES, i.type), interviewer: i.interviewer_name ?? (i.interviewer_membership_id ? intNames.get(i.interviewer_membership_id) ?? null : null),
          meetingLink: i.meeting_link ?? null,
        })),
        followUps: ups.map((u) => ({ id: u.id as string, applicationId: u.career_application_id as string, name: upApps.get(u.career_application_id)?.name ?? '', dueAt: u.due_at, note: u.reason ?? null, overdue: u.due_at < now })),
        positions,
        options: {
          positions: (await table.distinct<string>('position', base)).filter(Boolean).sort(),
          departments: (await table.distinct<string>('department', base)).filter(Boolean).sort(),
        },
        thisWeek: await table.count({ $and: [base, { submitted_at: { $gte: new Date(now.getTime() - 7 * DAY) } }] }),
        movedToCrm: await table.count({ $and: [scoped, { moved_to_crm_at: { $ne: null } }] }),
        sync: integ ? {
          connected: !!integ.api_key_hash, enabled: !!integ.enabled, websiteName: integ.website_name as string, lastReceivedAt: integ.last_received_at ?? null, lastSuccessAt: integ.last_success_at ?? null,
          lastError: integ.last_error ?? null, failed: await jobs.count({ status: 'failed' }), pending: await jobs.count({ status: { $in: ['pending', 'running'] } }),
        } : null,
      };
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const app = await this.access.application(tx, a, id);
      const stages = careerStagesOf(await careerSettings(tx));
      const [view] = await this.views(tx, [app], stages);
      const c = (await tx.collection('candidates').findOne({ id: app.candidate_id }))!;
      const fields = (app.fields ?? {}) as Doc;
      const shown = (keys: string[]) => CAREER_TARGET_FIELDS.filter((f) => keys.includes(f.key) && fields[f.key]).map((f) => ({
        key: f.key, label: f.label, value: f.key === 'totalExperience' ? experienceShown(fields[f.key]) ?? fields[f.key] : (fields[f.key] as string),
      }));
      const cv = app.cv_file_id ? await tx.collection('candidate_files').findOne({ id: app.cv_file_id, deleted_at: null }) : null;
      const docs = (app.document_file_ids ?? []).length ? await tx.collection('candidate_files').find({ id: { $in: app.document_file_ids }, deleted_at: null }) : [];
      const calls = await tx.collection('candidate_activities').find({ candidate_id: app.candidate_id, kind: 'call', 'detail.careerApplicationId': id }, { sort: { occurred_at: -1 } });
      const emails = await tx.collection('candidate_activities').find({ candidate_id: app.candidate_id, kind: 'email', 'detail.careerApplicationId': id }, { sort: { occurred_at: -1 } });
      const ups = await tx.collection('candidate_follow_ups').find({ career_application_id: id }, { sort: { due_at: -1 } });
      const ints = await tx.collection('career_interviews').find({ application_id: id }, { sort: { starts_at: -1 } });
      const notes = await tx.collection('career_notes').find({ application_id: id }, { sort: { created_at: -1 } });
      const events = await tx.collection('career_application_events').find({ application_id: id, kind: { $ne: 'notified' } }, { sort: { created_at: -1 }, limit: 300 });
      const others = await this.views(tx, await tx.collection('career_applications').find({ $and: [{ candidate_id: app.candidate_id, id: { $ne: id } }, this.access.filter(a)] }, { sort: { submitted_at: -1 } }), stages);
      const names = await namesOf(tx, [
        ...calls.map((x) => x.created_by_membership_id), ...emails.map((x) => x.created_by_membership_id), ...ups.flatMap((u) => [u.assigned_membership_id, u.created_by_membership_id]),
        ...ints.flatMap((i) => [i.interviewer_membership_id, i.created_by_membership_id]), ...notes.map((n) => n.author_membership_id), ...events.map((e) => e.actor_membership_id), app.moved_to_crm_by_membership_id,
      ]);
      const nm = (m: string | null | undefined) => (m ? names.get(m) ?? 'Someone' : null);
      const label = new Map(stages.map((s) => [s.key, s.label]));
      const integ = app.integration_id ? await tx.collection('career_integrations').findOne({ id: app.integration_id }, { projection: { website_name: 1 } }) : null;
      const can = {
        manage: a.canManage && this.access.has(a, 'manage', app), cv: this.access.has(a, 'cv', app), contact: this.access.has(a, 'contact', app),
        interviews: a.canManage && this.access.has(a, 'interviews', app), crm: a.canManage && this.access.has(a, 'crm', app), assignWorkspace: a.level === 'super' && a.canManage,
      };
      return {
        application: { ...view!, websiteName: integ?.website_name ?? null, externalId: app.external_id ?? null, websiteStage: app.website_stage ?? null, websiteSyncedAt: app.website_synced_at ?? null, hrWorkspaceId: app.hr_workspace_id ?? null },
        personal: shown(['fullName', 'email', 'phone', 'location', 'linkedin', 'portfolio', 'currentDesignation', 'totalExperience', 'noticePeriod']),
        applicationInfo: shown(['position', 'department', 'message']),
        extra: (app.extra ?? []) as { key: string; label: string; value: string }[],
        crm: { inCrm: !c.career_only, candidateCode: c.candidate_code ?? null, movedAt: app.moved_to_crm_at ?? null, movedBy: nm(app.moved_to_crm_by_membership_id) },
        cv: cv && can.cv ? { id: cv.id as string, fileName: cv.file_name as string, contentType: cv.content_type as string, size: cv.size_bytes as number, previewable: cv.content_type === 'application/pdf' } : null,
        cvState: app.cv_state as string,
        documents: can.cv ? docs.map((d) => ({ id: d.id as string, fileName: d.file_name as string, contentType: d.content_type as string, size: d.size_bytes as number })) : [],
        calls: calls.map((x) => ({ id: x.id as string, outcome: x.outcome, outcomeLabel: careerLabel(CAREER_CALL_OUTCOMES, x.outcome), durationMinutes: x.duration_minutes ?? null, notes: x.remarks ?? null, at: x.occurred_at, by: nm(x.created_by_membership_id) })),
        emails: emails.map((x) => ({ id: x.id as string, subject: x.subject ?? '', at: x.occurred_at, by: nm(x.created_by_membership_id) })),
        followUps: ups.map((u) => ({ id: u.id as string, dueAt: u.due_at, note: u.reason ?? null, status: u.status as string, assignee: nm(u.assigned_membership_id), overdue: ['pending', 'rescheduled'].includes(u.status) && u.due_at < new Date() })),
        interviews: ints.map((i) => ({
          id: i.id as string, startsAt: i.starts_at, durationMinutes: i.duration_minutes, type: i.type, typeLabel: careerLabel(CAREER_INTERVIEW_TYPES, i.type), status: i.status,
          interviewer: i.interviewer_name ?? nm(i.interviewer_membership_id), interviewerMembershipId: i.interviewer_membership_id ?? null, meetingLink: i.meeting_link ?? null, location: i.location ?? null,
          notes: i.notes ?? null, feedback: i.feedback ?? null, cancelReason: i.cancel_reason ?? null, rescheduled: i.reschedule_count ?? 0,
        })),
        notes: notes.map((n) => ({ id: n.id as string, kind: n.kind as string, body: n.body as string, at: n.created_at, by: nm(n.author_membership_id), inCrm: !!n.crm_note_id })),
        history: events.map((e) => ({
          id: e.id as string, kind: e.kind as string, from: e.from_stage ? label.get(e.from_stage) ?? e.from_stage : null, to: e.to_stage ? label.get(e.to_stage) ?? e.to_stage : null,
          comment: e.comment ?? null, detail: e.detail ?? {}, at: e.created_at, by: nm(e.actor_membership_id) ?? (e.actor_membership_id ? 'Someone' : 'SampCrew'),
        })),
        otherApplications: others,
        can,
      };
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Changing
  // ------------------------------------------------------------------------------------------------------------

  private async open(tx: TenantTx, id: string, cap: 'manage' | 'contact' | 'interviews' | 'crm' | 'cv') {
    const a = await this.access.actor(tx);
    const app = await this.access.application(tx, a, id);
    this.access.require(a, cap === 'cv' ? 'cv' : cap, app);
    if (cap !== 'cv' && cap !== 'contact' && !a.canManage) throw Errors.forbidden('You can view applications but not change them');
    const c = (await tx.collection('candidates').findOne({ id: app.candidate_id }))!;
    if (c.anonymized_at) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
    return { a, app, c };
  }

  async setStatus(id: string, stage: string, comment: string | null) {
    return this.db.tenant(async (tx) => {
      const { a, app, c } = await this.open(tx, id, 'manage');
      return this.statusIn(tx, a, app, c, stage, comment);
    });
  }

  /** Changes the stage: history, CRM stage (when the candidate is in the CRM), website, and the assigned people. */
  async statusIn(tx: TenantTx, a: CareerActor, app: Doc, c: Doc, stage: string, comment: string | null, opts: { interviewAt?: Date | null; quietIfSame?: boolean } = {}) {
    const stages = careerStagesOf(await careerSettings(tx));
    const to = stages.find((s) => s.key === stage && s.active);
    if (!to) throw Errors.validation([{ path: 'stage', message: 'Choose a stage from the pipeline' }]);
    if (app.stage === stage) {
      if (opts.quietIfSame) return { stage };
      throw Errors.conflict('same_stage', `The application is already in ${to.label}`);
    }
    const from = stages.find((s) => s.key === app.stage);
    await tx.collection('career_applications').updateOne({ id: app.id }, { $set: { stage, stage_entered_at: new Date() } });
    await careerEvent(tx, app.id, 'status_changed', { from: app.stage, to: stage, comment });
    await crmTimeline(tx, c.id, { careerKind: 'status_changed', applicationId: app.id, code: app.code, from: from?.label ?? app.stage, to: to.label });
    if (!c.career_only) {
      const crmStages = stagesOf(await crmSettings(tx));
      const wanted = CRM_STAGE_FOR[stage] ?? ({ open: 'screening', won: 'selected', lost: 'rejected', paused: 'on_hold' } as const)[to.kind];
      if (c.crm_stage !== wanted && crmStages.some((s) => s.key === wanted && s.active)) {
        await tx.collection('candidates').updateOne({ id: c.id }, { $set: { crm_stage: wanted, crm_stage_entered_at: new Date() } });
        await recordActivity(tx, c.id, 'stage_changed', { detail: { from: c.crm_stage ?? null, to: wanted, via: 'career_enquiry', code: app.code }, remarks: comment });
      }
    }
    await this.sync.queueStatus(tx, app, to, comment, opts.interviewAt);
    await this.audit.record(tx, { action: 'career_application.status_changed', resourceType: 'career_application', resourceId: app.id, changes: { stage: { from: app.stage, to: stage } }, metadata: { code: app.code, comment } });
    const who = [app.assigned_hr_membership_id, app.assigned_recruiter_membership_id].filter((m) => m && m !== a.membershipId) as string[];
    if (who.length) {
      await this.notifications.notify(tx, {
        membershipIds: who, kind: 'career.status_changed', title: `${`${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()}: ${from?.label ?? app.stage} → ${to.label}`,
        body: [app.code, comment].filter(Boolean).join(' · '), link: `/career-enquiry/applications/${app.id}`, resource: { type: 'career_application', id: app.id },
      });
    }
    return { stage };
  }

  async assign(id: string, input: z.infer<typeof careerAssignInput>) {
    return this.db.tenant(async (tx) => {
      const { a, app, c } = await this.open(tx, id, 'manage');
      const people = new Set((await this.access.assignees(tx, a)).map((p) => p.membershipId));
      const set: Doc = {};
      const changes: Doc = {};
      for (const [field, key, kind] of [['assigned_hr_membership_id', 'hrMembershipId', 'career.assigned_hr'], ['assigned_recruiter_membership_id', 'recruiterMembershipId', 'career.assigned_recruiter']] as const) {
        const v = input[key];
        if (v === undefined || v === app[field]) continue;
        if (v && !people.has(v)) throw Errors.validation([{ path: key, message: 'Choose someone who works with Career Enquiry' }]);
        set[field] = v;
        changes[key] = { from: app[field] ?? null, to: v };
        await careerEvent(tx, app.id, key === 'hrMembershipId' ? 'assigned_hr' : 'assigned_recruiter', { detail: { from: app[field] ?? null, to: v } });
        if (v && v !== a.membershipId) {
          await this.notifications.notify(tx, {
            membershipIds: [v], kind, priority: 'high', email: true,
            title: `${key === 'hrMembershipId' ? 'You are the HR manager for' : 'You are the recruiter for'} ${`${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()}`,
            body: [app.code, app.position].filter(Boolean).join(' · '), link: `/career-enquiry/applications/${app.id}`, resource: { type: 'career_application', id: app.id },
          });
        }
      }
      if (input.hrWorkspaceId !== undefined && input.hrWorkspaceId !== (app.hr_workspace_id ?? null)) {
        if (a.level !== 'super') throw Errors.forbiddenCode('career_super_only', 'Only Super Workspace hands applications to another HR Workspace');
        if (input.hrWorkspaceId && !(await tx.collection('hr_workspaces').exists({ id: input.hrWorkspaceId, status: 'active' }))) throw Errors.validation([{ path: 'hrWorkspaceId', message: 'Choose an active HR Workspace' }]);
        set.hr_workspace_id = input.hrWorkspaceId;
        changes.hrWorkspaceId = { from: app.hr_workspace_id ?? null, to: input.hrWorkspaceId };
        await careerEvent(tx, app.id, 'workspace_changed', { detail: changes.hrWorkspaceId });
        if (c.career_only) await tx.collection('candidates').updateOne({ id: c.id }, { $set: { crm_hr_workspace_id: input.hrWorkspaceId } });
      }
      if (!Object.keys(set).length) return { changed: [] };
      await tx.collection('career_applications').updateOne({ id: app.id }, { $set: set });
      await this.audit.record(tx, { action: 'career_application.assigned', resourceType: 'career_application', resourceId: app.id, changes, metadata: { code: app.code } });
      return { changed: Object.keys(changes) };
    });
  }

  async addNote(id: string, input: z.infer<typeof careerNoteInput>) {
    return this.db.tenant(async (tx) => {
      const { a, app, c } = await this.open(tx, id, 'manage');
      const row = await tx.collection('career_notes').insert({ application_id: app.id, kind: input.kind, body: input.body, author_membership_id: a.membershipId });
      await careerEvent(tx, app.id, input.kind === 'comment' ? 'comment_added' : 'note_added', { detail: { noteId: row.id } });
      if (!c.career_only) await this.crm.carryNotes(tx, app, c.id);
      return { id: row.id as string };
    });
  }

  async logCall(id: string, input: CareerCallInput) {
    return this.db.tenant(async (tx) => {
      const { a, app, c } = await this.open(tx, id, 'contact');
      const at = input.calledAt ? new Date(input.calledAt) : new Date();
      const act = await recordActivity(tx, c.id, 'call', {
        automatic: false, outcome: input.outcome, durationMinutes: input.durationMinutes, remarks: input.notes, occurredAt: at, hrWorkspaceId: app.hr_workspace_id ?? null,
        detail: { careerApplicationId: app.id, code: app.code, phone: c.phone ?? null },
      });
      await careerEvent(tx, app.id, 'call_logged', { comment: input.notes, detail: { outcome: input.outcome, outcomeLabel: careerLabel(CAREER_CALL_OUTCOMES, input.outcome), durationMinutes: input.durationMinutes, activityId: act } });
      if (input.nextFollowUpAt) await this.followUpIn(tx, a, app, c, new Date(input.nextFollowUpAt), input.followUpNote ?? `Follow up after call (${careerLabel(CAREER_CALL_OUTCOMES, input.outcome)})`, a.membershipId);
      if (input.stage && input.stage !== app.stage) {
        if (!a.canManage || !this.access.has(a, 'manage', app)) this.access.require(a, 'manage', app);
        await this.statusIn(tx, a, app, c, input.stage, input.notes ? `After call: ${input.notes}`.slice(0, 1000) : 'After call');
      }
      await this.audit.record(tx, { action: 'career_application.call_logged', resourceType: 'career_application', resourceId: app.id, metadata: { code: app.code, outcome: input.outcome } });
      return { id: act };
    });
  }

  async email(id: string, input: z.infer<typeof careerEmailInput>) {
    return this.db.tenant(async (tx) => {
      const { app, c } = await this.open(tx, id, 'contact');
      if (!c.email) throw Errors.conflict('no_email', 'This candidate did not give an email address');
      const tenantId = app.tenant_id as string;
      await this.notifications.queueEmail(tx, tenantId, c.email, input.subject, input.body, 'career.message');
      const act = await recordActivity(tx, c.id, 'email', { automatic: false, subject: input.subject, remarks: input.body.slice(0, 2000), hrWorkspaceId: app.hr_workspace_id ?? null, detail: { careerApplicationId: app.id, code: app.code } });
      await careerEvent(tx, app.id, 'email_sent', { detail: { subject: input.subject, activityId: act } });
      await this.audit.record(tx, { action: 'career_application.emailed', resourceType: 'career_application', resourceId: app.id, metadata: { code: app.code, subject: input.subject } });
      return { queued: true };
    });
  }

  private async followUpIn(tx: TenantTx, a: CareerActor, app: Doc, c: Doc, due: Date, note: string | null, assignee: string | null) {
    const row = await tx.collection('candidate_follow_ups').insert({
      candidate_id: c.id, career_application_id: app.id, type: 'general', due_at: due, priority: 'medium', reason: note, assigned_membership_id: assignee ?? a.membershipId,
      reminder_minutes: 15, hr_workspace_id: app.hr_workspace_id ?? null, created_by_membership_id: a.membershipId,
    });
    await refreshNextFollowUp(tx, c.id);
    await this.refreshAppFollowUp(tx, app.id);
    await careerEvent(tx, app.id, 'follow_up_scheduled', { comment: note, detail: { followUpId: row.id, dueAt: due.toISOString() } });
    if (assignee && assignee !== a.membershipId) {
      await this.notifications.notify(tx, { membershipIds: [assignee], kind: 'career.follow_up_due', title: `Follow-up with ${`${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()} on ${due.toISOString().slice(0, 10)}`, body: note ?? app.code, link: `/career-enquiry/applications/${app.id}` });
    }
    return row.id as string;
  }

  private async refreshAppFollowUp(tx: TenantTx, applicationId: string) {
    const next = await tx.collection('candidate_follow_ups').findOne({ career_application_id: applicationId, status: { $in: ['pending', 'rescheduled'] } }, { sort: { due_at: 1 }, projection: { due_at: 1 } });
    await tx.collection('career_applications').updateOne({ id: applicationId }, { $set: { next_follow_up_at: next?.due_at ?? null } });
  }

  async addFollowUp(id: string, input: z.infer<typeof careerFollowUpInput>) {
    return this.db.tenant(async (tx) => {
      const { a, app, c } = await this.open(tx, id, 'interviews');
      if (input.assignedMembershipId && !(await this.access.assignees(tx, a)).some((p) => p.membershipId === input.assignedMembershipId)) throw Errors.validation([{ path: 'assignedMembershipId', message: 'Choose someone who works with Career Enquiry' }]);
      return { id: await this.followUpIn(tx, a, app, c, new Date(input.dueAt), input.note, input.assignedMembershipId) };
    });
  }

  async completeFollowUp(id: string, followUpId: string) {
    return this.db.tenant(async (tx) => {
      const { a, app, c } = await this.open(tx, id, 'interviews');
      const n = await tx.collection('candidate_follow_ups').updateOne({ id: followUpId, career_application_id: app.id, status: { $in: ['pending', 'rescheduled'] } }, { $set: { status: 'completed', completed_at: new Date(), completed_by_membership_id: a.membershipId } });
      if (!n) throw Errors.notFound('Follow-up');
      await refreshNextFollowUp(tx, c.id);
      await this.refreshAppFollowUp(tx, app.id);
      await careerEvent(tx, app.id, 'follow_up_completed', { detail: { followUpId } });
      return { ok: true };
    });
  }

  // Interviews ---------------------------------------------------------------------------------------------------

  async scheduleInterview(id: string, input: CareerInterviewInput) {
    return this.db.tenant(async (tx) => {
      const { a, app, c } = await this.open(tx, id, 'interviews');
      if (input.interviewerMembershipId && !(await this.access.assignees(tx, a)).some((p) => p.membershipId === input.interviewerMembershipId)) {
        const member = await tx.collection('memberships').exists({ id: input.interviewerMembershipId, status: 'active' });
        if (!member) throw Errors.validation([{ path: 'interviewerMembershipId', message: 'Choose an active member as interviewer' }]);
      }
      if (input.type === 'video' && !input.meetingLink) throw Errors.validation([{ path: 'meetingLink', message: 'Add the meeting link for a video interview' }]);
      const startsAt = new Date(input.startsAt);
      const row = await tx.collection('career_interviews').insert({
        application_id: app.id, candidate_id: c.id, starts_at: startsAt, duration_minutes: input.durationMinutes, type: input.type, interviewer_membership_id: input.interviewerMembershipId,
        interviewer_name: input.interviewerName, meeting_link: input.meetingLink, location: input.location, notes: input.notes, created_by_membership_id: a.membershipId,
      });
      await careerEvent(tx, app.id, 'interview_scheduled', { detail: { interviewId: row.id, startsAt: startsAt.toISOString(), type: input.type } });
      await crmTimeline(tx, c.id, { careerKind: 'interview_scheduled', applicationId: app.id, code: app.code, startsAt: startsAt.toISOString(), type: input.type });
      await this.advanceTo(tx, a, app, c, 'interview_scheduled', startsAt);
      await this.tellAboutInterview(tx, a, app, c, row, 'career.interview_scheduled', `Interview with ${`${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()} on ${startsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`, input.notifyCandidate);
      await this.audit.record(tx, { action: 'career_interview.scheduled', resourceType: 'career_application', resourceId: app.id, metadata: { code: app.code, interviewId: row.id, type: input.type } });
      return { id: row.id as string };
    });
  }

  async updateInterview(id: string, interviewId: string, input: z.infer<typeof careerInterviewUpdate>) {
    return this.db.tenant(async (tx) => {
      const { a, app, c } = await this.open(tx, id, 'interviews');
      const ints = tx.collection('career_interviews');
      const i = await ints.findOne({ id: interviewId, application_id: app.id });
      if (!i) throw Errors.notFound('Interview');
      if (i.status !== 'scheduled') throw Errors.conflict('interview_closed', `This interview is already ${i.status}`);
      const who = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
      if (input.action === 'reschedule') {
        if (!input.startsAt) throw Errors.validation([{ path: 'startsAt', message: 'Choose the new date and time' }]);
        const startsAt = new Date(input.startsAt);
        await ints.updateOne({ id: i.id }, { $set: { starts_at: startsAt, ...(input.durationMinutes ? { duration_minutes: input.durationMinutes } : {}), reminded_at: null }, $inc: { reschedule_count: 1 } });
        await careerEvent(tx, app.id, 'interview_rescheduled', { comment: input.reason, detail: { interviewId: i.id, from: i.starts_at, to: startsAt.toISOString() } });
        await this.sync.queueStatus(tx, app, careerStagesOf(await careerSettings(tx)).find((s) => s.key === app.stage) ?? { key: app.stage, kind: 'open', label: app.stage, active: true, position: 0, system: false }, `Interview moved to ${startsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`, startsAt);
        await this.tellAboutInterview(tx, a, app, c, { ...i, starts_at: startsAt }, 'career.interview_rescheduled', `Interview with ${who} moved to ${startsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`, input.notifyCandidate, input.reason);
      } else if (input.action === 'cancel') {
        await ints.updateOne({ id: i.id }, { $set: { status: 'cancelled', cancel_reason: input.reason } });
        await careerEvent(tx, app.id, 'interview_cancelled', { comment: input.reason, detail: { interviewId: i.id } });
        await this.tellAboutInterview(tx, a, app, c, i, 'career.interview_cancelled', `Interview with ${who} cancelled`, input.notifyCandidate, input.reason);
      } else {
        await ints.updateOne({ id: i.id }, { $set: { status: 'completed', feedback: input.feedback } });
        await careerEvent(tx, app.id, 'interview_completed', { comment: input.feedback, detail: { interviewId: i.id } });
        await this.advanceTo(tx, a, app, c, 'interview_completed');
      }
      await crmTimeline(tx, c.id, { careerKind: `interview_${input.action === 'complete' ? 'completed' : input.action === 'cancel' ? 'cancelled' : 'rescheduled'}`, applicationId: app.id, code: app.code });
      await this.audit.record(tx, { action: `career_interview.${input.action}`, resourceType: 'career_application', resourceId: app.id, metadata: { code: app.code, interviewId: i.id } });
      return { ok: true };
    });
  }

  /** Moves an application forward to a stage when it is still earlier in the pipeline (never back, never out of a closed stage). */
  private async advanceTo(tx: TenantTx, a: CareerActor, app: Doc, c: Doc, stage: string, interviewAt?: Date) {
    const stages = careerStagesOf(await careerSettings(tx));
    const from = stages.find((s) => s.key === app.stage);
    const to = stages.find((s) => s.key === stage && s.active);
    if (!to || !from || from.kind !== 'open' || from.position >= to.position) {
      if (interviewAt && to) await this.sync.queueStatus(tx, app, from ?? to, `Interview on ${interviewAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`, interviewAt);
      return;
    }
    await this.statusIn(tx, a, app, c, stage, null, { interviewAt, quietIfSame: true });
  }

  private async tellAboutInterview(tx: TenantTx, a: CareerActor, app: Doc, c: Doc, i: Doc, kind: string, title: string, toCandidate: boolean, reason?: string | null) {
    const to = [i.interviewer_membership_id, app.assigned_hr_membership_id, app.assigned_recruiter_membership_id].filter((m) => m && m !== a.membershipId) as string[];
    if (to.length) await this.notifications.notify(tx, { membershipIds: [...new Set(to)], kind, priority: 'high', email: true, title, body: [app.code, careerLabel(CAREER_INTERVIEW_TYPES, i.type), reason].filter(Boolean).join(' · '), link: `/career-enquiry/applications/${app.id}?tab=interviews`, resource: { type: 'career_application', id: app.id } });
    if (toCandidate && c.email) {
      const org = String((await tx.collection('tenants').findOne({}, { projection: { name: 1 } }))?.name ?? '').replace(/\s*\(Demo\)$/, '');
      const when = new Date(i.starts_at).toUTCString();
      const how = i.type === 'video' ? `Video interview: ${i.meeting_link ?? ''}` : i.type === 'in_person' ? `In person${i.location ? ` at ${i.location}` : ''}` : 'Telephonic interview: we will call you on the number you gave.';
      const body = kind === 'career.interview_cancelled'
        ? `Dear ${c.first_name},\n\nYour interview${app.position ? ` for ${app.position}` : ''} on ${when} is cancelled.${reason ? ` ${reason}` : ''} We will be in touch.\n\n${org}`
        : `Dear ${c.first_name},\n\nYour interview${app.position ? ` for ${app.position}` : ''} is ${kind === 'career.interview_rescheduled' ? 'now' : ''} on ${when}.\n${how}\n\n${org}`;
      await this.notifications.queueEmail(tx, app.tenant_id, c.email, kind === 'career.interview_cancelled' ? 'Your interview is cancelled' : 'Your interview', body, kind);
      await careerEvent(tx, app.id, 'email_sent', { detail: { subject: kind === 'career.interview_cancelled' ? 'Interview cancelled' : 'Interview details', automatic: true } });
    }
  }

  async interviews(q: { when: 'upcoming' | 'past' }) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const stages = careerStagesOf(await careerSettings(tx));
      const ids = await tx.collection('career_applications').distinct<string>('id', this.access.filter(a));
      const now = new Date();
      const list = await tx.collection('career_interviews').find(
        q.when === 'upcoming' ? { application_id: { $in: ids }, status: 'scheduled', starts_at: { $gte: new Date(now.getTime() - 3_600_000) } } : { application_id: { $in: ids }, $or: [{ status: { $ne: 'scheduled' } }, { starts_at: { $lt: now } }] },
        { sort: { starts_at: q.when === 'upcoming' ? 1 : -1 }, limit: 200 },
      );
      const apps = new Map((await this.views(tx, await tx.collection('career_applications').find({ id: { $in: list.map((i) => i.application_id) } }), stages)).map((v) => [v.id, v]));
      const names = await namesOf(tx, list.map((i) => i.interviewer_membership_id));
      return list.map((i) => ({
        id: i.id as string, applicationId: i.application_id as string, name: apps.get(i.application_id)?.name ?? '', code: apps.get(i.application_id)?.code ?? '', position: apps.get(i.application_id)?.position ?? null,
        startsAt: i.starts_at, durationMinutes: i.duration_minutes, type: i.type, typeLabel: careerLabel(CAREER_INTERVIEW_TYPES, i.type), status: i.status,
        interviewer: i.interviewer_name ?? (i.interviewer_membership_id ? names.get(i.interviewer_membership_id) ?? null : null), meetingLink: i.meeting_link ?? null, location: i.location ?? null,
      }));
    });
  }

  // CRM and files ----------------------------------------------------------------------------------------------

  async moveToCrm(id: string) {
    return this.db.tenant(async (tx) => {
      const { a, app } = await this.open(tx, id, 'crm');
      if (app.moved_to_crm_at) throw Errors.conflict('already_in_crm', 'This application is already in Candidate CRM');
      return this.crm.moveIn(tx, app, a.membershipId);
    });
  }

  async openFile(id: string, fileId: string) {
    const f = await this.db.tenant(async (tx) => {
      const { app } = await this.open(tx, id, 'cv');
      if (app.cv_file_id !== fileId && !(app.document_file_ids ?? []).includes(fileId)) throw Errors.notFound('File');
      const doc = await tx.collection('candidate_files').findOne({ id: fileId, candidate_id: app.candidate_id, deleted_at: null });
      if (!doc) throw Errors.notFound('File');
      await this.audit.record(tx, { action: 'candidate_file.downloaded', resourceType: 'candidate', resourceId: app.candidate_id, metadata: { fileId, via: 'career_enquiry', code: app.code } });
      return doc;
    });
    return { ...(await this.storage.open(f.storage_key)), fileName: f.file_name as string, contentType: f.content_type as string };
  }

  async openPhoto(id: string) {
    const key = await this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const app = await this.access.application(tx, a, id);
      const c = await tx.collection('candidates').findOne({ id: app.candidate_id }, { projection: { photo_storage_key: 1, personal: 1 } });
      if (!c?.photo_storage_key) throw Errors.notFound('Photo');
      return { key: c.photo_storage_key as string, type: (c.personal?.photoType as string | undefined) ?? 'image/jpeg' };
    });
    return { ...(await this.storage.open(key.key)), fileName: 'photo', contentType: key.type };
  }

  async exportCsv(q: CareerListQuery) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      this.access.require(a, 'reports');
      const stages = careerStagesOf(await careerSettings(tx));
      const rows = await this.views(tx, await tx.collection('career_applications').find(await this.filterFor(tx, a, q), { sort: { submitted_at: -1 }, limit: 5000 }), stages);
      const lines = ['Application ID,Candidate ID,Name,Email,Phone,Location,Kind,Position,Department,Status,Submitted,HR manager,Recruiter,HR Workspace,In Candidate CRM'];
      for (const r of rows) lines.push([r.code, r.candidateCode, r.name, r.email, r.phone, r.location, r.kind, r.position, r.department, r.stageLabel, r.submittedAt, r.hrName, r.recruiterName, r.hrWorkspaceName, r.inCrm ? 'Yes' : 'No'].map(csvCell).join(','));
      await this.audit.record(tx, { action: 'career_application.exported', resourceType: 'career_application', metadata: { rows: rows.length } });
      return { fileName: `career-applications-${new Date().toISOString().slice(0, 10)}.csv`, content: `﻿${lines.join('\r\n')}\r\n` };
    });
  }
}
