import { Injectable } from '@nestjs/common';
import { type SurveyAnswers, type SurveyInput, type SurveyQuestion, talentMath } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { nameOf, needEmployee, talentEmployee } from './talent-common';

interface SurveyRow {
  id: string;
  title: string;
  status: 'draft' | 'open' | 'closed';
  min_responses: number;
  questions: SurveyQuestion[];
  legal_entity_id: string | null;
  department_id: string | null;
  closes_on: string | null;
}

const RECOGNITIONS_PER_DAY = 20;
const SURVEY_SELECT = `id, title, status, min_responses, questions, legal_entity_id, department_id, to_char(closes_on, 'YYYY-MM-DD') as closes_on`;
/** A survey past its closing date accepts no more answers, even before an admin closes it. */
const effectiveStatus = `case when s.status = 'open' and s.closes_on < current_date then 'closed' else s.status end`;

/**
 * Engagement: anonymous pulse surveys and the recognition wall.
 *
 * Surveys store answers without the respondent. Only the department and legal entity at the time and the date are
 * kept, and results respect the anonymity threshold (see talent-math). Nobody, including admins, can see who said
 * what through CREW.
 */
@Injectable()
export class EngagementService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private async survey(tx: Tx, id: string, lock = false) {
    const s = await one<SurveyRow>(tx, `select ${SURVEY_SELECT} from surveys where id = $1${lock ? ' for update' : ''}`, [id]);
    if (!s) throw Errors.notFound('Survey');
    return s;
  }

  // Surveys (admin) -----------------------------------------------------------------------------------------------

  listSurveys() {
    return this.db.tenant((tx) =>
      many(
        tx,
        `select s.id, s.title, ${effectiveStatus} as status, s.min_responses as "minResponses", to_char(s.closes_on, 'YYYY-MM-DD') as "closesOn",
                le.name as "legalEntityName", d.name as "departmentName", s.opened_at as "openedAt", s.closed_at as "closedAt", jsonb_array_length(s.questions) as questions,
                (select count(*)::int from survey_invitations i where i.survey_id = s.id) as invited,
                (select count(*)::int from survey_invitations i where i.survey_id = s.id and i.responded) as responded
           from surveys s left join legal_entities le on le.id = s.legal_entity_id left join departments d on d.id = s.department_id
          order by s.created_at desc limit 200`,
      ),
    );
  }

  async getSurvey(id: string) {
    return this.db.tenant(async (tx) => {
      await this.survey(tx, id);
      return one(
        tx,
        `select s.id, s.title, s.description, ${effectiveStatus} as status, s.min_responses as "minResponses", s.questions, s.legal_entity_id as "legalEntityId",
                s.department_id as "departmentId", to_char(s.closes_on, 'YYYY-MM-DD') as "closesOn", s.opened_at as "openedAt", s.closed_at as "closedAt"
           from surveys s where s.id = $1`,
        [id],
      );
    });
  }

  private audience(tx: Tx, s: { legal_entity_id: string | null; department_id: string | null }) {
    return many<{ id: string; membership_id: string | null }>(
      tx,
      `with recursive deps(id) as (select $2::uuid where $2::uuid is not null union select d.id from departments d join deps on d.parent_id = deps.id)
       select e.id, e.membership_id from employees e
        where e.status in ('probation', 'active', 'notice') and e.membership_id is not null
          and ($1::uuid is null or e.current_legal_entity_id = $1) and ($2::uuid is null or e.current_department_id in (select id from deps))`,
      [s.legal_entity_id, s.department_id],
    );
  }

  createSurvey(input: SurveyInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = (await one<{ id: string }>(
        tx,
        `insert into surveys (tenant_id, title, description, min_responses, questions, legal_entity_id, department_id, closes_on, created_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [input.title, input.description, input.minResponses, JSON.stringify(input.questions), input.legalEntityId, input.departmentId, input.closesOn, actor.membershipId],
      ))!;
      await this.audit.record(tx, { action: 'survey.created', resourceType: 'survey', resourceId: r.id, changes: input });
      return { id: r.id };
    });
  }

  updateSurvey(id: string, input: SurveyInput) {
    return this.db.tenant(async (tx) => {
      const s = await this.survey(tx, id, true);
      if (s.status !== 'draft') throw Errors.conflict('invalid_state', 'Only a draft survey can be changed, so every answer responds to the same questions');
      await tx.query(
        `update surveys set title = $2, description = $3, min_responses = $4, questions = $5, legal_entity_id = $6, department_id = $7, closes_on = $8 where id = $1`,
        [id, input.title, input.description, input.minResponses, JSON.stringify(input.questions), input.legalEntityId, input.departmentId, input.closesOn],
      );
      await this.audit.record(tx, { action: 'survey.updated', resourceType: 'survey', resourceId: id, changes: input });
      return { id };
    });
  }

  removeSurvey(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.survey(tx, id, true);
      if (s.status !== 'draft') throw Errors.conflict('invalid_state', 'Only a draft survey can be deleted. Close it instead.');
      await tx.query('delete from surveys where id = $1', [id]);
      await this.audit.record(tx, { action: 'survey.deleted', resourceType: 'survey', resourceId: id });
    });
  }

  openSurvey(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.survey(tx, id, true);
      if (s.status !== 'draft') throw Errors.conflict('invalid_state', 'This survey has already been opened');
      const today = new Date().toISOString().slice(0, 10);
      if (s.closes_on && s.closes_on < today) throw Errors.badRequest('closes_in_past', 'The closing date has passed');
      const people = await this.audience(tx, s);
      if (people.length < s.min_responses) {
        throw Errors.badRequest('audience_too_small', `Only ${people.length} people can answer, fewer than the anonymity threshold of ${s.min_responses}, so results could never be shown. Widen the audience or lower the threshold (at least 3).`);
      }
      await tx.query(
        `insert into survey_invitations (tenant_id, survey_id, employee_id) select app_tenant_id(), $1, x from unnest($2::uuid[]) x`,
        [id, people.map((p) => p.id)],
      );
      await tx.query(`update surveys set status = 'open', opened_at = now() where id = $1`, [id]);
      await this.notifications.notify(tx, { membershipIds: people.map((p) => p.membership_id), kind: 'survey.opened', title: `New anonymous survey: ${s.title}`, link: '/surveys' });
      await this.audit.record(tx, { action: 'survey.opened', resourceType: 'survey', resourceId: id, metadata: { invited: people.length } });
      return { invited: people.length };
    });
  }

  closeSurvey(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.survey(tx, id, true);
      if (s.status !== 'open') throw Errors.conflict('invalid_state', 'Only an open survey can be closed');
      await tx.query(`update surveys set status = 'closed', closed_at = now() where id = $1`, [id]);
      await this.audit.record(tx, { action: 'survey.closed', resourceType: 'survey', resourceId: id });
      return { status: 'closed' };
    });
  }

  /** Results with the anonymity threshold applied. Viewing results is audited. */
  results(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.survey(tx, id);
      if (s.status === 'draft') throw Errors.conflict('invalid_state', 'This survey has not been opened yet');
      const counts = (await one<{ invited: number; responded: number }>(
        tx, `select count(*)::int as invited, count(*) filter (where responded)::int as responded from survey_invitations where survey_id = $1`, [id],
      ))!;
      const k = s.min_responses;
      await this.audit.record(tx, { action: 'survey.results_viewed', resourceType: 'survey', resourceId: id });
      const base = { id, title: s.title, minResponses: k, invited: counts.invited, responded: counts.responded, notice: `Results appear only when at least ${k} people have answered, and groups smaller than ${k} are never shown on their own.` };
      if (counts.responded < k) return { ...base, shown: false, reason: `Fewer than ${k} responses so far` };
      const responses = await many<{ answers: SurveyAnswers; department_id: string | null; department_name: string | null }>(
        tx,
        `select r.answers, r.department_id, d.name as department_name from survey_responses r left join departments d on d.id = r.department_id where r.survey_id = $1`,
        [id],
      );
      const groups = new Map<string, { key: string; label: string; answers: SurveyAnswers[] }>();
      for (const r of responses) {
        const key = r.department_id ?? 'none';
        if (!groups.has(key)) groups.set(key, { key, label: r.department_name ?? 'No department', answers: [] });
        groups.get(key)!.answers.push(r.answers);
      }
      const breakdown = talentMath.anonymousBreakdown([...groups.values()].map((g) => ({ key: g.key, label: g.label, count: g.answers.length })), k);
      const scoreQuestions = s.questions.filter((q) => q.kind !== 'text');
      const groupSummary = (label: string, answers: SurveyAnswers[]) => ({
        label,
        count: answers.length,
        questions: talentMath.summariseSurvey(scoreQuestions, answers).map((q) => ({ id: q.id, average: q.average, enps: q.enps })),
      });
      return {
        ...base,
        shown: true,
        questions: talentMath.summariseSurvey(s.questions, responses.map((r) => r.answers)),
        breakdown: breakdown.shown
          ? {
              shown: true,
              groups: [
                ...breakdown.groups.map((g) => groupSummary(g.label, groups.get(g.key)!.answers)),
                ...(breakdown.merged ? [groupSummary('Other groups', breakdown.merged.keys.flatMap((key) => groups.get(key)!.answers))] : []),
              ],
            }
          : breakdown,
      };
    });
  }

  // Surveys (respondent) ------------------------------------------------------------------------------------------

  async mySurveys() {
    return this.db.tenant(async (tx) => {
      const me = (await this.authz.subject(tx)).employeeId;
      if (!me) return [];
      return many(
        tx,
        `select s.id, s.title, s.description, ${effectiveStatus} as status, to_char(s.closes_on, 'YYYY-MM-DD') as "closesOn", i.responded, jsonb_array_length(s.questions) as questions
           from survey_invitations i join surveys s on s.id = i.survey_id where i.employee_id = $1 and s.status <> 'draft'
          order by (${effectiveStatus} = 'open' and not i.responded) desc, s.opened_at desc limit 50`,
        [me],
      );
    });
  }

  async form(id: string) {
    return this.db.tenant(async (tx) => {
      const me = (await this.authz.subject(tx)).employeeId;
      const r = await one<Record<string, unknown>>(
        tx,
        `select s.id, s.title, s.description, ${effectiveStatus} as status, s.questions, to_char(s.closes_on, 'YYYY-MM-DD') as "closesOn", i.responded
           from survey_invitations i join surveys s on s.id = i.survey_id where s.id = $1 and i.employee_id = $2 and s.status <> 'draft'`,
        [id, me ?? null],
      );
      if (!r) throw Errors.notFound('Survey');
      return { ...r, notice: 'This survey is anonymous. CREW stores your answers without your name, keeping only your department and the date, and shows results only for groups large enough that nobody can be singled out.' };
    });
  }

  async respond(id: string, answers: SurveyAnswers) {
    return this.db.tenant(async (tx) => {
      const me = needEmployee((await this.authz.subject(tx)).employeeId);
      const s = await this.survey(tx, id);
      const inv = await one<{ responded: boolean }>(tx, 'select responded from survey_invitations where survey_id = $1 and employee_id = $2 for update', [id, me]);
      if (!inv || s.status === 'draft') throw Errors.notFound('Survey');
      const today = new Date().toISOString().slice(0, 10);
      if (s.status !== 'open' || (s.closes_on && s.closes_on < today)) throw Errors.conflict('survey_closed', 'This survey is closed');
      if (inv.responded) throw Errors.conflict('already_responded', 'You have already answered this survey');
      const problem = talentMath.validateSurveyAnswers(s.questions, answers);
      if (problem) throw Errors.badRequest('invalid_answers', problem);
      const clean: SurveyAnswers = {};
      for (const q of s.questions) {
        const v = answers[q.id];
        if (v !== undefined && v !== null && v !== '') clean[q.id] = typeof v === 'string' ? v.trim() : v;
      }
      const e = await talentEmployee(tx, me);
      await tx.query(
        `insert into survey_responses (tenant_id, survey_id, department_id, legal_entity_id, answers) values (app_tenant_id(), $1, $2, $3, $4)`,
        [id, e.department_id, e.legal_entity_id, JSON.stringify(clean)],
      );
      await tx.query('update survey_invitations set responded = true where survey_id = $1 and employee_id = $2', [id, me]);
      // The audit trail records that someone answered, not who: no actor-specific metadata is added here.
      return { responded: true };
    });
  }

  // Company values and recognition -------------------------------------------------------------------------------

  values(includeArchived = false) {
    return this.db.tenant((tx) =>
      many(tx, `select id, name, description, archived_at as "archivedAt" from company_values where ($1 or archived_at is null) order by archived_at is not null, name`, [includeArchived]),
    );
  }

  createValue(input: { name: string; description: string }) {
    return this.db.tenant(async (tx) => {
      const r = (await one<{ id: string }>(tx, 'insert into company_values (tenant_id, name, description) values (app_tenant_id(), $1, $2) returning id', [input.name, input.description]))!;
      await this.audit.record(tx, { action: 'company_value.created', resourceType: 'company_value', resourceId: r.id, changes: input });
      return { id: r.id };
    });
  }

  updateValue(id: string, input: { name: string; description: string }) {
    return this.db.tenant(async (tx) => {
      const r = await one(tx, 'update company_values set name = $2, description = $3 where id = $1 and archived_at is null returning id', [id, input.name, input.description]);
      if (!r) throw Errors.notFound('Value');
      await this.audit.record(tx, { action: 'company_value.updated', resourceType: 'company_value', resourceId: id, changes: input });
      return { id };
    });
  }

  archiveValue(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await one(tx, 'update company_values set archived_at = now() where id = $1 and archived_at is null returning id', [id]);
      if (!r) throw Errors.notFound('Value');
      await this.audit.record(tx, { action: 'company_value.archived', resourceType: 'company_value', resourceId: id });
    });
  }

  async feed(q: { employeeId?: string; before?: string }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const moderator = hasPermission(s, 'engagement:manage').allowed;
      return many(
        tx,
        `select r.id, r.from_employee_id as "fromEmployeeId", ${nameOf('f')} as "fromName", r.to_employee_id as "toEmployeeId", ${nameOf('t')} as "toName",
                d.name as "toDepartmentName", v.name as "valueName", r.message, r.created_at as "createdAt",
                case when $1 then r.hidden_at end as "hiddenAt", case when $1 then r.hidden_reason end as "hiddenReason"
           from recognitions r join employees f on f.id = r.from_employee_id join employees t on t.id = r.to_employee_id
           left join departments d on d.id = t.current_department_id left join company_values v on v.id = r.value_id
          where ($1 or r.hidden_at is null) and ($2::uuid is null or r.to_employee_id = $2 or r.from_employee_id = $2)
            and ($3::timestamptz is null or r.created_at < $3)
          order by r.created_at desc limit 50`,
        [moderator, q.employeeId ?? null, q.before ?? null],
      );
    });
  }

  async give(input: { toEmployeeId: string; valueId: string | null; message: string }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const from = await talentEmployee(tx, needEmployee(s.employeeId));
      if (input.toEmployeeId === from.id) throw Errors.badRequest('self_recognition', 'Recognise a colleague, not yourself');
      const to = await talentEmployee(tx, input.toEmployeeId, 'Colleague');
      if (to.status === 'exited') throw Errors.badRequest('employee_exited', `${to.name} has left`);
      if (input.valueId && !(await one(tx, 'select 1 from company_values where id = $1 and archived_at is null', [input.valueId]))) {
        throw Errors.badRequest('unknown_value', 'Choose one of the company values');
      }
      const today = (await one<{ n: number }>(tx, `select count(*)::int as n from recognitions where from_employee_id = $1 and created_at > now() - interval '1 day'`, [from.id]))!;
      if (today.n >= RECOGNITIONS_PER_DAY) throw Errors.tooMany(`You can post up to ${RECOGNITIONS_PER_DAY} recognitions a day`);
      const r = (await one<{ id: string }>(
        tx,
        'insert into recognitions (tenant_id, from_employee_id, to_employee_id, value_id, message) values (app_tenant_id(), $1, $2, $3, $4) returning id',
        [from.id, to.id, input.valueId, input.message],
      ))!;
      await this.notifications.notify(tx, { membershipIds: [to.membership_id], kind: 'recognition.received', title: `${from.name} recognised you: "${input.message.slice(0, 80)}${input.message.length > 80 ? '…' : ''}"`, link: '/recognition' });
      if (to.manager_membership_id && to.manager_membership_id !== s.membershipId) {
        await this.notifications.notify(tx, { membershipIds: [to.manager_membership_id], kind: 'recognition.team', title: `${from.name} recognised ${to.name}`, link: '/recognition' });
      }
      await this.audit.record(tx, { action: 'recognition.given', resourceType: 'recognition', resourceId: r.id, metadata: { to: to.id } });
      return { id: r.id };
    });
  }

  async hide(id: string, reason: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await one(tx, 'update recognitions set hidden_at = now(), hidden_by_membership_id = $2, hidden_reason = $3 where id = $1 and hidden_at is null returning id', [id, actor.membershipId, reason]);
      if (!r) throw Errors.notFound('Recognition');
      await this.audit.record(tx, { action: 'recognition.hidden', resourceType: 'recognition', resourceId: id, metadata: { reason } });
    });
  }
}
