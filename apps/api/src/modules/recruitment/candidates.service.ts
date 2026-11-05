import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  RESUME_MAX_BYTES,
  RESUME_TYPES,
  type applicationListQuery,
  type CandidateInput,
  type candidatePatch,
  type moveStageInput,
  type rejectInput,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { sniffMatches, StorageService } from '../../platform/storage/storage.service';
import type { UploadedFile } from '../documents/documents.service';
import { uniqueAs } from '../employees/employees.service';
import { CANDIDATE_FOOTER, loadApplication, loadRequisition, recordEvent, REQ_SCOPE, reqAttrs, stageOfKind, withdrawOpenOffers } from './recruitment-common';

const CANDIDATE_COLUMNS = `c.id, c.first_name as "firstName", c.last_name as "lastName", trim(c.first_name || ' ' || c.last_name) as name, c.email, c.phone,
  c.location_text as "locationText", c.current_title as "currentTitle", c.current_company as "currentCompany", c.profile_url as "profileUrl",
  c.source, c.source_detail as "sourceDetail", c.referred_by_membership_id as "referredByMembershipId", c.tags, c.consent_basis as "consentBasis",
  c.consent_at as "consentAt", c.last_activity_at as "lastActivityAt", c.anonymized_at as "anonymizedAt", c.created_at as "createdAt"`;

const APPLICATION_COLUMNS = `a.id, a.candidate_id as "candidateId", trim(c.first_name || ' ' || c.last_name) as "candidateName", c.email as "candidateEmail",
  c.current_title as "currentTitle", c.current_company as "currentCompany", a.requisition_id as "requisitionId", r.code as "requisitionCode", r.title as "requisitionTitle",
  a.stage_id as "stageId", s.name as "stageName", s.kind as "stageKind", a.status, a.source, a.rejection_reason as "rejectionReason", a.rejection_note as "rejectionNote",
  a.cover_note as "coverNote", a.employee_id as "employeeId", a.applied_at as "appliedAt", a.stage_entered_at as "stageEnteredAt", a.decided_at as "decidedAt", a.hired_at as "hiredAt",
  (select count(*)::int from interviews i where i.application_id = a.id and i.status = 'scheduled') as "interviews",
  (select round(avg((x->>'score')::numeric), 2)::text from interviews i join interview_feedback f on f.interview_id = i.id, jsonb_array_elements(f.ratings) x where i.application_id = a.id) as "averageScore",
  (select count(*)::int from interviews i join interview_feedback f on f.interview_id = i.id where i.application_id = a.id) as "scorecards",
  (select o.status from offers o where o.application_id = a.id order by o.created_at desc limit 1) as "offerStatus"`;
const APPLICATION_FROM = `applications a join candidates c on c.id = a.candidate_id join job_requisitions r on r.id = a.requisition_id join recruitment_stages s on s.id = a.stage_id`;

const PATCH_COLUMNS: Record<string, string> = {
  firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', locationText: 'location_text', currentTitle: 'current_title',
  currentCompany: 'current_company', profileUrl: 'profile_url', sourceDetail: 'source_detail', tags: 'tags',
};

const REJECTION_EMAIL = (name: string, title: string, org: string) =>
  `Dear ${name},\n\nThank you for your interest in the ${title} role at ${org} and for the time you gave to the process. After careful consideration we will not be taking your application further.\n\nWe wish you every success.\n\n${org}`;

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
   * SQL that limits candidates aliased `c` to those the subject may see with `permission`: people with
   * workspace-wide access see everyone, others see candidates with an application to a requisition in their scope.
   */
  async candidateScope(tx: Tx, permission: string, params: unknown[]) {
    const p = await this.authz.predicate(permission, REQ_SCOPE, params, tx);
    if (p === '(true)') return 'true';
    return `exists (select 1 from applications sa join job_requisitions r on r.id = sa.requisition_id where sa.candidate_id = c.id and ${p})`;
  }

  /** Throws 404 unless the subject may see this candidate with `permission`. */
  async requireCandidate(tx: Tx, id: string, permission = 'candidates:read') {
    const params: unknown[] = [id];
    const scope = await this.candidateScope(tx, permission, params);
    const row = await one<{ id: string; anonymized_at: string | null }>(tx, `select c.id, c.anonymized_at from candidates c where c.id = $1 and ${scope}`, params);
    if (!row) {
      // Distinguish "no such permission" from "out of scope" the same way requisitions do.
      await this.authz.require(permission, undefined, tx);
      throw Errors.notFound('Candidate');
    }
    return row;
  }

  async list(q: { q?: string; tag?: string; requisitionId?: string; limit?: number }) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [];
      const where = [await this.candidateScope(tx, 'candidates:read', params), 'c.anonymized_at is null'];
      if (q.q) {
        params.push(`%${q.q.toLowerCase()}%`);
        where.push(`(lower(c.first_name || ' ' || c.last_name) like $${params.length} or c.email like $${params.length} or lower(coalesce(c.current_company, '')) like $${params.length})`);
      }
      if (q.tag) {
        params.push(q.tag);
        where.push(`$${params.length} = any(c.tags)`);
      }
      if (q.requisitionId) {
        params.push(q.requisitionId);
        where.push(`exists (select 1 from applications x where x.candidate_id = c.id and x.requisition_id = $${params.length})`);
      }
      params.push(Math.min(q.limit ?? 200, 500));
      return many(
        tx,
        `select ${CANDIDATE_COLUMNS},
                (select count(*)::int from applications x where x.candidate_id = c.id and x.status = 'active') as "activeApplications",
                (select json_agg(json_build_object('requisitionCode', r2.code, 'requisitionTitle', r2.title, 'stage', s2.name, 'status', x.status) order by x.applied_at desc)
                   from applications x join job_requisitions r2 on r2.id = x.requisition_id join recruitment_stages s2 on s2.id = x.stage_id where x.candidate_id = c.id) as applications
           from candidates c where ${where.join(' and ')} order by c.last_activity_at desc limit $${params.length}`,
        params,
      );
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      await this.requireCandidate(tx, id);
      const s = await this.authz.subject(tx);
      const candidate = await one(tx, `select ${CANDIDATE_COLUMNS}, rb.full_name as "referredByName" from candidates c
                                         left join memberships rbm on rbm.id = c.referred_by_membership_id left join users rb on rb.id = rbm.user_id where c.id = $1`, [id]);
      // Applications the viewer can see (a hiring manager sees only their own requisitions' applications).
      const params: unknown[] = [id];
      const pred = await this.authz.predicate('candidates:read', REQ_SCOPE, params, tx);
      const applications = (await many<Record<string, unknown> & { requisitionId: string }>(tx, `select ${APPLICATION_COLUMNS} from ${APPLICATION_FROM} where a.candidate_id = $1 and ${pred} order by a.applied_at desc`, params));
      const withCan = [];
      for (const a of applications) {
        const attrs = reqAttrs(await loadRequisition(tx, a.requisitionId));
        withCan.push({ ...a, can: { manage: can(s, 'candidates:manage', attrs).allowed, offers: can(s, 'offers:manage', attrs).allowed } });
      }
      const appIds = applications.map((a) => a.id as string);
      const files = await many(tx, `select id, kind, file_name as "fileName", content_type as "contentType", size_bytes as "sizeBytes", created_at as "createdAt" from candidate_files where candidate_id = $1 order by created_at desc`, [id]);
      const notes = await many(
        tx,
        `select n.id, n.body, n.application_id as "applicationId", n.created_at as "createdAt", u.full_name as "authorName"
           from candidate_notes n left join memberships m on m.id = n.author_membership_id left join users u on u.id = m.user_id
          where n.candidate_id = $1 and (n.application_id is null or n.application_id = any($2::uuid[])) order by n.created_at desc`,
        [id, appIds],
      );
      const timeline = await many(
        tx,
        `select e.id, e.application_id as "applicationId", e.kind, fs.name as "fromStage", ts.name as "toStage", e.detail, e.created_at as "createdAt", u.full_name as "actorName"
           from application_events e left join recruitment_stages fs on fs.id = e.from_stage_id left join recruitment_stages ts on ts.id = e.to_stage_id
           left join memberships m on m.id = e.actor_membership_id left join users u on u.id = m.user_id
          where e.application_id = any($1::uuid[]) order by e.id desc limit 200`,
        [appIds],
      );
      const interviews = await many(
        tx,
        `select i.id, i.application_id as "applicationId", i.title, i.starts_at as "startsAt", i.duration_minutes as "durationMinutes", i.mode, i.meeting_url as "meetingUrl",
                i.location_text as "locationText", i.status,
                (select json_agg(json_build_object('membershipId', p.membership_id, 'name', u.full_name, 'submitted', exists (select 1 from interview_feedback f where f.interview_id = i.id and f.membership_id = p.membership_id)) order by u.full_name)
                   from interview_panelists p join memberships m on m.id = p.membership_id join users u on u.id = m.user_id where p.interview_id = i.id) as panel
           from interviews i where i.application_id = any($1::uuid[]) order by i.starts_at desc`,
        [appIds],
      );
      const offers = await many(
        tx,
        `select o.id, o.application_id as "applicationId", o.job_title as "jobTitle", o.designation_id as "designationId", o.base_salary::text as "baseSalary", o.currency,
                o.pay_period as "payPeriod", o.variable_pay as "variablePay", to_char(o.joining_date, 'YYYY-MM-DD') as "joiningDate", to_char(o.expires_on, 'YYYY-MM-DD') as "expiresOn",
                o.notes, o.status, o.above_range as "aboveRange", o.approval_request_id as "approvalRequestId", o.sent_at as "sentAt", o.responded_at as "respondedAt",
                o.response_note as "responseNote", o.created_at as "createdAt"
           from offers o where o.application_id = any($1::uuid[]) order by o.created_at desc`,
        [appIds],
      );
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
      const existing = await one<{ id: string }>(tx, `select id from candidates where email = $1 and anonymized_at is null`, [input.email]);
      if (existing) throw Errors.conflict('candidate_exists', 'A candidate with this email already exists. Open their profile to add them to this job.');
      const row = (await one<{ id: string }>(
        tx,
        `insert into candidates (tenant_id, first_name, last_name, email, phone, location_text, current_title, current_company, profile_url, source, source_detail,
                                 referred_by_membership_id, tags, consent_basis, created_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'recruiter_confirmed', $13) returning id`,
        [input.firstName, input.lastName, input.email, input.phone ?? null, input.locationText ?? null, input.currentTitle ?? null, input.currentCompany ?? null,
          input.profileUrl ?? null, input.source, input.sourceDetail ?? null, input.referredByMembershipId ?? null, input.tags, actor.membershipId],
      ).catch(uniqueAs('candidate_exists', 'A candidate with this email already exists')))!;
      await this.audit.record(tx, { action: 'candidate.created', resourceType: 'candidate', resourceId: row.id, metadata: { source: input.source, basis: 'recruiter_confirmed' } });
      if (input.requisitionId) await this.applyIn(tx, row.id, input.requisitionId, input.source);
      return { id: row.id };
    });
  }

  async update(id: string, patch: z.infer<typeof candidatePatch>) {
    return this.db.tenant(async (tx) => {
      const c = await this.requireCandidate(tx, id, 'candidates:manage');
      if (c.anonymized_at) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (!entries.length) return { id };
      const params: unknown[] = [id];
      const sets = entries.map(([k, v]) => {
        params.push(v);
        return `${PATCH_COLUMNS[k]} = $${params.length}`;
      });
      await tx.query(`update candidates set ${sets.join(', ')} where id = $1`, params).catch(uniqueAs('candidate_exists', 'Another candidate already uses this email'));
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

  async applyIn(tx: Tx, candidateId: string, requisitionId: string, source: string, coverNote: string | null = null) {
    const r = await loadRequisition(tx, requisitionId);
    if (!['open', 'approved', 'on_hold'].includes(r.status)) throw Errors.conflict('requisition_not_open', 'This job is not taking candidates');
    const stage = await stageOfKind(tx, 'new');
    const actor = requestContext.get()?.actor;
    const row = (await one<{ id: string }>(
      tx,
      `insert into applications (tenant_id, candidate_id, requisition_id, stage_id, source, cover_note, created_by_membership_id)
       values (app_tenant_id(), $1, $2, $3, $4, $5, $6) returning id`,
      [candidateId, requisitionId, stage, source, coverNote, actor?.kind === 'user' ? actor.membershipId : null],
    ).catch(uniqueAs('already_applied', 'This candidate is already in this job’s pipeline')))!;
    await recordEvent(tx, row.id, 'applied', { toStageId: stage, detail: { source } });
    return { applicationId: row.id };
  }

  async pipeline(requisitionId: string, q: z.infer<typeof applicationListQuery>) {
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, requisitionId);
      await this.authz.require('candidates:read', reqAttrs(r), tx);
      const stages = await many(tx, `select id, name, kind, position from recruitment_stages where archived_at is null order by position`);
      const params: unknown[] = [requisitionId];
      const where = ['a.requisition_id = $1'];
      if (q.status) {
        params.push(q.status);
        where.push(`a.status = $${params.length}`);
      } else where.push(`a.status in ('active', 'hired')`);
      if (q.stageId) {
        params.push(q.stageId);
        where.push(`a.stage_id = $${params.length}`);
      }
      if (q.q) {
        params.push(`%${q.q.toLowerCase()}%`);
        where.push(`(lower(c.first_name || ' ' || c.last_name) like $${params.length} or c.email like $${params.length})`);
      }
      const applications = await many(tx, `select ${APPLICATION_COLUMNS} from ${APPLICATION_FROM} where ${where.join(' and ')} order by s.position, a.stage_entered_at`, params);
      const counts = await one(tx, `select count(*) filter (where status = 'active')::int as active, count(*) filter (where status = 'rejected')::int as rejected,
                                           count(*) filter (where status = 'withdrawn')::int as withdrawn, count(*) filter (where status = 'hired')::int as hired
                                      from applications where requisition_id = $1`, [requisitionId]);
      return { stages, applications, counts };
    });
  }

  async move(applicationId: string, input: z.infer<typeof moveStageInput>) {
    return this.db.tenant(async (tx) => {
      const a = await loadApplication(tx, applicationId, true);
      await this.authz.require('candidates:manage', reqAttrs(a.req), tx);
      if (a.status !== 'active') throw Errors.conflict('application_closed', `This application is ${a.status}`);
      if (a.anonymized) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
      const to = await one<{ id: string; kind: string; name: string }>(tx, 'select id, kind, name from recruitment_stages where id = $1 and archived_at is null', [input.stageId]);
      if (!to) throw Errors.badRequest('invalid_stage', 'Choose a stage in this pipeline');
      if (to.kind === 'hired') throw Errors.badRequest('use_hire', 'Hire the candidate from their accepted offer; that also creates the employee record.');
      if (to.id === a.stage_id) return { stageId: to.id };
      await tx.query(`update applications set stage_id = $2, stage_entered_at = now() where id = $1`, [applicationId, to.id]);
      await recordEvent(tx, applicationId, 'stage_changed', { fromStageId: a.stage_id, toStageId: to.id });
      if (input.note) await this.noteIn(tx, a.candidate_id, input.note, applicationId);
      return { stageId: to.id };
    });
  }

  async reject(applicationId: string, input: z.infer<typeof rejectInput>) {
    return this.db.tenant(async (tx) => {
      const a = await loadApplication(tx, applicationId, true);
      await this.authz.require('candidates:manage', reqAttrs(a.req), tx);
      if (a.status !== 'active') throw Errors.conflict('application_closed', `This application is ${a.status}`);
      const offer = await one(tx, `select 1 from offers where application_id = $1 and status = 'accepted'`, [applicationId]);
      if (offer) throw Errors.conflict('offer_accepted', 'The candidate accepted an offer. Withdraw the offer first if the hire is not going ahead.');
      await tx.query(`update applications set status = 'rejected', rejection_reason = $2, rejection_note = $3, decided_at = now() where id = $1`, [applicationId, input.reason, input.note ?? null]);
      await withdrawOpenOffers(tx, applicationId);
      const cancelled = await many<{ id: string }>(tx, `update interviews set status = 'cancelled', cancel_reason = 'Application closed' where application_id = $1 and status = 'scheduled' and starts_at > now() returning id`, [applicationId]);
      await recordEvent(tx, applicationId, 'rejected', { detail: { reason: input.reason, interviewsCancelled: cancelled.length } });
      if (input.notifyCandidate && a.candidate_email && !a.anonymized) {
        const org = await this.orgName(tx);
        await this.notifications.queueEmail(tx, requestContext.tenantActor().tenantId, a.candidate_email, `Your application for ${a.req.title}`, REJECTION_EMAIL(a.candidate_name, a.req.title, org), 'candidate.rejected', CANDIDATE_FOOTER);
        await recordEvent(tx, applicationId, 'email_queued', { detail: { template: 'candidate.rejected' } });
      }
      return { status: 'rejected' };
    });
  }

  async withdraw(applicationId: string) {
    return this.db.tenant(async (tx) => {
      const a = await loadApplication(tx, applicationId, true);
      await this.authz.require('candidates:manage', reqAttrs(a.req), tx);
      if (a.status !== 'active') throw Errors.conflict('application_closed', `This application is ${a.status}`);
      await tx.query(`update applications set status = 'withdrawn', decided_at = now() where id = $1`, [applicationId]);
      await withdrawOpenOffers(tx, applicationId, true);
      await tx.query(`update interviews set status = 'cancelled', cancel_reason = 'Candidate withdrew' where application_id = $1 and status = 'scheduled' and starts_at > now()`, [applicationId]);
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
      await tx.query(`update applications set status = 'active', rejection_reason = null, rejection_note = null, decided_at = null where id = $1`, [applicationId]);
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

  private async noteIn(tx: Tx, candidateId: string, body: string, applicationId: string | null) {
    const actor = requestContext.tenantActor();
    return one(tx, `insert into candidate_notes (tenant_id, candidate_id, application_id, body, author_membership_id) values (app_tenant_id(), $1, $2, $3, $4) returning id, created_at as "createdAt"`,
      [candidateId, applicationId, body, actor.membershipId]);
  }

  // Files -------------------------------------------------------------------------------------------------

  /** Checks an uploaded resume (type, size and leading bytes). Shared with the public career site. */
  static checkResume(file: UploadedFile | undefined) {
    if (!file) throw Errors.badRequest('file_required', 'Attach a CV');
    if (!(RESUME_TYPES as readonly string[]).includes(file.mimetype)) throw Errors.badRequest('unsupported_type', 'Upload the CV as a PDF or Word (.docx) file');
    if (file.size <= 0 || file.size > RESUME_MAX_BYTES) throw Errors.badRequest('file_too_large', 'The CV can be up to 5 MB');
    if (!sniffMatches(file.mimetype, file.buffer.subarray(0, 512))) throw Errors.badRequest('content_mismatch', 'The file content does not match its type');
  }

  async storeResume(tx: Tx, tenantId: string, candidateId: string, file: UploadedFile, membershipId: string | null) {
    CandidatesService.checkResume(file);
    const key = this.storage.newKey(tenantId);
    const sha = createHash('sha256').update(file.buffer).digest('hex');
    const name = file.originalname.replace(/[^\w.\- ()]+/g, '_').slice(0, 200) || 'cv';
    await this.storage.put(key, file.buffer);
    return (await one<{ id: string }>(
      tx,
      `insert into candidate_files (tenant_id, candidate_id, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by_membership_id)
       values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
      [candidateId, name, file.mimetype, file.size, sha, key, membershipId],
    ))!;
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
      const f = await one<{ candidate_id: string }>(tx, 'select candidate_id from candidate_files where id = $1', [fileId]);
      if (!f) throw Errors.notFound('File');
      const panelist = await one(tx, `select 1 from interview_panelists p join interviews i on i.id = p.interview_id join applications a on a.id = i.application_id
                                       where a.candidate_id = $1 and p.membership_id = $2`, [f.candidate_id, actor.membershipId]);
      if (!panelist) await this.requireCandidate(tx, f.candidate_id);
      await this.audit.record(tx, { action: 'candidate_file.downloaded', resourceType: 'candidate', resourceId: f.candidate_id, metadata: { fileId } });
      return this.storage.sign(fileId, 300, 'resumes');
    });
  }

  async openFile(id: string, exp: number, sig: string) {
    if (!this.storage.verify(id, exp, sig, 'resumes')) throw Errors.notFound('File');
    const f = await this.db.platform((tx) => one<{ storage_key: string; file_name: string; content_type: string }>(tx, 'select storage_key, file_name, content_type from candidate_files where id = $1', [id]));
    if (!f) throw Errors.notFound('File');
    return { ...(await this.storage.open(f.storage_key)), fileName: f.file_name, contentType: f.content_type };
  }

  // Erasure and retention ---------------------------------------------------------------------------------

  /** Erases a candidate's personal data on request. Pipeline history stays (it holds no personal text). */
  async erase(candidateId: string, reason: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('candidates:manage', {}, tx);
      const c = await one<{ id: string; anonymized_at: string | null }>(tx, 'select id, anonymized_at from candidates where id = $1', [candidateId]);
      if (!c) throw Errors.notFound('Candidate');
      if (c.anonymized_at) return { erased: false };
      await this.anonymize(tx, candidateId, 'request');
      await this.audit.record(tx, { action: 'candidate.erased', resourceType: 'candidate', resourceId: candidateId, metadata: { reason } });
      return { erased: true };
    });
  }

  private async anonymize(tx: Tx, candidateId: string, why: 'request' | 'retention') {
    const files = await many<{ storage_key: string }>(tx, 'delete from candidate_files where candidate_id = $1 returning storage_key', [candidateId]);
    for (const f of files) await this.storage.remove(f.storage_key);
    await tx.query('delete from candidate_notes where candidate_id = $1', [candidateId]);
    await tx.query(
      `update candidates set first_name = 'Erased', last_name = 'candidate', email = null, phone = null, location_text = null, current_title = null, current_company = null,
              profile_url = null, source_detail = null, tags = '{}', anonymized_at = now() where id = $1`,
      [candidateId],
    );
    await tx.query(`update applications set cover_note = null, rejection_note = null where candidate_id = $1`, [candidateId]);
    // Scorecards are about the person; keep the scores (for hiring analytics) but drop the written comments.
    await tx.query(
      `update interview_feedback f set summary = '', ratings = (select coalesce(jsonb_agg(x - 'note'), '[]'::jsonb) from jsonb_array_elements(f.ratings) x)
        where f.interview_id in (select i.id from interviews i join applications a on a.id = i.application_id where a.candidate_id = $1)`,
      [candidateId],
    );
    await tx.query(`update offers set notes = null, response_note = null where application_id in (select id from applications where candidate_id = $1)`, [candidateId]);
    for (const a of await many<{ id: string }>(tx, 'select id from applications where candidate_id = $1', [candidateId])) {
      await tx.query(`insert into application_events (tenant_id, application_id, kind, detail) values (app_tenant_id(), $1, 'anonymized', $2)`, [a.id, JSON.stringify({ why })]);
    }
  }

  /**
   * Anonymises candidates with nothing in progress whose last activity is older than the career site's retention
   * period (365 days when no site is set up). Run by the hourly job; returns how many were anonymised.
   */
  async applyRetention(tenantId: string) {
    return this.db.tenant(async (tx) => {
      const due = await many<{ id: string }>(
        tx,
        `select c.id from candidates c
          where c.anonymized_at is null
            and c.last_activity_at < now() - make_interval(days => coalesce((select retention_days from career_sites), 365))
            and not exists (select 1 from applications a where a.candidate_id = c.id and a.status = 'active')
            and not exists (select 1 from applications a join offers o on o.application_id = a.id where a.candidate_id = c.id and o.status in ('pending_approval', 'approved', 'sent', 'accepted') and a.status <> 'hired')
          limit 200`,
      );
      for (const c of due) {
        await this.anonymize(tx, c.id, 'retention');
        await this.audit.record(tx, { action: 'candidate.anonymized', resourceType: 'candidate', resourceId: c.id, metadata: { why: 'retention' }, tenantId });
      }
      return due.length;
    }, { tenantId });
  }

  async orgName(tx: Tx) {
    return (await one<{ name: string }>(tx, 'select name from tenants where id = app_tenant_id()'))?.name.replace(/\s*\(Demo\)$/, '') ?? 'the hiring team';
  }
}
