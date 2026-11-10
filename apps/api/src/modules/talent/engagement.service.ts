import { Injectable } from '@nestjs/common';
import { type SurveyAnswers, type SurveyInput, type SurveyQuestion, talentMath } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, descendants } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { employeeNames, fieldById } from '../employees/employee-view';
import { needEmployee, talentEmployee } from './talent-common';

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const today = () => new Date().toISOString().slice(0, 10);
/** A survey past its closing date accepts no more answers, even before an admin closes it. */
const effectiveStatus = (s: Doc): string => (s.status === 'open' && s.closes_on && s.closes_on < today() ? 'closed' : s.status);

/**
 * Engagement: anonymous pulse surveys and the recognition wall.
 *
 * Surveys store answers without the respondent. Only the department and legal entity at the time and the date are
 * kept, and results respect the anonymity threshold (see talent-math). Nobody, including admins, can see who said
 * what through SampCrew.
 */
@Injectable()
export class EngagementService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private async survey(tx: TenantTx, id: string, lock = false): Promise<SurveyRow> {
    const surveys = tx.collection('surveys');
    if (lock) await surveys.lock({ id });
    const s = await surveys.findOne({ id });
    if (!s) throw Errors.notFound('Survey');
    return {
      id: s.id, title: s.title, status: s.status, min_responses: s.min_responses, questions: s.questions, legal_entity_id: s.legal_entity_id ?? null,
      department_id: s.department_id ?? null, closes_on: s.closes_on ?? null,
    };
  }

  // Surveys (admin) -----------------------------------------------------------------------------------------------

  listSurveys() {
    return this.db.tenant(async (tx) => {
      const surveys = await tx.collection('surveys').find({}, { sort: { created_at: -1 }, limit: 200 });
      const entities = await fieldById(tx, 'legal_entities', surveys.map((x) => x.legal_entity_id));
      const depts = await fieldById(tx, 'departments', surveys.map((x) => x.department_id));
      const invitations = await tx.collection('survey_invitations').find({ survey_id: { $in: surveys.map((x) => x.id) } }, { projection: { survey_id: 1, responded: 1 } });
      return surveys.map((x) => {
        const mine = invitations.filter((i) => i.survey_id === x.id);
        return {
          id: x.id, title: x.title, status: effectiveStatus(x), minResponses: x.min_responses, closesOn: x.closes_on ?? null,
          legalEntityName: entities.get(x.legal_entity_id) ?? null, departmentName: depts.get(x.department_id) ?? null, openedAt: x.opened_at ?? null, closedAt: x.closed_at ?? null,
          questions: (x.questions ?? []).length, invited: mine.length, responded: mine.filter((i) => i.responded).length,
        };
      });
    });
  }

  async getSurvey(id: string) {
    return this.db.tenant(async (tx) => {
      await this.survey(tx, id);
      const x = (await tx.collection('surveys').findOne({ id }))!;
      return {
        id: x.id, title: x.title, description: x.description, status: effectiveStatus(x), minResponses: x.min_responses, questions: x.questions, legalEntityId: x.legal_entity_id ?? null,
        departmentId: x.department_id ?? null, closesOn: x.closes_on ?? null, openedAt: x.opened_at ?? null, closedAt: x.closed_at ?? null,
      };
    });
  }

  private async audience(tx: TenantTx, s: { legal_entity_id: string | null; department_id: string | null }) {
    const filter: Doc = { status: { $in: ['probation', 'active', 'notice'] }, membership_id: { $ne: null } };
    if (s.legal_entity_id) filter.current_legal_entity_id = s.legal_entity_id;
    if (s.department_id) filter.current_department_id = { $in: [s.department_id, ...(await descendants(tx, 'departments', 'parent_id', s.department_id))] };
    return (await tx.collection('employees').find(filter, { projection: { membership_id: 1 } })).map((e) => ({ id: e.id as string, membership_id: (e.membership_id as string | null) ?? null }));
  }

  createSurvey(input: SurveyInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('surveys').insert({
        title: input.title, description: input.description, min_responses: input.minResponses, questions: input.questions, legal_entity_id: input.legalEntityId ?? null,
        department_id: input.departmentId ?? null, closes_on: input.closesOn ?? null, created_by_membership_id: actor.membershipId,
      });
      await this.audit.record(tx, { action: 'survey.created', resourceType: 'survey', resourceId: r.id, changes: input });
      return { id: r.id as string };
    });
  }

  updateSurvey(id: string, input: SurveyInput) {
    return this.db.tenant(async (tx) => {
      const s = await this.survey(tx, id, true);
      if (s.status !== 'draft') throw Errors.conflict('invalid_state', 'Only a draft survey can be changed, so every answer responds to the same questions');
      await tx.collection('surveys').updateOne({ id }, {
        $set: {
          title: input.title, description: input.description, min_responses: input.minResponses, questions: input.questions, legal_entity_id: input.legalEntityId ?? null,
          department_id: input.departmentId ?? null, closes_on: input.closesOn ?? null,
        },
      });
      await this.audit.record(tx, { action: 'survey.updated', resourceType: 'survey', resourceId: id, changes: input });
      return { id };
    });
  }

  removeSurvey(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.survey(tx, id, true);
      if (s.status !== 'draft') throw Errors.conflict('invalid_state', 'Only a draft survey can be deleted. Close it instead.');
      await tx.collection('surveys').deleteOne({ id });
      await this.audit.record(tx, { action: 'survey.deleted', resourceType: 'survey', resourceId: id });
    });
  }

  openSurvey(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.survey(tx, id, true);
      if (s.status !== 'draft') throw Errors.conflict('invalid_state', 'This survey has already been opened');
      if (s.closes_on && s.closes_on < today()) throw Errors.badRequest('closes_in_past', 'The closing date has passed');
      const people = await this.audience(tx, s);
      if (people.length < s.min_responses) {
        throw Errors.badRequest('audience_too_small', `Only ${people.length} people can answer, fewer than the anonymity threshold of ${s.min_responses}, so results could never be shown. Widen the audience or lower the threshold (at least 3).`);
      }
      await tx.collection('survey_invitations').insertMany(people.map((p) => ({ survey_id: id, employee_id: p.id })));
      await tx.collection('surveys').updateOne({ id }, { $set: { status: 'open', opened_at: new Date() } });
      await this.notifications.notify(tx, { membershipIds: people.map((p) => p.membership_id), kind: 'survey.opened', title: `New anonymous survey: ${s.title}`, link: '/surveys' });
      await this.audit.record(tx, { action: 'survey.opened', resourceType: 'survey', resourceId: id, metadata: { invited: people.length } });
      return { invited: people.length };
    });
  }

  closeSurvey(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.survey(tx, id, true);
      if (s.status !== 'open') throw Errors.conflict('invalid_state', 'Only an open survey can be closed');
      await tx.collection('surveys').updateOne({ id }, { $set: { status: 'closed', closed_at: new Date() } });
      await this.audit.record(tx, { action: 'survey.closed', resourceType: 'survey', resourceId: id });
      return { status: 'closed' };
    });
  }

  /** Results with the anonymity threshold applied. Viewing results is audited. */
  results(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.survey(tx, id);
      if (s.status === 'draft') throw Errors.conflict('invalid_state', 'This survey has not been opened yet');
      const invitations = tx.collection('survey_invitations');
      const counts = { invited: await invitations.count({ survey_id: id }), responded: await invitations.count({ survey_id: id, responded: true }) };
      const k = s.min_responses;
      await this.audit.record(tx, { action: 'survey.results_viewed', resourceType: 'survey', resourceId: id });
      const base = { id, title: s.title, minResponses: k, invited: counts.invited, responded: counts.responded, notice: `Results appear only when at least ${k} people have answered, and groups smaller than ${k} are never shown on their own.` };
      if (counts.responded < k) return { ...base, shown: false, reason: `Fewer than ${k} responses so far` };
      const rows = await tx.collection('survey_responses').find({ survey_id: id }, { projection: { answers: 1, department_id: 1 } });
      const deptNames = await fieldById(tx, 'departments', rows.map((x) => x.department_id));
      const responses = rows.map((x) => ({ answers: x.answers as SurveyAnswers, department_id: (x.department_id as string | null) ?? null, department_name: deptNames.get(x.department_id) ?? null }));
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
      const invitations = await tx.collection('survey_invitations').find({ employee_id: me }, { projection: { survey_id: 1, responded: 1 } });
      const responded = new Map(invitations.map((i) => [i.survey_id as string, i.responded as boolean]));
      const surveys = await tx.collection('surveys').find({ id: { $in: [...responded.keys()] }, status: { $ne: 'draft' } });
      const pending = (x: Doc) => effectiveStatus(x) === 'open' && !responded.get(x.id);
      surveys.sort((a, b) => Number(pending(b)) - Number(pending(a)) || new Date(b.opened_at ?? 0).getTime() - new Date(a.opened_at ?? 0).getTime());
      return surveys.slice(0, 50).map((x) => ({
        id: x.id, title: x.title, description: x.description, status: effectiveStatus(x), closesOn: x.closes_on ?? null, responded: responded.get(x.id) ?? false, questions: (x.questions ?? []).length,
      }));
    });
  }

  async form(id: string) {
    return this.db.tenant(async (tx) => {
      const me = (await this.authz.subject(tx)).employeeId;
      const inv = me ? await tx.collection('survey_invitations').findOne({ survey_id: id, employee_id: me }, { projection: { responded: 1 } }) : undefined;
      const x = inv ? await tx.collection('surveys').findOne({ id, status: { $ne: 'draft' } }) : undefined;
      if (!inv || !x) throw Errors.notFound('Survey');
      const r = { id: x.id, title: x.title, description: x.description, status: effectiveStatus(x), questions: x.questions, closesOn: x.closes_on ?? null, responded: inv.responded };
      return { ...r, notice: 'This survey is anonymous. SampCrew stores your answers without your name, keeping only your department and the date, and shows results only for groups large enough that nobody can be singled out.' };
    });
  }

  async respond(id: string, answers: SurveyAnswers) {
    return this.db.tenant(async (tx) => {
      const me = needEmployee((await this.authz.subject(tx)).employeeId);
      const s = await this.survey(tx, id);
      const invitations = tx.collection('survey_invitations');
      await invitations.lock({ survey_id: id, employee_id: me });
      const inv = await invitations.findOne({ survey_id: id, employee_id: me }, { projection: { responded: 1 } });
      if (!inv || s.status === 'draft') throw Errors.notFound('Survey');
      if (s.status !== 'open' || (s.closes_on && s.closes_on < today())) throw Errors.conflict('survey_closed', 'This survey is closed');
      if (inv.responded) throw Errors.conflict('already_responded', 'You have already answered this survey');
      const problem = talentMath.validateSurveyAnswers(s.questions, answers);
      if (problem) throw Errors.badRequest('invalid_answers', problem);
      const clean: SurveyAnswers = {};
      for (const q of s.questions) {
        const v = answers[q.id];
        if (v !== undefined && v !== null && v !== '') clean[q.id] = typeof v === 'string' ? v.trim() : v;
      }
      const e = await talentEmployee(tx, me);
      await tx.collection('survey_responses').insert({ survey_id: id, department_id: e.department_id, legal_entity_id: e.legal_entity_id, answers: clean });
      await invitations.updateOne({ survey_id: id, employee_id: me }, { $set: { responded: true } });
      // The audit trail records that someone answered, not who: no actor-specific metadata is added here.
      return { responded: true };
    });
  }

  // Company values and recognition -------------------------------------------------------------------------------

  values(includeArchived = false) {
    return this.db.tenant(async (tx) => {
      const rows = await tx.collection('company_values').find(includeArchived ? {} : { archived_at: null });
      rows.sort((a, b) => Number(!!a.archived_at) - Number(!!b.archived_at) || String(a.name).localeCompare(String(b.name)));
      return rows.map((v) => ({ id: v.id, name: v.name, description: v.description, archivedAt: v.archived_at ?? null }));
    });
  }

  createValue(input: { name: string; description: string }) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('company_values').insert({ name: input.name, description: input.description });
      await this.audit.record(tx, { action: 'company_value.created', resourceType: 'company_value', resourceId: r.id, changes: input });
      return { id: r.id as string };
    });
  }

  updateValue(id: string, input: { name: string; description: string }) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('company_values').updateOne({ id, archived_at: null }, { $set: { name: input.name, description: input.description } });
      if (!r) throw Errors.notFound('Value');
      await this.audit.record(tx, { action: 'company_value.updated', resourceType: 'company_value', resourceId: id, changes: input });
      return { id };
    });
  }

  archiveValue(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('company_values').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date() } });
      if (!r) throw Errors.notFound('Value');
      await this.audit.record(tx, { action: 'company_value.archived', resourceType: 'company_value', resourceId: id });
    });
  }

  async feed(q: { employeeId?: string; before?: string }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const moderator = hasPermission(s, 'engagement:manage').allowed;
      const filter: Doc = {};
      if (!moderator) filter.hidden_at = null;
      if (q.employeeId) filter.$or = [{ to_employee_id: q.employeeId }, { from_employee_id: q.employeeId }];
      if (q.before) filter.created_at = { $lt: new Date(q.before) };
      const rows = await tx.collection('recognitions').find(filter, { sort: { created_at: -1 }, limit: 50 });
      const people = await employeeNames(tx, rows.flatMap((r) => [r.from_employee_id, r.to_employee_id]));
      const depts = await fieldById(tx, 'departments', [...people.values()].map((p) => p.doc.current_department_id));
      const values = await fieldById(tx, 'company_values', rows.map((r) => r.value_id));
      return rows
        .filter((r) => people.has(r.from_employee_id) && people.has(r.to_employee_id))
        .map((r) => ({
          id: r.id, fromEmployeeId: r.from_employee_id, fromName: people.get(r.from_employee_id)!.name, toEmployeeId: r.to_employee_id, toName: people.get(r.to_employee_id)!.name,
          toDepartmentName: depts.get(people.get(r.to_employee_id)!.doc.current_department_id) ?? null, valueName: values.get(r.value_id) ?? null, message: r.message, createdAt: r.created_at,
          hiddenAt: moderator ? (r.hidden_at ?? null) : null, hiddenReason: moderator ? (r.hidden_reason ?? null) : null,
        }));
    });
  }

  async give(input: { toEmployeeId: string; valueId: string | null; message: string }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const from = await talentEmployee(tx, needEmployee(s.employeeId));
      if (input.toEmployeeId === from.id) throw Errors.badRequest('self_recognition', 'Recognise a colleague, not yourself');
      const to = await talentEmployee(tx, input.toEmployeeId, 'Colleague');
      if (to.status === 'exited') throw Errors.badRequest('employee_exited', `${to.name} has left`);
      if (input.valueId && !(await tx.collection('company_values').exists({ id: input.valueId, archived_at: null }))) {
        throw Errors.badRequest('unknown_value', 'Choose one of the company values');
      }
      const lastDay = await tx.collection('recognitions').count({ from_employee_id: from.id, created_at: { $gt: new Date(Date.now() - 86_400_000) } });
      if (lastDay >= RECOGNITIONS_PER_DAY) throw Errors.tooMany(`You can post up to ${RECOGNITIONS_PER_DAY} recognitions a day`);
      const r = await tx.collection('recognitions').insert({ from_employee_id: from.id, to_employee_id: to.id, value_id: input.valueId, message: input.message });
      await this.notifications.notify(tx, { membershipIds: [to.membership_id], kind: 'recognition.received', title: `${from.name} recognised you: "${input.message.slice(0, 80)}${input.message.length > 80 ? '…' : ''}"`, link: '/recognition' });
      if (to.manager_membership_id && to.manager_membership_id !== s.membershipId) {
        await this.notifications.notify(tx, { membershipIds: [to.manager_membership_id], kind: 'recognition.team', title: `${from.name} recognised ${to.name}`, link: '/recognition' });
      }
      await this.audit.record(tx, { action: 'recognition.given', resourceType: 'recognition', resourceId: r.id, metadata: { to: to.id } });
      return { id: r.id as string };
    });
  }

  async hide(id: string, reason: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('recognitions').updateOne({ id, hidden_at: null }, { $set: { hidden_at: new Date(), hidden_by_membership_id: actor.membershipId, hidden_reason: reason } });
      if (!r) throw Errors.notFound('Recognition');
      await this.audit.record(tx, { action: 'recognition.hidden', resourceType: 'recognition', resourceId: id, metadata: { reason } });
    });
  }
}
