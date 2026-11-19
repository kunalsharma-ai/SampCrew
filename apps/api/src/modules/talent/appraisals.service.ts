import { Injectable } from '@nestjs/common';
import {
  type AnswerMap,
  type AppraisalCycleInput,
  type AppraisalDefinition,
  type AppraisalFormInput,
  type appraisalHrInput,
  type appraisalReopenInput,
  APPRAISAL_TEMPLATES,
  type AppraisalStage,
  type AppraisalTemplateKey,
  completion,
  computeAppraisal,
  levelFor,
  missingAnswers,
  sectionsFor,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { displayName, fieldById } from '../employees/employee-view';
import { needEmployee } from './talent-common';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
type Role = 'employee' | 'manager' | 'hr';

const STAGE_ORDER: AppraisalStage[] = ['self', 'manager', 'hr', 'finalized', 'published'];
const after = (a: AppraisalStage, b: AppraisalStage) => STAGE_ORDER.indexOf(a) > STAGE_ORDER.indexOf(b);
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

function formView(f: Doc) {
  return {
    id: f.id as string, name: f.name as string, description: (f.description ?? null) as string | null, active: f.active as boolean, isDefault: f.is_default as boolean,
    audience: f.audience as string, departmentIds: (f.department_ids ?? []) as string[], designationIds: (f.designation_ids ?? []) as string[], version: f.version as number,
    templateKey: (f.template_key ?? null) as string | null, definition: f.definition as AppraisalDefinition, updatedAt: f.updated_at,
  };
}

/**
 * Appraisals with a form HR builds. A cycle copies each person's form at launch (so editing a form never changes an
 * appraisal in progress), then runs three stages: the employee scores themselves and answers the self questions;
 * the reporting manager gives independent scores and feedback; HR reviews, optionally scores, can override a
 * question's final score or the final percentage with a reason, finalises and publishes. Scores lock when a stage is
 * submitted unless HR reopens it. Every step is kept in the appraisal's history and the audit trail.
 */
@Injectable()
export class AppraisalsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private isHr(s: Subject) {
    return hasPermission(s, 'performance:configure').allowed;
  }

  private requireHr(s: Subject) {
    if (!this.isHr(s)) throw Errors.forbidden('Only HR can do this');
  }

  private entry(action: string, stage: AppraisalStage, note?: string | null) {
    return { at: new Date(), by: requestContext.tenantActor().membershipId, action, stage, note: note ?? null };
  }

  /** Memberships that review appraisals in HR: the cycle's named reviewers, or everyone who runs appraisals. */
  private async hrReviewers(tx: TenantTx, cycle: Doc): Promise<string[]> {
    if (cycle.hr_reviewer_membership_ids?.length) return cycle.hr_reviewer_membership_ids;
    const roleIds = await tx.collection('role_permissions').distinct<string>('role_id', { permission: 'performance:configure' });
    const members = await tx.collection('role_assignments').distinct<string>('membership_id', { role_id: { $in: roleIds } });
    return tx.collection('memberships').distinct<string>('id', { id: { $in: members }, status: 'active' });
  }

  // Forms --------------------------------------------------------------------------------------------------------

  async listForms() {
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      const forms = await tx.collection('appraisal_forms').find({ archived_at: null }, { sort: { is_default: -1, name: 1 } });
      return { forms: forms.map(formView), templates: APPRAISAL_TEMPLATES.map((t) => ({ key: t.key, name: t.name, added: forms.some((f) => f.template_key === t.key) })) };
    });
  }

  async getForm(id: string) {
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      const f = await tx.collection('appraisal_forms').findOne({ id, archived_at: null });
      if (!f) throw Errors.notFound('Appraisal form');
      return formView(f);
    });
  }

  private async saveForm(tx: TenantTx, input: AppraisalFormInput, id?: string, templateKey?: string) {
    const actor = requestContext.tenantActor();
    if (input.isDefault) await tx.collection('appraisal_forms').update({ is_default: true, ...(id ? { id: { $ne: id } } : {}) }, { $set: { is_default: false } });
    const cols = {
      name: input.name, description: input.description ?? null, active: input.active, is_default: input.isDefault, audience: input.audience,
      department_ids: input.departmentIds, designation_ids: input.designationIds, definition: input.definition, updated_by_membership_id: actor.membershipId,
    };
    if (id) {
      const n = await tx.collection('appraisal_forms').updateOne({ id, archived_at: null }, { $set: cols, $inc: { version: 1 } });
      if (!n) throw Errors.notFound('Appraisal form');
      await this.audit.record(tx, { action: 'appraisal_form.updated', resourceType: 'appraisal_form', resourceId: id, changes: { name: input.name, sections: input.definition.sections.length } });
      return formView((await tx.collection('appraisal_forms').findOne({ id }))!);
    }
    const row = await tx.collection('appraisal_forms').insert({ ...cols, template_key: templateKey ?? null, created_by_membership_id: actor.membershipId });
    await this.audit.record(tx, { action: 'appraisal_form.created', resourceType: 'appraisal_form', resourceId: row.id, changes: { name: input.name, template: templateKey ?? null } });
    return formView(row);
  }

  async createForm(input: AppraisalFormInput) {
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      return this.saveForm(tx, input);
    });
  }

  async updateForm(id: string, input: AppraisalFormInput) {
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      return this.saveForm(tx, input, id);
    });
  }

  /** Adds a built-in template (such as the Frequent Research evaluation) as a form HR can then change. */
  async fromTemplate(key: AppraisalTemplateKey) {
    const t = APPRAISAL_TEMPLATES.find((x) => x.key === key);
    if (!t) throw Errors.notFound('Template');
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      const first = !(await tx.collection('appraisal_forms').exists({ archived_at: null }));
      return this.saveForm(tx, { name: t.name, description: null, active: true, isDefault: first, audience: 'all', departmentIds: [], designationIds: [], definition: structuredClone(t.definition) }, undefined, t.key);
    });
  }

  async duplicateForm(id: string) {
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      const f = await tx.collection('appraisal_forms').findOne({ id, archived_at: null });
      if (!f) throw Errors.notFound('Appraisal form');
      const v = formView(f);
      return this.saveForm(tx, { ...v, name: `${v.name} (copy)`.slice(0, 160), isDefault: false, audience: v.audience as 'all' } as AppraisalFormInput);
    });
  }

  async archiveForm(id: string) {
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      if (await tx.collection('appraisal_cycles').exists({ form_id: id, status: { $in: ['draft', 'active'] } })) {
        throw Errors.conflict('form_in_use', 'A draft or running cycle uses this form. Deactivate it instead, or close the cycle first.');
      }
      const n = await tx.collection('appraisal_forms').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date(), is_default: false, active: false } });
      if (!n) throw Errors.notFound('Appraisal form');
      await this.audit.record(tx, { action: 'appraisal_form.archived', resourceType: 'appraisal_form', resourceId: id });
    });
  }

  // Cycles -------------------------------------------------------------------------------------------------------

  private async cycleView(tx: TenantTx, cycles: Doc[]) {
    const forms = await fieldById(tx, 'appraisal_forms', cycles.map((c) => c.form_id));
    const depts = await fieldById(tx, 'departments', cycles.flatMap((c) => c.department_ids ?? []));
    const stats = await tx.collection('appraisals').aggregate<{ id: { cycle: string; stage: string }; n: number }>([
      { $match: { cycle_id: { $in: cycles.map((c) => c.id) } } },
      { $group: { _id: { cycle: '$cycle_id', stage: '$stage' }, n: { $sum: 1 } } },
    ]);
    return cycles.map((c) => {
      const byStage = Object.fromEntries(STAGE_ORDER.map((s) => [s, 0])) as Record<AppraisalStage, number>;
      for (const r of stats) if (r.id.cycle === c.id) byStage[r.id.stage as AppraisalStage] = r.n;
      return {
        id: c.id as string, name: c.name as string, status: c.status as string, formId: (c.form_id ?? null) as string | null, formName: forms.get(c.form_id) ?? null,
        periodStart: c.period_start, periodEnd: c.period_end, selfDue: c.self_due, managerDue: c.manager_due, hrDue: c.hr_due ?? null,
        departmentIds: c.department_ids ?? [], departmentNames: (c.department_ids ?? []).map((d: string) => depts.get(d)).filter(Boolean), hrReviewerMembershipIds: c.hr_reviewer_membership_ids ?? [],
        launchedAt: c.launched_at ?? null, closedAt: c.closed_at ?? null, byStage, participants: Object.values(byStage).reduce((a, b) => a + b, 0),
      };
    });
  }

  async listCycles() {
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      return this.cycleView(tx, await tx.collection('appraisal_cycles').find({}, { sort: { created_at: -1 }, limit: 100 }));
    });
  }

  async createCycle(input: AppraisalCycleInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      if (input.formId && !(await tx.collection('appraisal_forms').exists({ id: input.formId, archived_at: null }))) throw Errors.notFound('Appraisal form');
      const row = await tx.collection('appraisal_cycles').insert({
        name: input.name, form_id: input.formId, period_start: input.periodStart, period_end: input.periodEnd, self_due: input.selfDue, manager_due: input.managerDue,
        hr_due: input.hrDue ?? null, department_ids: input.departmentIds, hr_reviewer_membership_ids: input.hrReviewerMembershipIds, created_by_membership_id: actor.membershipId,
      });
      await this.audit.record(tx, { action: 'appraisal_cycle.created', resourceType: 'appraisal_cycle', resourceId: row.id, changes: { name: input.name } });
      return (await this.cycleView(tx, [row]))[0]!;
    });
  }

  async updateCycle(id: string, input: AppraisalCycleInput) {
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      const c = await tx.collection('appraisal_cycles').findOne({ id });
      if (!c) throw Errors.notFound('Appraisal cycle');
      if (c.status === 'closed') throw Errors.conflict('invalid_state', 'This cycle is closed');
      // Who is in it and which form they use are fixed once it launches; deadlines can still move.
      const fixed = c.status === 'active' ? {} : { form_id: input.formId, department_ids: input.departmentIds };
      await tx.collection('appraisal_cycles').updateOne({ id }, {
        $set: { name: input.name, period_start: input.periodStart, period_end: input.periodEnd, self_due: input.selfDue, manager_due: input.managerDue, hr_due: input.hrDue ?? null, hr_reviewer_membership_ids: input.hrReviewerMembershipIds, ...fixed },
      });
      await this.audit.record(tx, { action: 'appraisal_cycle.updated', resourceType: 'appraisal_cycle', resourceId: id, changes: { name: input.name } });
      return (await this.cycleView(tx, [(await tx.collection('appraisal_cycles').findOne({ id }))!]))[0]!;
    });
  }

  /** Picks the form for a person: the cycle's form, or the best match by designation, department and manager rules. */
  private pickForm(forms: Doc[], e: Doc, isManager: boolean): Doc | undefined {
    let best: { f: Doc; score: number } | undefined;
    for (const f of forms) {
      if (!f.active) continue;
      if (f.department_ids?.length && !f.department_ids.includes(e.current_department_id)) continue;
      if (f.designation_ids?.length && !f.designation_ids.includes(e.current_designation_id)) continue;
      if (f.audience === 'managers' && !isManager) continue;
      if (f.audience === 'non_managers' && isManager) continue;
      const score = (f.designation_ids?.length ? 4 : 0) + (f.department_ids?.length ? 2 : 0) + (f.audience !== 'all' ? 1 : 0) + (f.is_default ? 0.5 : 0);
      if (!best || score > best.score) best = { f, score };
    }
    return best?.f;
  }

  /** Starts the cycle: everyone in it with a login gets their appraisal and a notification. */
  async launch(id: string) {
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      await tx.collection('appraisal_cycles').lock({ id });
      const c = await tx.collection('appraisal_cycles').findOne({ id });
      if (!c) throw Errors.notFound('Appraisal cycle');
      if (c.status !== 'draft') throw Errors.conflict('invalid_state', 'This cycle has already launched');
      const forms = c.form_id ? await tx.collection('appraisal_forms').find({ id: c.form_id, archived_at: null }) : await tx.collection('appraisal_forms').find({ archived_at: null, active: true });
      if (!forms.length) throw Errors.badRequest('no_form', c.form_id ? 'The cycle’s form was removed' : 'Create an active appraisal form first');
      const people = await tx.collection('employees').find({ status: { $in: ['probation', 'active', 'notice'] }, ...(c.department_ids?.length ? { current_department_id: { $in: c.department_ids } } : {}) });
      const managers = new Set(await tx.collection('employees').distinct<string>('current_manager_employee_id', { status: { $ne: 'exited' }, current_manager_employee_id: { $ne: null } }));
      const skipped = { noLogin: 0, noForm: 0 };
      let created = 0;
      for (const e of people) {
        if (!e.membership_id) {
          skipped.noLogin += 1;
          continue;
        }
        const isManager = managers.has(e.id);
        const form = c.form_id ? forms[0] : this.pickForm(forms, e, isManager);
        if (!form) {
          skipped.noForm += 1;
          continue;
        }
        if (await tx.collection('appraisals').exists({ cycle_id: id, employee_id: e.id })) continue;
        await tx.collection('appraisals').insert({
          cycle_id: id, employee_id: e.id, manager_employee_id: e.current_manager_employee_id ?? null, form_id: form.id, definition: form.definition, is_manager: isManager,
          stage: 'self', history: [this.entry('assigned', 'self')],
        });
        created += 1;
        await this.notifications.notify(tx, {
          membershipIds: [e.membership_id],
          kind: 'appraisal.assigned',
          title: `Your appraisal for ${c.name} is open`,
          body: `Complete your self-appraisal by ${c.self_due}.`,
          link: '/appraisal',
          email: true,
        });
      }
      if (!created) throw Errors.badRequest('nobody_eligible', `Nobody could be added: ${skipped.noLogin} without a login, ${skipped.noForm} with no matching form`);
      await tx.collection('appraisal_cycles').updateOne({ id }, { $set: { status: 'active', launched_at: new Date() } });
      await this.audit.record(tx, { action: 'appraisal_cycle.launched', resourceType: 'appraisal_cycle', resourceId: id, metadata: { created, ...skipped } });
      return { created, skipped };
    });
  }

  /** Publishes every finalised appraisal in the cycle to its employee. */
  async publishCycle(id: string) {
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      const rows = await tx.collection('appraisals').find({ cycle_id: id, stage: 'finalized' });
      for (const a of rows) await this.publishOne(tx, a);
      return { published: rows.length };
    });
  }

  async closeCycle(id: string) {
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      const n = await tx.collection('appraisal_cycles').updateOne({ id, status: 'active' }, { $set: { status: 'closed', closed_at: new Date() } });
      if (!n) throw Errors.conflict('invalid_state', 'Only a running cycle can be closed');
      await this.audit.record(tx, { action: 'appraisal_cycle.closed', resourceType: 'appraisal_cycle', resourceId: id });
      return { ok: true };
    });
  }

  async getCycle(id: string) {
    return this.db.tenant(async (tx) => {
      this.requireHr(await this.authz.subject(tx));
      const c = await tx.collection('appraisal_cycles').findOne({ id });
      if (!c) throw Errors.notFound('Appraisal cycle');
      const rows = await tx.collection('appraisals').find({ cycle_id: id });
      return { cycle: (await this.cycleView(tx, [c]))[0]!, appraisals: await this.summaries(tx, rows, 'hr') };
    });
  }

  // Appraisals ----------------------------------------------------------------------------------------------------

  private async summaries(tx: TenantTx, rows: Doc[], role: Role) {
    const people = new Map((await tx.collection('employees').find({ id: { $in: [...new Set(rows.flatMap((a) => [a.employee_id, a.manager_employee_id]).filter(Boolean))] } })).map((e) => [e.id as string, e]));
    const depts = await fieldById(tx, 'departments', [...people.values()].map((e) => e.current_department_id));
    const cycles = new Map((await tx.collection('appraisal_cycles').find({ id: { $in: [...new Set(rows.map((a) => a.cycle_id))] } })).map((c) => [c.id as string, c]));
    return rows.map((a) => {
      const e = people.get(a.employee_id);
      const m = a.manager_employee_id ? people.get(a.manager_employee_id) : undefined;
      const c = cycles.get(a.cycle_id)!;
      const published = a.stage === 'published';
      const showResult = role === 'hr' || published || (role === 'manager' && after(a.stage, 'hr'));
      const r = (a.result ?? {}) as Doc;
      return {
        id: a.id as string, cycleId: a.cycle_id as string, cycleName: c.name as string, periodStart: c.period_start, periodEnd: c.period_end, selfDue: c.self_due, managerDue: c.manager_due, hrDue: c.hr_due ?? null,
        stage: a.stage as AppraisalStage, employeeId: a.employee_id as string, employeeName: e ? displayName(e as never) : null, departmentName: depts.get(e?.current_department_id) ?? null,
        managerName: m ? displayName(m as never) : null, formTitle: (a.definition as AppraisalDefinition).title,
        selfCompletion: completion(a.definition, a.is_manager, 'employee', a.employee_answers ?? {}),
        selfPercent: role === 'employee' || after(a.stage, 'self') || role === 'hr' ? (r.selfPercent ?? null) : null,
        managerPercent: showResult ? (r.managerPercent ?? null) : null,
        finalPercent: showResult ? (r.finalPercent ?? null) : null,
        band: showResult ? (r.band ?? null) : null,
        overdue: (a.stage === 'self' && c.self_due < today()) || (a.stage === 'manager' && c.manager_due < today()) || (a.stage === 'hr' && !!c.hr_due && c.hr_due < today()),
        publishedAt: a.published_at ?? null,
      };
    });
  }

  private async load(tx: TenantTx, id: string, lock = false) {
    if (lock) await tx.collection('appraisals').lock({ id });
    const a = await tx.collection('appraisals').findOne({ id });
    if (!a) throw Errors.notFound('Appraisal');
    const s = await this.authz.subject(tx);
    const cycle = (await tx.collection('appraisal_cycles').findOne({ id: a.cycle_id }))!;
    let role: Role | null = null;
    if (s.employeeId && s.employeeId === a.employee_id) role = 'employee';
    else if (s.employeeId && s.employeeId === a.manager_employee_id) role = 'manager';
    else if (this.isHr(s)) role = 'hr';
    if (!role) throw Errors.notFound('Appraisal');
    return { a, s, cycle, role };
  }

  /** My appraisals: the current one first, then history. */
  async mine() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const me = needEmployee(s.employeeId);
      return this.summaries(tx, await tx.collection('appraisals').find({ employee_id: me }, { sort: { created_at: -1 }, limit: 50 }), 'employee');
    });
  }

  /** Appraisals waiting for me: my team's (as their manager), and those in HR review when I run appraisals. */
  async toReview() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const team = s.employeeId ? await tx.collection('appraisals').find({ manager_employee_id: s.employeeId }, { sort: { created_at: -1 }, limit: 300 }) : [];
      const hr = this.isHr(s) ? await tx.collection('appraisals').find({ stage: { $in: ['hr', 'finalized'] }, employee_id: { $ne: s.employeeId ?? '' } }, { sort: { updated_at: -1 }, limit: 300 }) : [];
      return { team: await this.summaries(tx, team, 'manager'), hr: await this.summaries(tx, hr, 'hr'), isHr: this.isHr(s) };
    });
  }

  /** One appraisal as the caller may see it. */
  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const { a, cycle, role } = await this.load(tx, id);
      return this.detail(tx, a, cycle, role);
    });
  }

  private async detail(tx: TenantTx, a: Doc, cycle: Doc, role: Role) {
    const d = a.definition as AppraisalDefinition;
    const e = (await tx.collection('employees').findOne({ id: a.employee_id }))!;
    const m = a.manager_employee_id ? await tx.collection('employees').findOne({ id: a.manager_employee_id }) : undefined;
    const dept = await fieldById(tx, 'departments', [e.current_department_id]);
    const desig = await fieldById(tx, 'designations', [e.current_designation_id]);
    const names = await membershipUserNames(tx, (a.history ?? []).map((h: Doc) => h.by));
    const published = a.stage === 'published';
    // What each role sees: the employee sees the manager's and HR's parts once published; the manager sees the
    // employee's once submitted and HR's once finalised; HR sees everything.
    const seeEmployee = role !== 'manager' || after(a.stage, 'self');
    const seeManager = role === 'hr' || role === 'manager' || published;
    const seeHr = role === 'hr' || published || (role === 'manager' && after(a.stage, 'hr'));
    const result = computeAppraisal(d, a.is_manager, { employee: a.employee_answers, manager: a.manager_answers, hr: a.hr_answers, finalScores: a.final_scores ?? {}, finalPercent: a.final_percent_override === null || a.final_percent_override === undefined ? null : Number(a.final_percent_override) });
    const canEdit = (role === 'employee' && a.stage === 'self') || (role === 'manager' && a.stage === 'manager') || (role === 'hr' && a.stage === 'hr');
    return {
      id: a.id as string, stage: a.stage as AppraisalStage, role, canEdit,
      cycle: { id: cycle.id, name: cycle.name, periodStart: cycle.period_start, periodEnd: cycle.period_end, selfDue: cycle.self_due, managerDue: cycle.manager_due, hrDue: cycle.hr_due ?? null, status: cycle.status },
      employee: {
        name: displayName(e as never), code: e.employee_code ?? null, designation: desig.get(e.current_designation_id) ?? null, department: dept.get(e.current_department_id) ?? null,
        dateOfJoining: e.date_of_joining ?? null, managerName: m ? displayName(m as never) : null,
      },
      reviewDate: (a.finalized_at ?? a.manager_submitted_at ?? a.self_submitted_at ?? a.created_at) as string,
      definition: { ...d, sections: sectionsFor(d, a.is_manager) },
      answers: {
        employee: seeEmployee ? (a.employee_answers as AnswerMap) : {},
        manager: seeManager ? (a.manager_answers as AnswerMap) : {},
        hr: seeHr ? (a.hr_answers as AnswerMap) : {},
        finalScores: seeHr ? (a.final_scores ?? {}) : {},
      },
      result: {
        selfPercent: seeEmployee ? result.selfPercent : null,
        managerPercent: seeManager ? result.managerPercent : null,
        hrPercent: seeHr ? result.hrPercent : null,
        calculatedPercent: seeHr ? result.calculatedPercent : null,
        finalPercent: seeHr ? result.finalPercent : null,
        band: seeHr ? result.band : null,
        finals: seeHr ? result.finals : {},
        levels: seeHr ? Object.fromEntries(Object.entries(result.finals).map(([k, v]) => [k, levelFor(d, v)])) : {},
      },
      overrideReason: seeHr ? (a.override_reason ?? null) : null,
      finalPercentOverride: role === 'hr' && a.final_percent_override !== null && a.final_percent_override !== undefined ? Number(a.final_percent_override) : null,
      completion: { employee: completion(d, a.is_manager, 'employee', a.employee_answers), manager: completion(d, a.is_manager, 'manager', a.manager_answers), hr: completion(d, a.is_manager, 'hr', a.hr_answers) },
      selfSubmittedAt: a.self_submitted_at ?? null, managerSubmittedAt: a.manager_submitted_at ?? null, finalizedAt: a.finalized_at ?? null, publishedAt: a.published_at ?? null,
      history: ((a.history ?? []) as Doc[]).map((h) => ({ at: h.at, by: names.get(h.by) ?? null, action: h.action as string, stage: h.stage as string, note: role === 'hr' ? (h.note ?? null) : null })),
    };
  }

  /** Checks answers against the form: known questions, the right part of the form for the role, scores on the scale. */
  private clean(d: AppraisalDefinition, isManager: boolean, role: Role, input: AnswerMap): AnswerMap {
    const sections = sectionsFor(d, isManager);
    const allowed = new Map<string, 'score' | 'text'>();
    for (const s of sections) {
      const mine = s.kind === 'rated' ? role !== 'hr' || d.scoring.hrScores : s.kind === (role === 'employee' ? 'self' : role);
      if (!mine) continue;
      for (const q of s.questions) allowed.set(q.id, q.kind === 'score' ? 'score' : 'text');
    }
    // HR may comment on rated questions even when the form has no HR scores.
    if (role === 'hr') for (const s of sections) if (s.kind === 'rated') for (const q of s.questions) if (!allowed.has(q.id)) allowed.set(q.id, 'text');
    const out: AnswerMap = {};
    for (const [qid, v] of Object.entries(input)) {
      const kind = allowed.get(qid);
      if (!kind) throw Errors.badRequest('unknown_question', 'An answer does not match a question you can answer');
      const a: AnswerMap[string] = {};
      if (v.score !== undefined && v.score !== null) {
        if (kind !== 'score' || (role === 'hr' && !d.scoring.hrScores)) throw Errors.badRequest('not_scored', 'That question takes no score from you');
        if (!Number.isInteger(v.score) || v.score < d.scale.min || v.score > d.scale.max) throw Errors.validation([{ path: `answers.${qid}.score`, message: `Score from ${d.scale.min} to ${d.scale.max}` }]);
        a.score = v.score;
      }
      if (v.comment?.trim()) a.comment = v.comment.trim();
      if (v.text?.trim()) a.text = v.text.trim();
      if (Object.keys(a).length) out[qid] = a;
    }
    return out;
  }

  private async recompute(tx: TenantTx, id: string) {
    const a = (await tx.collection('appraisals').findOne({ id }))!;
    const r = computeAppraisal(a.definition, a.is_manager, { employee: a.employee_answers, manager: a.manager_answers, hr: a.hr_answers, finalScores: a.final_scores ?? {}, finalPercent: a.final_percent_override === null || a.final_percent_override === undefined ? null : Number(a.final_percent_override) });
    await tx.collection('appraisals').updateOne({ id }, { $set: { result: { selfPercent: r.selfPercent, managerPercent: r.managerPercent, hrPercent: r.hrPercent, calculatedPercent: r.calculatedPercent, finalPercent: r.finalPercent, band: r.band } } });
  }

  private column(role: Role) {
    return role === 'employee' ? 'employee_answers' : role === 'manager' ? 'manager_answers' : 'hr_answers';
  }

  /** Saves a draft of the caller's part (the employee, the manager or HR), while their stage is open. */
  async saveDraft(id: string, input: AnswerMap, hr?: z.infer<typeof appraisalHrInput>) {
    return this.db.tenant(async (tx) => {
      const { a, cycle, role } = await this.load(tx, id, true);
      const stage: Record<Role, AppraisalStage> = { employee: 'self', manager: 'manager', hr: 'hr' };
      if (a.stage !== stage[role]) throw Errors.conflict('locked', role === 'employee' ? 'Your self-appraisal is submitted and locked. Ask HR to reopen it.' : 'This part of the appraisal is not open for you now');
      const set: Doc = { [this.column(role)]: this.clean(a.definition, a.is_manager, role, input) };
      if (role === 'hr' && hr) {
        const rated = new Set(sectionsFor(a.definition, a.is_manager).filter((s) => s.kind === 'rated').flatMap((s) => s.questions.map((q) => q.id)));
        const finals: Record<string, number> = {};
        for (const [qid, v] of Object.entries(hr.finalScores)) {
          if (!rated.has(qid)) throw Errors.badRequest('unknown_question', 'A final score does not match a rated question');
          if (v === null) continue;
          if (v < a.definition.scale.min || v > a.definition.scale.max) throw Errors.validation([{ path: `finalScores.${qid}`, message: `Score from ${a.definition.scale.min} to ${a.definition.scale.max}` }]);
          finals[qid] = v;
        }
        set.final_scores = finals;
        if (hr.finalPercent !== null && !hr.overrideReason?.trim()) throw Errors.validation([{ path: 'overrideReason', message: 'Say why the final percentage differs from the calculated one' }]);
        set.final_percent_override = hr.finalPercent === null ? null : String(hr.finalPercent);
        set.override_reason = hr.finalPercent === null ? null : hr.overrideReason!.trim();
      }
      await tx.collection('appraisals').updateOne({ id }, { $set: set });
      await this.recompute(tx, id);
      return this.detail(tx, (await tx.collection('appraisals').findOne({ id }))!, cycle, role);
    });
  }

  /** Submits the caller's stage; the appraisal moves on and the next person is told. */
  async submit(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const { a, cycle, role } = await this.load(tx, id, true);
      const stage: Record<Role, AppraisalStage> = { employee: 'self', manager: 'manager', hr: 'hr' };
      if (a.stage !== stage[role]) throw Errors.conflict('invalid_state', 'This part of the appraisal is not open for you now');
      const answers = a[this.column(role)] as AnswerMap;
      const missing = missingAnswers(a.definition, a.is_manager, role, answers);
      if (missing.length) throw Errors.badRequest('incomplete', `Answer every required question first (${missing.length} left)`);
      const e = (await tx.collection('employees').findOne({ id: a.employee_id }))!;
      const name = displayName(e as never);
      if (role === 'employee') {
        const manager = a.manager_employee_id ? await tx.collection('employees').findOne({ id: a.manager_employee_id }) : undefined;
        const managerLogin = manager?.membership_id && (await tx.collection('memberships').exists({ id: manager.membership_id, status: 'active' })) ? (manager.membership_id as string) : null;
        const next: AppraisalStage = managerLogin ? 'manager' : 'hr';
        await tx.collection('appraisals').updateOne({ id }, { $set: { stage: next, self_submitted_at: new Date() }, $push: { history: this.entry('self_submitted', next) } });
        if (managerLogin) {
          await this.notifications.notify(tx, { membershipIds: [managerLogin], kind: 'appraisal.self_submitted', title: `${name} submitted their self-appraisal`, body: `Your evaluation is due by ${cycle.manager_due}.`, link: `/appraisal/${id}`, email: true });
        } else {
          await this.notifications.notify(tx, { membershipIds: await this.hrReviewers(tx, cycle), kind: 'appraisal.hr_pending', title: `${name}'s appraisal is ready for HR review`, body: 'They have no reporting manager with a login, so it came straight to HR.', link: `/appraisal/${id}` });
        }
      } else if (role === 'manager') {
        await tx.collection('appraisals').updateOne({ id }, { $set: { stage: 'hr', manager_submitted_at: new Date() }, $push: { history: this.entry('manager_submitted', 'hr') } });
        await this.notifications.notify(tx, { membershipIds: (await this.hrReviewers(tx, cycle)).filter((m) => m !== actor.membershipId), kind: 'appraisal.manager_submitted', title: `${name}'s manager evaluation is in`, body: 'The appraisal is ready for HR review.', link: `/appraisal/${id}` });
      } else {
        await tx.collection('appraisals').updateOne({ id }, { $set: { stage: 'finalized', finalized_at: new Date(), finalized_by_membership_id: actor.membershipId }, $push: { history: this.entry('finalized', 'finalized') } });
        const m = a.manager_employee_id ? await tx.collection('employees').findOne({ id: a.manager_employee_id }) : undefined;
        await this.notifications.notify(tx, { membershipIds: [m?.membership_id], kind: 'appraisal.finalized', title: `${name}'s appraisal is finalised`, link: `/appraisal/${id}` });
      }
      await this.recompute(tx, id);
      const after_ = (await tx.collection('appraisals').findOne({ id }))!;
      await this.audit.record(tx, { action: `appraisal.${role === 'employee' ? 'self_submitted' : role === 'manager' ? 'manager_submitted' : 'finalized'}`, resourceType: 'appraisal', resourceId: id, metadata: { employeeId: a.employee_id, result: after_.result } });
      return this.detail(tx, after_, cycle, role);
    });
  }

  private async publishOne(tx: TenantTx, a: Doc) {
    await tx.collection('appraisals').updateOne({ id: a.id }, { $set: { stage: 'published', published_at: new Date() }, $push: { history: this.entry('published', 'published') } });
    const e = (await tx.collection('employees').findOne({ id: a.employee_id }))!;
    const cycle = (await tx.collection('appraisal_cycles').findOne({ id: a.cycle_id }))!;
    await this.notifications.notify(tx, { membershipIds: [e.membership_id], kind: 'appraisal.published', title: `Your ${cycle.name} appraisal result is ready`, link: `/appraisal/${a.id}`, email: true });
    await this.audit.record(tx, { action: 'appraisal.published', resourceType: 'appraisal', resourceId: a.id, metadata: { employeeId: a.employee_id } });
  }

  /** Shares a finalised appraisal with the employee. */
  async publish(id: string) {
    return this.db.tenant(async (tx) => {
      const { a, cycle, role } = await this.load(tx, id, true);
      if (role !== 'hr') throw Errors.forbidden('Only HR publishes appraisals');
      if (a.stage !== 'finalized') throw Errors.conflict('invalid_state', 'Finalise the appraisal before publishing it');
      await this.publishOne(tx, a);
      return this.detail(tx, (await tx.collection('appraisals').findOne({ id }))!, cycle, role);
    });
  }

  /** HR sends an appraisal back to a stage, unlocking it (and clearing later submissions). */
  async reopen(id: string, input: z.infer<typeof appraisalReopenInput>) {
    return this.db.tenant(async (tx) => {
      const { a, cycle, role } = await this.load(tx, id, true);
      if (role !== 'hr') throw Errors.forbidden('Only HR can reopen an appraisal');
      if (!after(a.stage, input.stage)) throw Errors.conflict('invalid_state', 'The appraisal has not passed that stage');
      const set: Doc = { stage: input.stage, published_at: null, finalized_at: null, finalized_by_membership_id: null };
      if (input.stage === 'self') {
        set.self_submitted_at = null;
        set.manager_submitted_at = null;
      }
      if (input.stage === 'manager') set.manager_submitted_at = null;
      await tx.collection('appraisals').updateOne({ id }, { $set: set, $push: { history: this.entry('reopened', input.stage, input.reason) } });
      const who = input.stage === 'self' ? (await tx.collection('employees').findOne({ id: a.employee_id }))?.membership_id : input.stage === 'manager' && a.manager_employee_id ? (await tx.collection('employees').findOne({ id: a.manager_employee_id }))?.membership_id : null;
      if (who) await this.notifications.notify(tx, { membershipIds: [who], kind: 'appraisal.reopened', title: `An appraisal was reopened for you (${cycle.name})`, body: input.reason, link: `/appraisal/${id}` });
      await this.audit.record(tx, { action: 'appraisal.reopened', resourceType: 'appraisal', resourceId: id, metadata: { stage: input.stage, reason: input.reason } });
      return this.detail(tx, (await tx.collection('appraisals').findOne({ id }))!, cycle, role);
    });
  }
}
