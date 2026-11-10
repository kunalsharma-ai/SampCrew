import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type BulkApplicationsInput,
  fillCandidateEmail,
  RESUME_MAX_BYTES,
  RESUME_TYPES,
  type applicationListQuery,
  type CandidateInput,
  type candidatePatch,
  type moveStageInput,
  type rejectInput,
} from '@crew/contracts';
import type { z } from 'zod';
import type { CandidateListQuery } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { ilike, membershipUserNames, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { AppError, Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { sniffMatches, StorageService } from '../../platform/storage/storage.service';
import type { UploadedFile } from '../documents/documents.service';
import { uniqueAs } from '../employees/employees.service';
import { CANDIDATE_FOOTER, candidateName, loadApplication, loadRequisition, recordEvent, REQ_FIELDS, reqAttrs, stageOfKind, visibleRequisitionIds, withdrawOpenOffers } from './recruitment-common';
import { safeFileName } from '../../platform/http/content-disposition';

const PATCH_COLUMNS: Record<string, string> = {
  firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', locationText: 'location_text', currentTitle: 'current_title',
  currentCompany: 'current_company', profileUrl: 'profile_url', sourceDetail: 'source_detail', tags: 'tags',
};

const REJECTION_EMAIL = (name: string, title: string, org: string) =>
  `Dear ${name},\n\nThank you for your interest in the ${title} role at ${org} and for the time you gave to the process. After careful consideration we will not be taking your application further.\n\nWe wish you every success.\n\n${org}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** The candidate fields the API returns (camelCase), from a candidate document. */
function candidateView(c: Doc) {
  return {
    id: c.id, firstName: c.first_name, lastName: c.last_name, name: candidateName(c), email: c.email ?? null, phone: c.phone ?? null,
    locationText: c.location_text ?? null, currentTitle: c.current_title ?? null, currentCompany: c.current_company ?? null, profileUrl: c.profile_url ?? null,
    source: c.source, sourceDetail: c.source_detail ?? null, referredByMembershipId: c.referred_by_membership_id ?? null, tags: c.tags ?? [], consentBasis: c.consent_basis,
    consentAt: c.consent_at, lastActivityAt: c.last_activity_at, anonymizedAt: c.anonymized_at ?? null, createdAt: c.created_at,
  };
}

/** Two decimal places, as the SQL `round(avg(x), 2)::text`. */
const avg2 = (xs: number[]) => (xs.length ? (Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100).toFixed(2) : null);

/** Interview feedback for applications, with the application each belongs to. */
async function feedbackFor(tx: TenantTx, applicationIds: string[]) {
  const interviews = await tx.collection('interviews').find({ application_id: { $in: applicationIds } }, { projection: { application_id: 1, status: 1 } });
  const appOf = new Map(interviews.map((i) => [i.id as string, i.application_id as string]));
  const feedback = interviews.length ? await tx.collection('interview_feedback').find({ interview_id: { $in: [...appOf.keys()] } }) : [];
  return { interviews, feedback: feedback.map((f): Doc => ({ ...f, applicationId: appOf.get(f.interview_id)! })) };
}

/** Applications as the board and profile show them (the SQL APPLICATION_COLUMNS), in the order given. */
async function applicationViews(tx: TenantTx, apps: Doc[]) {
  if (!apps.length) return [];
  const ids = apps.map((a) => a.id as string);
  const candidates = new Map((await tx.collection('candidates').find({ id: { $in: [...new Set(apps.map((a) => a.candidate_id))] } })).map((c) => [c.id as string, c]));
  const reqs = new Map((await tx.collection('job_requisitions').find({ id: { $in: [...new Set(apps.map((a) => a.requisition_id))] } }, { projection: { code: 1, title: 1 } })).map((r) => [r.id as string, r]));
  const stages = new Map((await tx.collection('recruitment_stages').find({ id: { $in: [...new Set(apps.map((a) => a.stage_id))] } })).map((s) => [s.id as string, s]));
  const { interviews, feedback } = await feedbackFor(tx, ids);
  const offers = await tx.collection('offers').find({ application_id: { $in: ids } }, { projection: { application_id: 1, status: 1, created_at: 1 }, sort: { created_at: -1 } });
  return apps.map((a) => {
    const c = candidates.get(a.candidate_id) ?? {};
    const r = reqs.get(a.requisition_id) ?? {};
    const s = stages.get(a.stage_id) ?? {};
    const fb = feedback.filter((f) => f.applicationId === a.id);
    const scores = fb.flatMap((f) => ((f.ratings ?? []) as Doc[]).map((x) => Number(x.score)).filter((n) => Number.isFinite(n)));
    return {
      id: a.id, candidateId: a.candidate_id, candidateName: candidateName(c), candidateEmail: c.email ?? null, currentTitle: c.current_title ?? null,
      currentCompany: c.current_company ?? null, requisitionId: a.requisition_id, requisitionCode: r.code, requisitionTitle: r.title,
      stageId: a.stage_id, stageName: s.name, stageKind: s.kind, status: a.status, source: a.source, rejectionReason: a.rejection_reason ?? null,
      rejectionNote: a.rejection_note ?? null, coverNote: a.cover_note ?? null, employeeId: a.employee_id ?? null, appliedAt: a.applied_at,
      stageEnteredAt: a.stage_entered_at, decidedAt: a.decided_at ?? null, hiredAt: a.hired_at ?? null,
      interviews: interviews.filter((i) => i.application_id === a.id && i.status === 'scheduled').length,
      averageScore: avg2(scores),
      scorecards: fb.length,
      offerStatus: (offers.find((o) => o.application_id === a.id)?.status as string | undefined) ?? null,
      // Not part of the response; used by callers that sort or filter.
      _position: s.position as number,
      _locationText: c.location_text ?? null,
      _anonymized: !!c.anonymized_at,
    };
  });
}

/** Drops the internal fields applicationViews adds. */
const publicView = <T extends Doc>({ _position, _locationText, _anonymized, ...rest }: T) => rest;

/** Candidates, their applications and the pipeline. */
@Injectable()
export class CandidatesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
  ) {}

  /**
   * A filter on candidates limiting them to those the subject may see with `permission`: people with
   * workspace-wide access see everyone, others see candidates with an application to a requisition in their scope.
   */
  async candidateScope(tx: TenantTx, permission: string): Promise<Doc> {
    const reqIds = await visibleRequisitionIds(tx, await this.authz.filter(permission, REQ_FIELDS, tx));
    if (reqIds === null) return {};
    return { id: { $in: await tx.collection('applications').distinct<string>('candidate_id', { requisition_id: { $in: reqIds } }) } };
  }

  /** Throws 404 unless the subject may see this candidate with `permission`. */
  async requireCandidate(tx: TenantTx, id: string, permission = 'candidates:read') {
    const scope = await this.candidateScope(tx, permission);
    const row = await tx.collection('candidates').findOne({ $and: [{ id }, scope] }, { projection: { anonymized_at: 1 } });
    if (!row) {
      // Distinguish "no such permission" from "out of scope" the same way requisitions do.
      await this.authz.require(permission, undefined, tx);
      throw Errors.notFound('Candidate');
    }
    return { id: row.id as string, anonymized_at: (row.anonymized_at as Date | null) ?? null };
  }

  private async listFilter(tx: TenantTx, q: Partial<CandidateListQuery>): Promise<Doc> {
    const and: Doc[] = [await this.candidateScope(tx, 'candidates:read'), { anonymized_at: null }];
    if (q.q) {
      const m = ilike(q.q);
      and.push({ $or: [{ $expr: { $regexMatch: { input: { $concat: ['$first_name', ' ', '$last_name'] }, regex: m.$regex, options: 'i' } } }, { email: m }, { current_company: m }] });
    }
    if (q.tag) and.push({ tags: q.tag });
    if (q.source) and.push({ source: q.source });
    // Job and status together mean "their application for this job is in this state".
    const app: Doc = {};
    if (q.requisitionId) app.requisition_id = q.requisitionId;
    if (q.status && q.status !== 'none') app.status = q.status;
    const apps = tx.collection('applications');
    if (Object.keys(app).length) and.push({ id: { $in: await apps.distinct<string>('candidate_id', app) } });
    if (q.status === 'none') and.push({ id: { $nin: await apps.distinct<string>('candidate_id') } });
    return { $and: and };
  }

  /** Candidates matching the filters, sorted as asked, at most `limit`. */
  private async matching(tx: TenantTx, q: Partial<CandidateListQuery>, limit: number) {
    const rows = await tx.collection('candidates').find(await this.listFilter(tx, q));
    const dir = q.dir === 'asc' ? 1 : -1;
    const key = (c: Doc): string | number =>
      q.sort === 'name' ? candidateName(c).toLowerCase() : new Date(q.sort === 'added' ? c.created_at : c.last_activity_at).getTime();
    rows.sort((a, b) => {
      const x = key(a), y = key(b);
      return (x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * dir;
    });
    return rows.slice(0, limit);
  }

  /** Each candidate's applications (newest first) with the job and stage, by candidate id. */
  private async applicationsOf(tx: TenantTx, candidateIds: string[]) {
    const apps = await tx.collection('applications').find({ candidate_id: { $in: candidateIds } }, { sort: { applied_at: -1 } });
    const reqs = new Map((await tx.collection('job_requisitions').find({ id: { $in: [...new Set(apps.map((a) => a.requisition_id))] } }, { projection: { code: 1, title: 1 } })).map((r) => [r.id as string, r]));
    const stages = new Map((await tx.collection('recruitment_stages').find({ id: { $in: [...new Set(apps.map((a) => a.stage_id))] } }, { projection: { name: 1 } })).map((s) => [s.id as string, s]));
    const out = new Map<string, Array<{ requisitionCode: string; requisitionTitle: string; stage: string; status: string }>>();
    for (const a of apps) {
      const list = out.get(a.candidate_id) ?? [];
      list.push({ requisitionCode: reqs.get(a.requisition_id)?.code, requisitionTitle: reqs.get(a.requisition_id)?.title, stage: stages.get(a.stage_id)?.name, status: a.status });
      out.set(a.candidate_id, list);
    }
    return out;
  }

  async list(q: Partial<CandidateListQuery>) {
    return this.db.tenant(async (tx) => {
      const rows = await this.matching(tx, q, Math.min(q.limit ?? 200, 500));
      const apps = await this.applicationsOf(tx, rows.map((c) => c.id));
      return rows.map((c) => {
        const list = apps.get(c.id) ?? [];
        return { ...candidateView(c), activeApplications: list.filter((a) => a.status === 'active').length, applications: list.length ? list : null };
      });
    });
  }

  /** The list as a file, with the same scope and filters (up to 5,000 people). Audited, as it carries contact details. */
  async export(q: Partial<CandidateListQuery>, format: 'csv' | 'xlsx') {
    return this.db.tenant(async (tx) => {
      const found = await this.matching(tx, q, 5001);
      if (found.length > 5000) throw Errors.badRequest('export_too_large', 'More than 5,000 candidates match. Narrow the filters and export again.');
      const apps = await this.applicationsOf(tx, found.map((c) => c.id));
      const rows = found.map((c) => {
        const list = apps.get(c.id) ?? [];
        return { ...candidateView(c), jobs: list.length ? list.map((a) => `${a.requisitionCode} ${a.requisitionTitle} (${a.status === 'active' ? a.stage : a.status})`).join('; ') : null };
      });
      const cell = (v: unknown) => {
        let t = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
        if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
        return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      const lines = ['Name,Email,Phone,Current title,Current company,Location,Source,Tags,Jobs,Added,Last activity'];
      for (const r of rows) lines.push([r.name, r.email, r.phone, r.currentTitle, r.currentCompany, r.locationText, r.source, (r.tags as string[]).join('; '), r.jobs, r.createdAt, r.lastActivityAt].map(cell).join(','));
      await this.audit.record(tx, { action: 'candidate.list_exported', resourceType: 'candidate', resourceId: null, changes: { format, rows: rows.length, filters: { q: q.q ?? null, tag: q.tag ?? null, requisitionId: q.requisitionId ?? null, source: q.source ?? null, status: q.status ?? null } } });
      return { fileName: `candidates-${new Date().toISOString().slice(0, 10)}.csv`, content: `﻿${lines.join('\r\n')}\r\n` };
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      await this.requireCandidate(tx, id);
      const s = await this.authz.subject(tx);
      const c = (await tx.collection('candidates').findOne({ id }))!;
      const referredBy = c.referred_by_membership_id ? ((await membershipUserNames(tx, [c.referred_by_membership_id])).get(c.referred_by_membership_id) ?? null) : null;
      const candidate = { ...candidateView(c), referredByName: referredBy };
      // Applications the viewer can see (a hiring manager sees only their own requisitions' applications).
      const reqIds = await visibleRequisitionIds(tx, await this.authz.filter('candidates:read', REQ_FIELDS, tx));
      const appDocs = await tx.collection('applications').find({ candidate_id: id, ...(reqIds === null ? {} : { requisition_id: { $in: reqIds } }) }, { sort: { applied_at: -1 } });
      const applications = (await applicationViews(tx, appDocs)).map(publicView);
      const withCan = [];
      for (const a of applications) {
        const attrs = reqAttrs(await loadRequisition(tx, a.requisitionId));
        withCan.push({ ...a, can: { manage: can(s, 'candidates:manage', attrs).allowed, offers: can(s, 'offers:manage', attrs).allowed } });
      }
      const appIds = applications.map((a) => a.id as string);
      const files = (await tx.collection('candidate_files').find({ candidate_id: id }, { sort: { created_at: -1 } })).map((f) => ({
        id: f.id, kind: f.kind, fileName: f.file_name, contentType: f.content_type, sizeBytes: f.size_bytes, createdAt: f.created_at,
      }));
      const noteDocs = await tx.collection('candidate_notes').find({ candidate_id: id, $or: [{ application_id: null }, { application_id: { $in: appIds } }] }, { sort: { created_at: -1 } });
      const eventDocs = await tx.collection('application_events').find({ application_id: { $in: appIds } }, { sort: { id: -1 }, limit: 200 });
      const interviewDocs = await tx.collection('interviews').find({ application_id: { $in: appIds } }, { sort: { starts_at: -1 } });
      const panelists = interviewDocs.length ? await tx.collection('interview_panelists').find({ interview_id: { $in: interviewDocs.map((i) => i.id) } }) : [];
      const submitted = interviewDocs.length ? await tx.collection('interview_feedback').find({ interview_id: { $in: interviewDocs.map((i) => i.id) } }, { projection: { interview_id: 1, membership_id: 1 } }) : [];
      const names = await membershipUserNames(tx, [...noteDocs.map((n) => n.author_membership_id), ...eventDocs.map((e) => e.actor_membership_id), ...panelists.map((p) => p.membership_id)]);
      const stageNames = new Map((await tx.collection('recruitment_stages').find({ id: { $in: [...new Set(eventDocs.flatMap((e) => [e.from_stage_id, e.to_stage_id]).filter(Boolean))] } }, { projection: { name: 1 } })).map((x) => [x.id as string, x.name as string]));
      const notes = noteDocs.map((n) => ({ id: n.id, body: n.body, applicationId: n.application_id ?? null, createdAt: n.created_at, authorName: names.get(n.author_membership_id) ?? null }));
      const timeline = eventDocs.map((e) => ({
        id: e.id, applicationId: e.application_id, kind: e.kind, fromStage: stageNames.get(e.from_stage_id) ?? null, toStage: stageNames.get(e.to_stage_id) ?? null,
        detail: e.detail, createdAt: e.created_at, actorName: names.get(e.actor_membership_id) ?? null,
      }));
      const interviews = interviewDocs.map((i) => {
        const panel = panelists
          .filter((p) => p.interview_id === i.id && names.has(p.membership_id))
          .map((p) => ({ membershipId: p.membership_id, name: names.get(p.membership_id) ?? null, submitted: submitted.some((f) => f.interview_id === i.id && f.membership_id === p.membership_id) }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return {
          id: i.id, applicationId: i.application_id, title: i.title, startsAt: i.starts_at, durationMinutes: i.duration_minutes, mode: i.mode, meetingUrl: i.meeting_url ?? null,
          locationText: i.location_text ?? null, status: i.status, panel: panel.length ? panel : null,
        };
      });
      const offers = (await tx.collection('offers').find({ application_id: { $in: appIds } }, { sort: { created_at: -1 } })).map(offerView);
      return {
        candidate, applications: withCan, files, notes, timeline, interviews, offers,
        can: {
          edit: withCan.some((a) => a.can.manage) || can(s, 'candidates:manage', {}).allowed,
          erase: can(s, 'candidates:manage', {}).allowed,
          hire: can(s, 'employees:create', {}).allowed || s.grants.some((g) => g.permission === 'employees:create'),
        },
      };
    });
  }

  async create(input: CandidateInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      if (input.requisitionId) {
        const r = await loadRequisition(tx, input.requisitionId);
        await this.authz.require('candidates:manage', reqAttrs(r), tx);
      } else {
        // A candidate not tied to a job is visible only to workspace-wide recruiters, so only they may add one.
        await this.authz.require('candidates:manage', {}, tx);
      }
      const candidates = tx.collection('candidates');
      if (await candidates.exists({ email: input.email, anonymized_at: null })) {
        throw Errors.conflict('candidate_exists', 'A candidate with this email already exists. Open their profile to add them to this job.');
      }
      const row = await candidates
        .insert({
          first_name: input.firstName, last_name: input.lastName, email: input.email, phone: input.phone ?? null, location_text: input.locationText ?? null,
          current_title: input.currentTitle ?? null, current_company: input.currentCompany ?? null, profile_url: input.profileUrl ?? null, source: input.source,
          source_detail: input.sourceDetail ?? null, referred_by_membership_id: input.referredByMembershipId ?? null, tags: input.tags,
          consent_basis: 'recruiter_confirmed', created_by_membership_id: actor.membershipId,
        })
        .catch(uniqueAs('candidate_exists', 'A candidate with this email already exists'));
      await this.audit.record(tx, { action: 'candidate.created', resourceType: 'candidate', resourceId: row.id, metadata: { source: input.source, basis: 'recruiter_confirmed' } });
      if (input.requisitionId) await this.applyIn(tx, row.id, input.requisitionId, input.source);
      return { id: row.id as string };
    });
  }

  async update(id: string, patch: z.infer<typeof candidatePatch>) {
    return this.db.tenant(async (tx) => {
      const c = await this.requireCandidate(tx, id, 'candidates:manage');
      if (c.anonymized_at) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (!entries.length) return { id };
      const set = Object.fromEntries(entries.map(([k, v]) => [PATCH_COLUMNS[k]!, v]));
      await tx.collection('candidates').updateOne({ id }, { $set: set }).catch(uniqueAs('candidate_exists', 'Another candidate already uses this email'));
      await this.audit.record(tx, { action: 'candidate.updated', resourceType: 'candidate', resourceId: id, changes: Object.fromEntries(entries) });
      return { id };
    });
  }

  /** Adds an existing candidate to a requisition (in its first stage). */
  async apply(candidateId: string, requisitionId: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.requireCandidate(tx, candidateId);
      if (c.anonymized_at) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
      const r = await loadRequisition(tx, requisitionId);
      await this.authz.require('candidates:manage', reqAttrs(r), tx);
      return this.applyIn(tx, candidateId, requisitionId, 'manual');
    });
  }

  async applyIn(tx: TenantTx, candidateId: string, requisitionId: string, source: string, coverNote: string | null = null) {
    const r = await loadRequisition(tx, requisitionId);
    if (!['open', 'approved', 'on_hold'].includes(r.status)) throw Errors.conflict('requisition_not_open', 'This job is not taking candidates');
    const stage = await stageOfKind(tx, 'new');
    const actor = requestContext.get()?.actor;
    const row = await tx
      .collection('applications')
      .insert({ candidate_id: candidateId, requisition_id: requisitionId, stage_id: stage, source, cover_note: coverNote, created_by_membership_id: actor?.kind === 'user' ? actor.membershipId : null })
      .catch(uniqueAs('already_applied', 'This candidate is already in this job’s pipeline'));
    await recordEvent(tx, row.id, 'applied', { toStageId: stage, detail: { source } });
    return { applicationId: row.id as string };
  }

  async pipeline(requisitionId: string, q: z.infer<typeof applicationListQuery>) {
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, requisitionId);
      await this.authz.require('candidates:read', reqAttrs(r), tx);
      const stages = (await tx.collection('recruitment_stages').find({ archived_at: null }, { sort: { position: 1 } })).map((s) => ({ id: s.id, name: s.name, kind: s.kind, position: s.position }));
      const filter: Doc = { requisition_id: requisitionId, status: q.status ? q.status : { $in: ['active', 'hired'] } };
      if (q.stageId) filter.stage_id = q.stageId;
      if (q.q) {
        const m = ilike(q.q);
        const cands = await tx.collection('candidates').distinct<string>('id', { $or: [{ $expr: { $regexMatch: { input: { $concat: ['$first_name', ' ', '$last_name'] }, regex: m.$regex, options: 'i' } } }, { email: m }] });
        filter.candidate_id = { $in: cands };
      }
      const views = await applicationViews(tx, await tx.collection('applications').find(filter));
      views.sort((a, b) => a._position - b._position || new Date(a.stageEnteredAt).getTime() - new Date(b.stageEnteredAt).getTime());
      const all = await tx.collection('applications').find({ requisition_id: requisitionId }, { projection: { status: 1 } });
      const n = (st: string) => all.filter((a) => a.status === st).length;
      return { stages, applications: views.map(publicView), counts: { active: n('active'), rejected: n('rejected'), withdrawn: n('withdrawn'), hired: n('hired') } };
    });
  }

  /**
   * Side-by-side comparison of 2 to 4 applications for the same job: where each candidate is, how long they have
   * been in process, and their interview scores per scorecard criterion and recommendations, averaged across
   * submitted scorecards. Visible to whoever can see the pipeline, like the average score on the board.
   */
  async compare(requisitionId: string, ids: string[]) {
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, requisitionId);
      await this.authz.require('candidates:read', reqAttrs(r), tx);
      const apps = (await applicationViews(tx, await tx.collection('applications').find({ requisition_id: requisitionId, id: { $in: ids } }))).map(
        ({ _position, _locationText, _anonymized, ...a }) => ({ ...a, locationText: _locationText, anonymized: _anonymized }),
      );
      if (apps.length !== ids.length) throw Errors.badRequest('not_in_job', 'Compare candidates who applied to this job');
      const { feedback } = await feedbackFor(tx, ids);
      const scores = new Map<string, number[]>();
      for (const f of feedback) {
        for (const x of (f.ratings ?? []) as Doc[]) {
          const k = `${f.applicationId}\u0000${x.criterion}`;
          const score = Number(x.score);
          if (Number.isFinite(score)) scores.set(k, [...(scores.get(k) ?? []), score]);
        }
      }
      const criteria = [...scores.entries()].map(([k, xs]) => {
        const [applicationId, criterion] = k.split('\u0000') as [string, string];
        return { applicationId, criterion, average: avg2(xs)!, ratings: xs.length };
      });
      // Offer amounts only for people who make offers on this job (pay is not shared with every interviewer).
      const s = await this.authz.subject(tx);
      const showPay = can(s, 'offers:manage', reqAttrs(r)).allowed;
      const offers = showPay
        ? (await tx.collection('offers').find({ application_id: { $in: ids }, status: { $nin: ['withdrawn', 'rejected'] } }, { sort: { created_at: -1 } })).map((o) => ({
            applicationId: o.application_id as string, amount: o.base_salary as string, currency: o.currency as string, payPeriod: o.pay_period as string,
            status: o.status as string, aboveRange: o.above_range as boolean, variablePay: (o.variable_pay as string | null) ?? null,
          }))
        : [];
      const days = (d: Date) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000));
      // Criteria from the job's scorecard first, then any others interviewers rated.
      const extra = [...new Set(criteria.map((c) => c.criterion))].filter((c) => !r.scorecard.includes(c)).sort();
      return {
        requisition: { id: r.id, code: r.code, title: r.title },
        criteria: [...r.scorecard, ...extra],
        /** Whether offer amounts are shown; with them, the job's approved range. */
        pay: showPay ? { salaryMin: r.salary_min, salaryMax: r.salary_max, currency: r.currency } : null,
        applications: ids.map((id) => {
          const a = apps.find((x) => x.id === id)!;
          const recs: Record<string, number> = {};
          for (const f of feedback.filter((x) => x.applicationId === id)) recs[f.recommendation] = (recs[f.recommendation] ?? 0) + 1;
          return {
            ...a,
            daysInProcess: days(a.appliedAt),
            daysInStage: days(a.stageEnteredAt),
            criteria: Object.fromEntries(criteria.filter((c) => c.applicationId === id).map((c) => [c.criterion, { average: c.average, ratings: c.ratings }])),
            recommendations: recs,
            offer: showPay ? (offers.find((o) => o.applicationId === id) ?? null) : undefined,
          };
        }),
      };
    });
  }

  async move(applicationId: string, input: z.infer<typeof moveStageInput>) {
    return this.db.tenant(async (tx) => {
      const a = await loadApplication(tx, applicationId, true);
      await this.authz.require('candidates:manage', reqAttrs(a.req), tx);
      if (a.status !== 'active') throw Errors.conflict('application_closed', `This application is ${a.status}`);
      if (a.anonymized) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
      const to = await tx.collection('recruitment_stages').findOne({ id: input.stageId, archived_at: null });
      if (!to) throw Errors.badRequest('invalid_stage', 'Choose a stage in this pipeline');
      if (to.kind === 'hired') throw Errors.badRequest('use_hire', 'Hire the candidate from their accepted offer; that also creates the employee record.');
      if (to.id === a.stage_id) return { stageId: to.id as string };
      await tx.collection('applications').updateOne({ id: applicationId }, { $set: { stage_id: to.id, stage_entered_at: new Date() } });
      await recordEvent(tx, applicationId, 'stage_changed', { fromStageId: a.stage_id, toStageId: to.id });
      if (input.note) await this.noteIn(tx, a.candidate_id, input.note, applicationId);
      return { stageId: to.id as string };
    });
  }

  /** Cancels an application's interviews still to come; returns how many. */
  private async cancelUpcomingInterviews(tx: TenantTx, applicationId: string, reason: string) {
    return tx.collection('interviews').update({ application_id: applicationId, status: 'scheduled', starts_at: { $gt: new Date() } }, { $set: { status: 'cancelled', cancel_reason: reason } });
  }

  async reject(applicationId: string, input: z.infer<typeof rejectInput>) {
    return this.db.tenant(async (tx) => {
      const a = await loadApplication(tx, applicationId, true);
      await this.authz.require('candidates:manage', reqAttrs(a.req), tx);
      if (a.status !== 'active') throw Errors.conflict('application_closed', `This application is ${a.status}`);
      if (await tx.collection('offers').exists({ application_id: applicationId, status: 'accepted' })) {
        throw Errors.conflict('offer_accepted', 'The candidate accepted an offer. Withdraw the offer first if the hire is not going ahead.');
      }
      await tx.collection('applications').updateOne({ id: applicationId }, { $set: { status: 'rejected', rejection_reason: input.reason, rejection_note: input.note ?? null, decided_at: new Date() } });
      await withdrawOpenOffers(tx, applicationId);
      const cancelled = await this.cancelUpcomingInterviews(tx, applicationId, 'Application closed');
      await recordEvent(tx, applicationId, 'rejected', { detail: { reason: input.reason, interviewsCancelled: cancelled } });
      if (input.notifyCandidate && a.candidate_email && !a.anonymized) {
        const org = await this.orgName(tx);
        await this.notifications.queueEmail(tx, requestContext.tenantActor().tenantId, a.candidate_email, `Your application for ${a.req.title}`, REJECTION_EMAIL(a.candidate_name, a.req.title, org), 'candidate.rejected', CANDIDATE_FOOTER);
        await recordEvent(tx, applicationId, 'email_queued', { detail: { template: 'candidate.rejected' } });
      }
      return { status: 'rejected' };
    });
  }

  /**
   * One action on several applications for a job. Each application is handled on its own, with the same checks as
   * doing it one by one, so one that cannot be moved (closed, erased, hired stage) does not stop the rest; the
   * result says which ones were skipped and why.
   */
  async bulk(requisitionId: string, input: BulkApplicationsInput) {
    const ids = [...new Set(input.applicationIds)];
    await this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, requisitionId);
      await this.authz.require('candidates:manage', reqAttrs(r), tx);
      const found = await tx.collection('applications').count({ requisition_id: requisitionId, id: { $in: ids } });
      if (found !== ids.length) throw Errors.badRequest('not_in_job', 'Choose candidates who applied to this job');
    });
    const results: { id: string; ok: boolean; code?: string; message?: string }[] = [];
    for (const id of ids) {
      try {
        if (input.action === 'move') await this.move(id, { stageId: input.stageId, note: input.note });
        else if (input.action === 'reject') await this.reject(id, { reason: input.reason, note: input.note, notifyCandidate: input.notifyCandidate });
        else await this.emailOne(id, input.subject, input.message);
        results.push({ id, ok: true });
      } catch (e) {
        if (!(e instanceof AppError) || e.getStatus() >= 500) throw e;
        results.push({ id, ok: false, code: e.code, message: (e.getResponse() as { message: string }).message });
      }
    }
    const done = results.filter((x) => x.ok).length;
    await this.db.tenant((tx) => this.audit.record(tx, {
      action: `applications.bulk_${input.action}`, resourceType: 'requisition', resourceId: requisitionId,
      changes: { done, skipped: results.length - done, ...(input.action === 'move' ? { stageId: input.stageId } : input.action === 'reject' ? { reason: input.reason, notifyCandidate: input.notifyCandidate } : { subject: input.subject }) },
    }));
    return { done, skipped: results.length - done, results };
  }

  /** Emails one candidate about their application, from the hiring organisation. */
  private async emailOne(applicationId: string, subject: string, message: string) {
    return this.db.tenant(async (tx) => {
      const a = await loadApplication(tx, applicationId, true);
      await this.authz.require('candidates:manage', reqAttrs(a.req), tx);
      if (a.anonymized) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
      if (!a.candidate_email) throw Errors.conflict('no_email', 'This candidate has no email address');
      const first = (await tx.collection('candidates').findOne({ id: a.candidate_id }, { projection: { first_name: 1 } }))!.first_name as string;
      const v = { firstName: first, jobTitle: a.req.title };
      const org = await this.orgName(tx);
      await this.notifications.queueEmail(tx, requestContext.tenantActor().tenantId, a.candidate_email, fillCandidateEmail(subject, v), `${fillCandidateEmail(message, v)}\n\n${org}`, 'candidate.message', CANDIDATE_FOOTER);
      await recordEvent(tx, applicationId, 'email_queued', { detail: { template: 'candidate.message', subject: fillCandidateEmail(subject, v) } });
    });
  }

  async withdraw(applicationId: string) {
    return this.db.tenant(async (tx) => {
      const a = await loadApplication(tx, applicationId, true);
      await this.authz.require('candidates:manage', reqAttrs(a.req), tx);
      if (a.status !== 'active') throw Errors.conflict('application_closed', `This application is ${a.status}`);
      await tx.collection('applications').updateOne({ id: applicationId }, { $set: { status: 'withdrawn', decided_at: new Date() } });
      await withdrawOpenOffers(tx, applicationId, true);
      await this.cancelUpcomingInterviews(tx, applicationId, 'Candidate withdrew');
      await recordEvent(tx, applicationId, 'withdrawn');
      return { status: 'withdrawn' };
    });
  }

  async reopen(applicationId: string) {
    return this.db.tenant(async (tx) => {
      const a = await loadApplication(tx, applicationId, true);
      await this.authz.require('candidates:manage', reqAttrs(a.req), tx);
      if (!['rejected', 'withdrawn'].includes(a.status)) throw Errors.conflict('invalid_state', 'Only a rejected or withdrawn application can be reopened');
      if (a.anonymized) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
      if (!['open', 'approved', 'on_hold'].includes(a.req.status)) throw Errors.conflict('requisition_not_open', 'This job is no longer taking candidates');
      await tx.collection('applications').updateOne({ id: applicationId }, { $set: { status: 'active', rejection_reason: null, rejection_note: null, decided_at: null } });
      await recordEvent(tx, applicationId, 'reopened');
      return { status: 'active' };
    });
  }

  async addNote(candidateId: string, body: string, applicationId?: string) {
    return this.db.tenant(async (tx) => {
      if (applicationId) {
        const a = await loadApplication(tx, applicationId);
        if (a.candidate_id !== candidateId) throw Errors.notFound('Application');
        await this.authz.require('candidates:manage', reqAttrs(a.req), tx);
      } else await this.requireCandidate(tx, candidateId, 'candidates:manage');
      return this.noteIn(tx, candidateId, body, applicationId ?? null);
    });
  }

  private async noteIn(tx: TenantTx, candidateId: string, body: string, applicationId: string | null) {
    const actor = requestContext.tenantActor();
    const n = await tx.collection('candidate_notes').insert({ candidate_id: candidateId, application_id: applicationId, body, author_membership_id: actor.membershipId });
    return { id: n.id as string, createdAt: n.created_at as Date };
  }

  // Files -------------------------------------------------------------------------------------------------

  /** Checks an uploaded resume (type, size and leading bytes). Shared with the public career site. */
  static checkResume(file: UploadedFile | undefined) {
    if (!file) throw Errors.badRequest('file_required', 'Attach a CV');
    if (!(RESUME_TYPES as readonly string[]).includes(file.mimetype)) throw Errors.badRequest('unsupported_type', 'Upload the CV as a PDF or Word (.docx) file');
    if (file.size <= 0 || file.size > RESUME_MAX_BYTES) throw Errors.badRequest('file_too_large', 'The CV can be up to 5 MB');
    if (!sniffMatches(file.mimetype, file.buffer.subarray(0, 512))) throw Errors.badRequest('content_mismatch', 'The file content does not match its type');
  }

  async storeResume(tx: TenantTx, tenantId: string, candidateId: string, file: UploadedFile, membershipId: string | null) {
    CandidatesService.checkResume(file);
    const key = this.storage.newKey(tenantId);
    const sha = createHash('sha256').update(file.buffer).digest('hex');
    const name = safeFileName(file.originalname, 'cv');
    await this.storage.put(key, file.buffer, { upload: true });
    const row = await tx.collection('candidate_files').insert({
      candidate_id: candidateId, file_name: name, content_type: file.mimetype, size_bytes: file.size, sha256: sha, storage_key: key, uploaded_by_membership_id: membershipId,
    });
    return { id: row.id as string };
  }

  async uploadResume(candidateId: string, file: UploadedFile | undefined) {
    CandidatesService.checkResume(file);
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const c = await this.requireCandidate(tx, candidateId, 'candidates:manage');
      if (c.anonymized_at) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
      const row = await this.storeResume(tx, actor.tenantId, candidateId, file!, actor.membershipId);
      await this.audit.record(tx, { action: 'candidate_file.uploaded', resourceType: 'candidate', resourceId: candidateId, metadata: { fileId: row.id } });
      return row;
    });
  }

  /** A 5-minute download link. Interviewers on the candidate's panel may open the CV too. Every link is audited. */
  async fileLink(fileId: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const f = await tx.collection('candidate_files').findOne({ id: fileId }, { projection: { candidate_id: 1 } });
      if (!f) throw Errors.notFound('File');
      const mine = await tx.collection('interview_panelists').distinct<string>('interview_id', { membership_id: actor.membershipId });
      const panelist =
        mine.length > 0 &&
        (await tx.collection('interviews').exists({ id: { $in: mine }, application_id: { $in: await tx.collection('applications').distinct<string>('id', { candidate_id: f.candidate_id }) } }));
      if (!panelist) await this.requireCandidate(tx, f.candidate_id);
      await this.audit.record(tx, { action: 'candidate_file.downloaded', resourceType: 'candidate', resourceId: f.candidate_id, metadata: { fileId } });
      return this.storage.sign(fileId, 300, 'resumes');
    });
  }

  async openFile(id: string, exp: number, sig: string) {
    if (!this.storage.verify(id, exp, sig, 'resumes')) throw Errors.notFound('File');
    const f = await this.db.platform((tx) => tx.collection('candidate_files').findOne({ id }, { projection: { storage_key: 1, file_name: 1, content_type: 1 } }));
    if (!f) throw Errors.notFound('File');
    return { ...(await this.storage.open(f.storage_key)), fileName: f.file_name as string, contentType: f.content_type as string };
  }

  // Erasure and retention ---------------------------------------------------------------------------------

  /** Erases a candidate's personal data on request. Pipeline history stays (it holds no personal text). */
  async erase(candidateId: string, reason: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('candidates:manage', {}, tx);
      const c = await tx.collection('candidates').findOne({ id: candidateId }, { projection: { anonymized_at: 1 } });
      if (!c) throw Errors.notFound('Candidate');
      if (c.anonymized_at) return { erased: false };
      await this.anonymize(tx, candidateId, 'request');
      await this.audit.record(tx, { action: 'candidate.erased', resourceType: 'candidate', resourceId: candidateId, metadata: { reason } });
      return { erased: true };
    });
  }

  private async anonymize(tx: TenantTx, candidateId: string, why: 'request' | 'retention') {
    const filesTable = tx.collection('candidate_files');
    const files = await filesTable.find({ candidate_id: candidateId }, { projection: { storage_key: 1 } });
    await filesTable.delete({ candidate_id: candidateId });
    for (const f of files) await this.storage.remove(f.storage_key);
    await tx.collection('candidate_notes').delete({ candidate_id: candidateId });
    await tx.collection('candidates').updateOne({ id: candidateId }, {
      $set: {
        first_name: 'Erased', last_name: 'candidate', email: null, phone: null, location_text: null, current_title: null, current_company: null,
        profile_url: null, source_detail: null, tags: [], anonymized_at: new Date(),
      },
    });
    const appIds = await tx.collection('applications').distinct<string>('id', { candidate_id: candidateId });
    await tx.collection('applications').update({ candidate_id: candidateId }, { $set: { cover_note: null, rejection_note: null } });
    // Scorecards are about the person; keep the scores (for hiring analytics) but drop the written comments.
    const interviewIds = await tx.collection('interviews').distinct<string>('id', { application_id: { $in: appIds } });
    const feedbackTable = tx.collection('interview_feedback');
    for (const f of await feedbackTable.find({ interview_id: { $in: interviewIds } }, { projection: { ratings: 1 } })) {
      const ratings = ((f.ratings ?? []) as Doc[]).map(({ note, ...rest }) => rest);
      await feedbackTable.updateOne({ id: f.id }, { $set: { summary: '', ratings } });
    }
    await tx.collection('offers').update({ application_id: { $in: appIds } }, { $set: { notes: null, response_note: null } });
    if (appIds.length) await tx.collection('application_events').insertMany(appIds.map((id) => ({ application_id: id, kind: 'anonymized', detail: { why } })));
  }

  /**
   * Anonymises candidates with nothing in progress whose last activity is older than the career site's retention
   * period (365 days when no site is set up). Run by the hourly job; returns how many were anonymised.
   */
  async applyRetention(tenantId: string) {
    return this.db.tenant(async (tx) => {
      const site = await tx.collection('career_sites').findOne({}, { projection: { retention_days: 1 } });
      const cutoff = new Date(Date.now() - ((site?.retention_days as number | undefined) ?? 365) * 86_400_000);
      const stale = await tx.collection('candidates').distinct<string>('id', { anonymized_at: null, last_activity_at: { $lt: cutoff } });
      let due: string[] = [];
      if (stale.length) {
        const apps = tx.collection('applications');
        const busy = new Set(await apps.distinct<string>('candidate_id', { candidate_id: { $in: stale }, status: 'active' }));
        const offerApps = await tx.collection('offers').distinct<string>('application_id', { status: { $in: ['pending_approval', 'approved', 'sent', 'accepted'] } });
        if (offerApps.length) for (const c of await apps.distinct<string>('candidate_id', { id: { $in: offerApps }, status: { $ne: 'hired' }, candidate_id: { $in: stale } })) busy.add(c);
        due = stale.filter((id) => !busy.has(id)).slice(0, 200);
      }
      for (const id of due) {
        await this.anonymize(tx, id, 'retention');
        await this.audit.record(tx, { action: 'candidate.anonymized', resourceType: 'candidate', resourceId: id, metadata: { why: 'retention' }, tenantId });
      }
      return due.length;
    }, { tenantId });
  }

  async orgName(tx: TenantTx) {
    return ((await tx.collection('tenants').findOne({}, { projection: { name: 1 } }))?.name as string | undefined)?.replace(/\s*\(Demo\)$/, '') ?? 'the hiring team';
  }
}

/** An offer as the profile shows it. Shared with the offers service. */
export function offerView(o: Doc) {
  return {
    id: o.id, applicationId: o.application_id, jobTitle: o.job_title, designationId: o.designation_id ?? null, baseSalary: o.base_salary, currency: o.currency,
    payPeriod: o.pay_period, variablePay: o.variable_pay ?? null, joiningDate: o.joining_date ?? null, expiresOn: o.expires_on ?? null,
    notes: o.notes ?? null, status: o.status, aboveRange: o.above_range, approvalRequestId: o.approval_request_id ?? null, sentAt: o.sent_at ?? null,
    respondedAt: o.responded_at ?? null, responseNote: o.response_note ?? null, createdAt: o.created_at,
  };
}
