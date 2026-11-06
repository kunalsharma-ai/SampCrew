import { Injectable } from '@nestjs/common';
import type { FeedbackInput, InterviewInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { CandidatesService } from './candidates.service';
import { CANDIDATE_FOOTER, loadApplication, recordEvent, reqAttrs } from './recruitment-common';

const MODE_LABEL: Record<string, string> = { in_person: 'In person', video: 'Video call', phone: 'Phone call' };

/** Interviews, interview panels and scorecards. */
@Injectable()
export class InterviewsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly candidates: CandidatesService,
  ) {}

  /** The time zone interview times are written in: the job's location, then its legal entity, then the workspace. */
  private async zoneFor(tx: Tx, requisitionId: string) {
    return (await one<{ tz: string }>(
      tx,
      `select coalesce(l.timezone, le.timezone, t.timezone) as tz from job_requisitions r join legal_entities le on le.id = r.legal_entity_id
         left join locations l on l.id = r.location_id join tenants t on t.id = r.tenant_id where r.id = $1`,
      [requisitionId],
    ))!.tz;
  }

  private when(iso: string | Date, tz: string) {
    const d = typeof iso === 'string' ? new Date(iso) : iso;
    return `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)} (${tz})`;
  }

  async schedule(applicationId: string, input: InterviewInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const a = await loadApplication(tx, applicationId, true);
      await this.authz.require('candidates:manage', reqAttrs(a.req), tx);
      if (a.status !== 'active') throw Errors.conflict('application_closed', `This application is ${a.status}`);
      if (a.anonymized) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
      const panel = [...new Set(input.panelMembershipIds)];
      const active = await many<{ id: string }>(tx, `select id from memberships where id = any($1::uuid[]) and status = 'active'`, [panel]);
      if (active.length !== panel.length) throw Errors.badRequest('invalid_panel', 'Every interviewer must be an active member of the workspace');
      const row = (await one<{ id: string }>(
        tx,
        `insert into interviews (tenant_id, application_id, title, starts_at, duration_minutes, mode, meeting_url, location_text, created_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [applicationId, input.title, input.startsAt, input.durationMinutes, input.mode, input.meetingUrl ?? null, input.locationText ?? null, actor.membershipId],
      ))!;
      for (const m of panel) await tx.query(`insert into interview_panelists (tenant_id, interview_id, membership_id) values (app_tenant_id(), $1, $2)`, [row.id, m]);
      await recordEvent(tx, applicationId, 'interview_scheduled', { detail: { interviewId: row.id, title: input.title, startsAt: input.startsAt } });
      const tz = await this.zoneFor(tx, a.requisition_id);
      const where = input.mode === 'video' ? `Join: ${input.meetingUrl}` : input.mode === 'in_person' ? `Where: ${input.locationText}` : input.locationText ? `Details: ${input.locationText}` : 'The interviewer will call you.';
      await this.notifications.notify(tx, {
        membershipIds: panel,
        kind: 'interview.scheduled',
        title: `Interview: ${a.candidate_name} for ${a.req.title}`,
        body: `${input.title}, ${this.when(input.startsAt, tz)}, ${input.durationMinutes} minutes. ${MODE_LABEL[input.mode]}. Submit your scorecard in SampCrew afterwards.`,
        link: `/recruitment/interviews/${row.id}`,
        email: true,
      });
      if (input.notifyCandidate && a.candidate_email) {
        const org = await this.candidates.orgName(tx);
        await this.notifications.queueEmail(
          tx, actor.tenantId, a.candidate_email, `Interview for ${a.req.title} at ${org}`,
          `Dear ${a.candidate_name},\n\nWe would like to invite you to an interview for the ${a.req.title} role.\n\n${input.title}\nWhen: ${this.when(input.startsAt, tz)}\nLength: ${input.durationMinutes} minutes\nFormat: ${MODE_LABEL[input.mode]}\n${where}\n\nIf this time does not work for you, please reply to the person who contacted you.\n\n${org}`,
          'candidate.interview', CANDIDATE_FOOTER,
        );
        await recordEvent(tx, applicationId, 'email_queued', { detail: { template: 'candidate.interview', interviewId: row.id } });
      }
      await this.audit.record(tx, { action: 'interview.scheduled', resourceType: 'application', resourceId: applicationId, metadata: { interviewId: row.id, panel } });
      return { id: row.id };
    });
  }

  async cancel(id: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const i = await one<{ application_id: string; status: string; title: string }>(tx, 'select application_id, status, title from interviews where id = $1 for update', [id]);
      if (!i) throw Errors.notFound('Interview');
      const a = await loadApplication(tx, i.application_id);
      await this.authz.require('candidates:manage', reqAttrs(a.req), tx);
      if (i.status !== 'scheduled') throw Errors.conflict('invalid_state', 'This interview is already cancelled');
      await tx.query(`update interviews set status = 'cancelled', cancel_reason = $2 where id = $1`, [id, reason]);
      await recordEvent(tx, i.application_id, 'interview_cancelled', { detail: { interviewId: id } });
      const panel = await many<{ membership_id: string }>(tx, 'select membership_id from interview_panelists where interview_id = $1', [id]);
      await this.notifications.notify(tx, {
        membershipIds: panel.map((p) => p.membership_id), kind: 'interview.cancelled',
        title: `Cancelled: ${i.title} with ${a.candidate_name}`, body: reason, link: `/recruitment/interviews/${id}`,
      });
      return { status: 'cancelled' };
    });
  }

  /** Interviews where I am on the panel, newest first, with whether my scorecard is in. */
  async mine() {
    const actor = requestContext.tenantActor();
    return this.db.tenant((tx) =>
      many(
        tx,
        `select i.id, i.title, i.starts_at as "startsAt", i.duration_minutes as "durationMinutes", i.mode, i.meeting_url as "meetingUrl", i.location_text as "locationText", i.status,
                trim(c.first_name || ' ' || c.last_name) as "candidateName", r.code as "requisitionCode", r.title as "requisitionTitle",
                exists (select 1 from interview_feedback f where f.interview_id = i.id and f.membership_id = $1) as "submitted"
           from interview_panelists p join interviews i on i.id = p.interview_id join applications a on a.id = i.application_id
           join candidates c on c.id = a.candidate_id join job_requisitions r on r.id = a.requisition_id
          where p.membership_id = $1 order by (i.status = 'scheduled' and i.starts_at > now() - interval '1 day') desc, i.starts_at desc limit 200`,
        [actor.membershipId],
      ),
    );
  }

  /**
   * One interview. Panelists see their own scorecard, and other panelists' only once they have submitted
   * theirs, so first impressions stay independent. People who manage the pipeline see every scorecard.
   */
  async get(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const i = await one<{ application_id: string }>(tx, 'select application_id from interviews where id = $1', [id]);
      if (!i) throw Errors.notFound('Interview');
      const a = await loadApplication(tx, i.application_id);
      const isPanelist = !!(await one(tx, 'select 1 from interview_panelists where interview_id = $1 and membership_id = $2', [id, actor.membershipId]));
      const s = await this.authz.subject(tx);
      const attrs = reqAttrs(a.req);
      const manages = can(s, 'candidates:manage', attrs).allowed;
      if (!isPanelist && !can(s, 'candidates:read', attrs).allowed) throw Errors.notFound('Interview');
      const interview = await one(
        tx,
        `select i.id, i.application_id as "applicationId", i.title, i.starts_at as "startsAt", i.duration_minutes as "durationMinutes", i.mode, i.meeting_url as "meetingUrl",
                i.location_text as "locationText", i.status, i.cancel_reason as "cancelReason", a.candidate_id as "candidateId",
                trim(c.first_name || ' ' || c.last_name) as "candidateName", c.current_title as "currentTitle", c.current_company as "currentCompany", c.profile_url as "profileUrl",
                r.id as "requisitionId", r.code as "requisitionCode", r.title as "requisitionTitle", r.scorecard, r.description as "jobDescription"
           from interviews i join applications a on a.id = i.application_id join candidates c on c.id = a.candidate_id join job_requisitions r on r.id = a.requisition_id
          where i.id = $1`,
        [id],
      );
      const panel = await many(tx, `select p.membership_id as "membershipId", u.full_name as name,
                                           exists (select 1 from interview_feedback f where f.interview_id = p.interview_id and f.membership_id = p.membership_id) as submitted
                                      from interview_panelists p join memberships m on m.id = p.membership_id join users u on u.id = m.user_id where p.interview_id = $1 order by u.full_name`, [id]);
      const all = await many<{ membershipId: string }>(tx, `select f.id, f.membership_id as "membershipId", u.full_name as "interviewerName", f.ratings, f.recommendation, f.summary, f.submitted_at as "submittedAt"
                                     from interview_feedback f join memberships m on m.id = f.membership_id join users u on u.id = m.user_id where f.interview_id = $1 order by f.submitted_at`, [id]);
      const mine = all.find((f) => f.membershipId === actor.membershipId) ?? null;
      const others = manages || mine ? all.filter((f) => f.membershipId !== actor.membershipId) : [];
      const files = await many(tx, `select id, file_name as "fileName" from candidate_files where candidate_id = (select candidate_id from applications where id = $1) order by created_at desc`, [i.application_id]);
      return {
        interview, panel, myFeedback: mine, otherFeedback: others, othersHidden: !manages && !mine && all.length > (mine ? 1 : 0), files,
        can: { feedback: isPanelist && !mine, manage: manages },
      };
    });
  }

  async submitFeedback(id: string, input: FeedbackInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      await this.authz.require('interviews:feedback', { membershipId: actor.membershipId }, tx);
      const i = await one<{ application_id: string; status: string; starts_at: Date; title: string; created_by_membership_id: string | null }>(
        tx, 'select application_id, status, starts_at, title, created_by_membership_id from interviews where id = $1', [id],
      );
      if (!i) throw Errors.notFound('Interview');
      const isPanelist = await one(tx, 'select 1 from interview_panelists where interview_id = $1 and membership_id = $2', [id, actor.membershipId]);
      if (!isPanelist) throw Errors.forbidden('Only interviewers on the panel can submit a scorecard');
      if (i.status === 'cancelled') throw Errors.conflict('interview_cancelled', 'This interview was cancelled');
      if (i.starts_at.getTime() > Date.now()) throw Errors.conflict('interview_not_started', 'Scorecards open once the interview has started');
      const a = await loadApplication(tx, i.application_id);
      const expected = a.req.scorecard;
      const given = input.ratings.map((r) => r.criterion);
      if (given.length !== expected.length || expected.some((c) => !given.includes(c)) || new Set(given).size !== given.length) {
        throw Errors.badRequest('scorecard_mismatch', `Rate each of: ${expected.join(', ')}`);
      }
      const row = (await one<{ id: string }>(
        tx,
        `insert into interview_feedback (tenant_id, interview_id, membership_id, ratings, recommendation, summary) values (app_tenant_id(), $1, $2, $3, $4, $5)
         on conflict (interview_id, membership_id) do nothing returning id`,
        [id, actor.membershipId, JSON.stringify(input.ratings), input.recommendation, input.summary],
      ));
      if (!row) throw Errors.conflict('feedback_submitted', 'You have already submitted your scorecard for this interview');
      await recordEvent(tx, i.application_id, 'feedback_submitted', { detail: { interviewId: id, recommendation: input.recommendation } });
      await this.notifications.notify(tx, {
        membershipIds: [i.created_by_membership_id, a.req.hiring_manager_membership_id].filter((m) => m !== actor.membershipId),
        kind: 'interview.feedback', title: `Scorecard in for ${a.candidate_name} (${i.title})`, link: `/recruitment/candidates/${a.candidate_id}`,
      });
      await this.audit.record(tx, { action: 'interview.feedback_submitted', resourceType: 'application', resourceId: i.application_id, metadata: { interviewId: id, recommendation: input.recommendation } });
      return { id: row.id };
    });
  }
}
