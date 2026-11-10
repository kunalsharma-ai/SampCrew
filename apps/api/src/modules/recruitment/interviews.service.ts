import { Injectable } from '@nestjs/common';
import type { FeedbackInput, InterviewInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { membershipUserNames, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { CandidatesService } from './candidates.service';
import { CANDIDATE_FOOTER, candidateName, loadApplication, recordEvent, reqAttrs } from './recruitment-common';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

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
  private async zoneFor(tx: TenantTx, requisitionId: string): Promise<string> {
    const r = (await tx.collection('job_requisitions').findOne({ id: requisitionId }, { projection: { legal_entity_id: 1, location_id: 1 } }))!;
    const l = r.location_id ? await tx.collection('locations').findOne({ id: r.location_id }, { projection: { timezone: 1 } }) : undefined;
    if (l?.timezone) return l.timezone;
    const le = await tx.collection('legal_entities').findOne({ id: r.legal_entity_id }, { projection: { timezone: 1 } });
    if (le?.timezone) return le.timezone;
    return (await tx.collection('tenants').findOne({}, { projection: { timezone: 1 } }))!.timezone;
  }

  /** Panelists of an interview with their names (sorted) and whether their scorecard is in. */
  private async panelOf(tx: TenantTx, interviewId: string) {
    const panel = await tx.collection('interview_panelists').find({ interview_id: interviewId });
    const done = new Set(await tx.collection('interview_feedback').distinct<string>('membership_id', { interview_id: interviewId }));
    const names = await membershipUserNames(tx, panel.map((p) => p.membership_id));
    return panel
      .filter((p) => names.has(p.membership_id))
      .map((p) => ({ membershipId: p.membership_id as string, name: names.get(p.membership_id) ?? null, submitted: done.has(p.membership_id) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
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
      const active = await tx.collection('memberships').count({ id: { $in: panel }, status: 'active' });
      if (active !== panel.length) throw Errors.badRequest('invalid_panel', 'Every interviewer must be an active member of the workspace');
      const row = await tx.collection('interviews').insert({
        application_id: applicationId, title: input.title, starts_at: new Date(input.startsAt), duration_minutes: input.durationMinutes, mode: input.mode,
        meeting_url: input.meetingUrl ?? null, location_text: input.locationText ?? null, created_by_membership_id: actor.membershipId,
      });
      await tx.collection('interview_panelists').insertMany(panel.map((m) => ({ interview_id: row.id, membership_id: m })));
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
      return { id: row.id as string };
    });
  }

  async cancel(id: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const interviews = tx.collection('interviews');
      await interviews.lock({ id });
      const i = await interviews.findOne({ id });
      if (!i) throw Errors.notFound('Interview');
      const a = await loadApplication(tx, i.application_id);
      await this.authz.require('candidates:manage', reqAttrs(a.req), tx);
      if (i.status !== 'scheduled') throw Errors.conflict('invalid_state', 'This interview is already cancelled');
      await interviews.updateOne({ id }, { $set: { status: 'cancelled', cancel_reason: reason } });
      await recordEvent(tx, i.application_id, 'interview_cancelled', { detail: { interviewId: id } });
      const panel = await tx.collection('interview_panelists').distinct<string>('membership_id', { interview_id: id });
      await this.notifications.notify(tx, {
        membershipIds: panel, kind: 'interview.cancelled',
        title: `Cancelled: ${i.title} with ${a.candidate_name}`, body: reason, link: `/recruitment/interviews/${id}`,
      });
      return { status: 'cancelled' };
    });
  }

  /** Interviews where I am on the panel, newest first, with whether my scorecard is in. */
  async mine() {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const ids = await tx.collection('interview_panelists').distinct<string>('interview_id', { membership_id: actor.membershipId });
      if (!ids.length) return [];
      const list = await tx.collection('interviews').find({ id: { $in: ids } });
      const apps = new Map((await tx.collection('applications').find({ id: { $in: [...new Set(list.map((i) => i.application_id))] } }, { projection: { candidate_id: 1, requisition_id: 1 } })).map((a) => [a.id as string, a]));
      const cands = new Map((await tx.collection('candidates').find({ id: { $in: [...new Set([...apps.values()].map((a) => a.candidate_id))] } }, { projection: { first_name: 1, last_name: 1 } })).map((c) => [c.id as string, c]));
      const reqs = new Map((await tx.collection('job_requisitions').find({ id: { $in: [...new Set([...apps.values()].map((a) => a.requisition_id))] } }, { projection: { code: 1, title: 1 } })).map((r) => [r.id as string, r]));
      const done = new Set(await tx.collection('interview_feedback').distinct<string>('interview_id', { interview_id: { $in: ids }, membership_id: actor.membershipId }));
      const soon = Date.now() - 86_400_000;
      const upcoming = (i: Doc) => i.status === 'scheduled' && new Date(i.starts_at).getTime() > soon;
      return list
        .sort((x, y) => Number(upcoming(y)) - Number(upcoming(x)) || new Date(y.starts_at).getTime() - new Date(x.starts_at).getTime())
        .slice(0, 200)
        .map((i) => {
          const a = apps.get(i.application_id) ?? {};
          const r = reqs.get(a.requisition_id) ?? {};
          return {
            id: i.id, title: i.title, startsAt: i.starts_at, durationMinutes: i.duration_minutes, mode: i.mode, meetingUrl: i.meeting_url ?? null, locationText: i.location_text ?? null,
            status: i.status, candidateName: candidateName(cands.get(a.candidate_id) ?? {}), requisitionCode: r.code, requisitionTitle: r.title, submitted: done.has(i.id),
          };
        });
    });
  }

  /**
   * One interview. Panelists see their own scorecard, and other panelists' only once they have submitted
   * theirs, so first impressions stay independent. People who manage the pipeline see every scorecard.
   */
  async get(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const i = await tx.collection('interviews').findOne({ id });
      if (!i) throw Errors.notFound('Interview');
      const a = await loadApplication(tx, i.application_id);
      const isPanelist = await tx.collection('interview_panelists').exists({ interview_id: id, membership_id: actor.membershipId });
      const s = await this.authz.subject(tx);
      const attrs = reqAttrs(a.req);
      const manages = can(s, 'candidates:manage', attrs).allowed;
      if (!isPanelist && !can(s, 'candidates:read', attrs).allowed) throw Errors.notFound('Interview');
      const c = (await tx.collection('candidates').findOne({ id: a.candidate_id }))!;
      const r = (await tx.collection('job_requisitions').findOne({ id: a.requisition_id }, { projection: { code: 1, title: 1, scorecard: 1, description: 1 } }))!;
      const interview = {
        id: i.id, applicationId: i.application_id, title: i.title, startsAt: i.starts_at, durationMinutes: i.duration_minutes, mode: i.mode, meetingUrl: i.meeting_url ?? null,
        locationText: i.location_text ?? null, status: i.status, cancelReason: i.cancel_reason ?? null, candidateId: a.candidate_id,
        candidateName: candidateName(c), currentTitle: c.current_title ?? null, currentCompany: c.current_company ?? null, profileUrl: c.profile_url ?? null,
        requisitionId: r.id, requisitionCode: r.code, requisitionTitle: r.title, scorecard: r.scorecard ?? [], jobDescription: r.description ?? null,
      };
      const panel = await this.panelOf(tx, id);
      const feedback = await tx.collection('interview_feedback').find({ interview_id: id }, { sort: { submitted_at: 1 } });
      const names = await membershipUserNames(tx, feedback.map((f) => f.membership_id));
      const all = feedback
        .filter((f) => names.has(f.membership_id))
        .map((f) => ({ id: f.id, membershipId: f.membership_id as string, interviewerName: names.get(f.membership_id) ?? null, ratings: f.ratings, recommendation: f.recommendation, summary: f.summary, submittedAt: f.submitted_at }));
      const mine = all.find((f) => f.membershipId === actor.membershipId) ?? null;
      const others = manages || mine ? all.filter((f) => f.membershipId !== actor.membershipId) : [];
      const files = (await tx.collection('candidate_files').find({ candidate_id: a.candidate_id }, { sort: { created_at: -1 }, projection: { file_name: 1 } })).map((f) => ({ id: f.id, fileName: f.file_name }));
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
      const i = await tx.collection('interviews').findOne({ id });
      if (!i) throw Errors.notFound('Interview');
      const isPanelist = await tx.collection('interview_panelists').exists({ interview_id: id, membership_id: actor.membershipId });
      if (!isPanelist) throw Errors.forbidden('Only interviewers on the panel can submit a scorecard');
      if (i.status === 'cancelled') throw Errors.conflict('interview_cancelled', 'This interview was cancelled');
      if (new Date(i.starts_at).getTime() > Date.now()) throw Errors.conflict('interview_not_started', 'Scorecards open once the interview has started');
      const a = await loadApplication(tx, i.application_id);
      const expected = a.req.scorecard;
      const given = input.ratings.map((r) => r.criterion);
      if (given.length !== expected.length || expected.some((c) => !given.includes(c)) || new Set(given).size !== given.length) {
        throw Errors.badRequest('scorecard_mismatch', `Rate each of: ${expected.join(', ')}`);
      }
      const row = await tx
        .collection('interview_feedback')
        .insert({ interview_id: id, membership_id: actor.membershipId, ratings: input.ratings, recommendation: input.recommendation, summary: input.summary })
        .catch((e: { code?: string }) => {
          if (e.code === '23505') throw Errors.conflict('feedback_submitted', 'You have already submitted your scorecard for this interview');
          throw e;
        });
      await recordEvent(tx, i.application_id, 'feedback_submitted', { detail: { interviewId: id, recommendation: input.recommendation } });
      await this.notifications.notify(tx, {
        membershipIds: [i.created_by_membership_id, a.req.hiring_manager_membership_id].filter((m) => m !== actor.membershipId),
        kind: 'interview.feedback', title: `Scorecard in for ${a.candidate_name} (${i.title})`, link: `/recruitment/candidates/${a.candidate_id}`,
      });
      await this.audit.record(tx, { action: 'interview.feedback_submitted', resourceType: 'application', resourceId: i.application_id, metadata: { interviewId: id, recommendation: input.recommendation } });
      return { id: row.id as string };
    });
  }
}
