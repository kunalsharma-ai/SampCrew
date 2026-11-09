import { Injectable } from '@nestjs/common';
import { DEFAULT_ASSUMPTIONS, scenarioAssumptions } from '@crew/contracts';
import type {
  EmployeeSkill, RecruitmentFlow, RecruitmentFlowPeriod, Scenario, ScenarioBaseline, ScenarioInput,
   SetEmployeeSkillsInput, SkillsNetwork, RequisitionInput,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor } from '../../platform/authz/policy';
import { ieq, membershipUserNames, MongoService as DatabaseService, type TenantTx as Tx } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { EMPLOYEE_FIELDS, employeeAttrs } from '../employees/employee-attrs';
import { displayName, fieldById } from '../employees/employee-view';
import { EmployeesService } from '../employees/employees.service';
import { REQ_FIELDS, visibleRequisitionIds } from '../recruitment/recruitment-common';
import { RequisitionsService } from '../recruitment/requisitions.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
const CURRENT = { status: { $nin: ['exited', 'pre_boarding'] } };

/** Scenarios as the API returns them: with the requisitions raised from each and who made it. */
async function scenarioViews(tx: Tx, docs: Doc[]): Promise<Scenario[]> {
  const reqs = docs.length ? await tx.collection('job_requisitions').find({ source_scenario_id: { $in: docs.map((d) => d.id) } }, { sort: { created_at: 1 } }) : [];
  const names = await membershipUserNames(tx, docs.map((d) => d.created_by_membership_id));
  return docs.map((d) => ({
    id: d.id, name: d.name, notes: d.notes, changes: d.changes, assumptions: scenarioAssumptions.parse(d.assumptions ?? {}),
    requisitions: reqs.filter((r) => r.source_scenario_id === d.id)
      .map((r) => ({ id: r.id, code: r.code, title: r.title, status: r.status, departmentId: r.department_id ?? null, headcount: r.headcount })),
    createdBy: names.get(d.created_by_membership_id) ?? null, createdAt: d.created_at, updatedAt: d.updated_at,
  }) as Scenario);
}

/**
 * Data for the Workforce Universe lenses. Every list is narrowed by the same permission scopes as the pages it
 * comes from: people by employees:read, hiring by requisitions:read, and pay only for people payroll access covers.
 */
@Injectable()
export class LensesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly employees: EmployeesService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly requisitions: RequisitionsService,
  ) {}

  // ---- Skills -------------------------------------------------------------------------------------------------

  async network(): Promise<SkillsNetwork> {
    return this.db.tenant(async (tx) => {
      const scope = await this.authz.filter('employees:read', EMPLOYEE_FIELDS, tx);
      const people: SkillsNetwork['people'] = (await tx.collection('employees').find({ $and: [scope, CURRENT] }))
        .map((e) => ({ id: e.id, name: displayName(e as never), departmentId: e.current_department_id ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const ids = people.map((p) => p.id);
      const links: SkillsNetwork['links'] = (await tx.collection('employee_skills').find({ employee_id: { $in: ids } }))
        .map((l) => ({ employeeId: l.employee_id, skillId: l.skill_id, level: l.level }));
      const used = [...new Set(links.map((l) => l.skillId))];
      const skills: SkillsNetwork['skills'] = (await tx.collection('skills').find({ id: { $in: used } }))
        .map((k) => ({ id: k.id, name: k.name, category: k.category ?? null })).sort((a, b) => a.name.localeCompare(b.name));
      const departments: SkillsNetwork['departments'] = (await tx.collection('departments').find({ archived_at: null }, { sort: { name: 1 } })).map((d) => ({ id: d.id, name: d.name }));
      return { skills, people, departments, links };
    });
  }

  async skillsOf(employeeId: string): Promise<{ skills: EmployeeSkill[]; canEdit: boolean }> {
    return this.db.tenant(async (tx) => {
      const { canEdit } = await this.access(tx, employeeId);
      return { skills: await this.list(tx, employeeId), canEdit };
    });
  }

  /** Replaces the person's skills. New names join the workspace's skill list. */
  async setSkills(employeeId: string, input: SetEmployeeSkillsInput): Promise<{ skills: EmployeeSkill[]; canEdit: boolean }> {
    return this.db.tenant(async (tx) => {
      const { canEdit, membershipId } = await this.access(tx, employeeId);
      if (!canEdit) throw Errors.forbidden('You cannot change this person’s skills');
      const before = await this.list(tx, employeeId);
      const ids: string[] = [];
      const skills = tx.collection('skills');
      const held = tx.collection('employee_skills');
      for (const s of input.skills) {
        const name = s.name.replace(/\s+/g, ' ');
        const skill = (await skills.findOne({ name: ieq(name) })) ?? (await skills.insert({ name }));
        ids.push(skill.id as string);
        const existing = await held.findOne({ employee_id: employeeId, skill_id: skill.id });
        if (!existing) await held.insert({ employee_id: employeeId, skill_id: skill.id, level: s.level, updated_by_membership_id: membershipId });
        else await held.updateOne({ employee_id: employeeId, skill_id: skill.id }, { $set: { level: s.level, updated_by_membership_id: membershipId, ...(existing.level === s.level ? {} : { updated_at: new Date() }) } });
      }
      await held.delete({ employee_id: employeeId, skill_id: { $nin: ids } });
      const after = await this.list(tx, employeeId);
      await this.audit.record(tx, {
        action: 'employee.skills_updated', resourceType: 'employee', resourceId: employeeId,
        changes: { before: before.map((s) => `${s.name}:${s.level}`), after: after.map((s) => `${s.name}:${s.level}`) },
      });
      return { skills: after, canEdit };
    });
  }

  private async list(tx: Tx, employeeId: string): Promise<EmployeeSkill[]> {
    const held = await tx.collection('employee_skills').find({ employee_id: employeeId });
    const names = await fieldById(tx, 'skills', held.map((h) => h.skill_id));
    return held
      .map((h) => ({ skillId: h.skill_id as string, name: names.get(h.skill_id) ?? '', level: h.level as number, updatedAt: h.updated_at }) as EmployeeSkill)
      .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
  }

  private async access(tx: Tx, employeeId: string) {
    const e = await this.employees.load(tx, employeeId);
    const a = employeeAttrs(e);
    await this.authz.require('employees:read', a, tx);
    const s = await this.authz.subject(tx);
    return { canEdit: grantsFor(s, 'employees:update').some((g) => grantCovers(s, g, a)), membershipId: s.membershipId };
  }

  // ---- Recruitment flow ---------------------------------------------------------------------------------------

  async recruitmentFlow(period: RecruitmentFlowPeriod): Promise<RecruitmentFlow> {
    return this.db.tenant(async (tx) => {
      const now = new Date();
      const y = now.getUTCFullYear();
      const from = period === 'all' ? null : period === 'year' ? `${y}-01-01` : new Date(Date.UTC(y, Math.floor(now.getUTCMonth() / 3) * 3, 1)).toISOString().slice(0, 10);
      const to = now.toISOString().slice(0, 10);
      const visible = await visibleRequisitionIds(tx, await this.authz.filter('requisitions:read', REQ_FIELDS, tx));
      // The cohort: applications made in the period on jobs the viewer can see.
      const cohort = await tx.collection('applications').find(
        { ...(visible ? { requisition_id: { $in: visible } } : {}), ...(from ? { applied_at: { $gte: new Date(`${from}T00:00:00Z`) } } : {}) },
        { projection: { id: 1, stage_id: 1, status: 1 } },
      );
      const stages = (await tx.collection('recruitment_stages').find({ archived_at: null }, { sort: { position: 1 } }))
        .map((x) => ({ id: x.id as string, name: x.name as string, kind: x.kind as string, position: x.position as number }));
      const total = cohort.length;
      const events = total ? await tx.collection('application_events').find({ application_id: { $in: cohort.map((c) => c.id) }, to_stage_id: { $ne: null } }) : [];
      // Stage moves (including into Hired), then rejections and withdrawals from the stage the application stopped in.
      const moveCount = new Map<string, number>();
      const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
      for (const e of events) {
        if (['stage_changed', 'hired'].includes(e.kind) && e.from_stage_id && e.from_stage_id !== e.to_stage_id) bump(moveCount, `${e.from_stage_id}|${e.to_stage_id}`);
      }
      const moves = [...moveCount].map(([k, count]) => { const [f, t] = k.split('|'); return { from: f!, to: t!, count }; });
      const stopped = new Map<string, number>();
      for (const c of cohort) if (['rejected', 'withdrawn'].includes(c.status)) bump(stopped, `${c.stage_id}|${c.status}`);
      moves.push(...[...stopped].map(([k, count]) => { const [f, t] = k.split('|'); return { from: f!, to: t!, count }; }));
      const reachedBy = new Map<string, Set<string>>();
      const reach = (stage: string, app: string) => reachedBy.set(stage, (reachedBy.get(stage) ?? new Set()).add(app));
      for (const e of events) reach(e.to_stage_id, e.application_id);
      for (const c of cohort) reach(c.stage_id, c.id);
      const reached = [...reachedBy].map(([stage, apps]) => ({ stage, n: apps.size }));
      const nowCount = new Map<string, number>();
      for (const c of cohort) if (['active', 'hired'].includes(c.status)) bump(nowCount, c.stage_id);
      const now2 = [...nowCount].map(([stage, n]) => ({ stage, n }));
      const r = new Map(reached.map((x) => [x.stage, x.n]));
      const n = new Map(now2.map((x) => [x.stage, x.n]));
      return {
        period, from, to, applications: total, moves,
        stages: stages.map((s) => ({ ...s, reached: r.get(s.id) ?? 0, now: n.get(s.id) ?? 0 })),
      };
    });
  }

  // ---- Scenarios ----------------------------------------------------------------------------------------------

  async scenarios(): Promise<{ baseline: ScenarioBaseline; scenarios: Scenario[] }> {
    return this.db.tenant(async (tx) => {
      const baseline = await this.baseline(tx);
      const scenarios = await scenarioViews(tx, await tx.collection('workforce_scenarios').find({}, { sort: { updated_at: -1 }, limit: 50 }));
      return { baseline, scenarios };
    });
  }

  async saveScenario(id: string | null, input: ScenarioInput): Promise<Scenario> {
    return this.db.tenant(async (tx) => {
      const known = new Set(await tx.collection('departments').distinct<string>('id', { archived_at: null }));
      const bad = input.changes.findIndex((c) => !known.has(c.departmentId));
      if (bad >= 0) throw Errors.validation([{ path: ['changes', bad, 'departmentId'], message: 'Unknown department' }]);
      const s = await this.authz.subject(tx);
      this.planner(s);
      const values = {
        name: input.name, notes: input.notes, changes: input.changes.filter((c) => c.delta !== 0 || c.monthlyCostPerHead != null),
        assumptions: input.assumptions ?? DEFAULT_ASSUMPTIONS,
      };
      const scenarios = tx.collection('workforce_scenarios');
      const row = id
        ? await scenarios.updateAndGet({ id }, { $set: { ...values, updated_at: new Date() } })
        : await scenarios.insert({ ...values, created_by_membership_id: s.membershipId });
      if (!row) throw Errors.notFound('Scenario');
      await this.audit.record(tx, { action: id ? 'scenario.updated' : 'scenario.created', resourceType: 'workforce_scenario', resourceId: row.id });
      return (await this.loadScenario(tx, row.id as string))!;
    });
  }

  private async loadScenario(tx: Tx, id: string) {
    const d = await tx.collection('workforce_scenarios').findOne({ id });
    return d ? (await scenarioViews(tx, [d]))[0] : undefined;
  }

  /**
   * Raises a draft requisition for every department the scenario adds people to (one per department, never twice),
   * with the role as title, the added people as headcount and the change month as the target start. Each goes through
   * the normal requisition rules and the caller's own requisitions:create scope; nothing is submitted for approval.
   */
  async scenarioRequisitions(id: string, departmentIds: string[] | undefined) {
    const plan = await this.db.tenant(async (tx) => {
      this.planner(await this.authz.subject(tx));
      if (!(await this.entitlements.current(tx)).features.has('recruitment')) throw Errors.forbidden('Your plan does not include recruitment');
      const sc = await this.loadScenario(tx, id);
      if (!sc) throw Errors.notFound('Scenario');
      const done = new Set(sc.requisitions.map((r) => r.departmentId));
      const wanted = sc.changes.filter((c) => c.delta > 0 && !done.has(c.departmentId) && (!departmentIds || departmentIds.includes(c.departmentId)));
      if (!wanted.length) throw Errors.validation([{ path: ['departmentIds'], message: done.size ? 'Requisitions were already raised for these departments' : 'This scenario adds nobody' }]);
      const depts = (await tx.collection('departments').find({ id: { $in: wanted.map((c) => c.departmentId) } }))
        .map((d) => ({ id: d.id as string, name: d.name as string, legalEntityId: (d.legal_entity_id as string | null) ?? null, head: (d.head_membership_id as string | null) ?? null }));
      const all = await tx.collection('legal_entities').find({}, { sort: { created_at: 1 } });
      const fallback = all[0] && { id: all[0].id as string, currency: all[0].currency as string };
      const entities = new Map(all.map((e) => [e.id as string, e.currency as string]));
      const me = (await this.authz.subject(tx)).membershipId;
      const start = sc.assumptions.startMonth ?? new Date().toISOString().slice(0, 7);
      const out: { departmentId: string; input: RequisitionInput }[] = [];
      for (const c of wanted) {
        const d = depts.find((x) => x.id === c.departmentId)!;
        const entity = d.legalEntityId ?? fallback!.id;
        // Checked for every department before any is raised, so a refusal never leaves half the drafts behind.
        await this.authz.require('requisitions:create', { legalEntityId: entity, departmentId: c.departmentId, locationId: null, membershipId: d.head ?? me }, tx);
        out.push({
          departmentId: c.departmentId,
          input: {
            title: c.role ?? `New role in ${d.name}`, legalEntityId: entity, departmentId: c.departmentId, locationId: null, designationId: null,
            hiringManagerMembershipId: d.head ?? me, employmentType: 'full_time', workMode: 'onsite', headcount: c.delta, reason: 'new_role',
            replacingEmployeeId: null, salaryMin: null, salaryMax: null, currency: entities.get(entity) ?? fallback!.currency,
            targetStartDate: `${c.startMonth && c.startMonth > start ? c.startMonth : start}-01`,
            justification: `From the scenario “${sc.name}”.${sc.notes ? ` ${sc.notes}` : ''}`.slice(0, 2000),
            description: '', scorecard: ['Role skills', 'Problem solving', 'Communication', 'Team fit'],
          } as RequisitionInput,
        });
      }
      return out;
    });
    const raised: { id: string }[] = [];
    for (const p of plan) {
      const r = (await this.requisitions.create(p.input)) as { id: string };
      raised.push(r);
      await this.db.tenant(async (tx) => {
        await tx.collection('job_requisitions').updateOne({ id: r.id }, { $set: { source_scenario_id: id } });
        await this.audit.record(tx, { action: 'scenario.requisition_raised', resourceType: 'workforce_scenario', resourceId: id, changes: { requisitionId: r.id, departmentId: p.departmentId, headcount: p.input.headcount } });
      });
    }
    return this.db.tenant(async (tx) => (await this.loadScenario(tx, id))!);
  }

  async deleteScenario(id: string) {
    return this.db.tenant(async (tx) => {
      this.planner(await this.authz.subject(tx));
      if (!(await tx.collection('workforce_scenarios').deleteOne({ id }))) throw Errors.notFound('Scenario');
      await this.audit.record(tx, { action: 'scenario.deleted', resourceType: 'workforce_scenario', resourceId: id });
      return { ok: true };
    });
  }

  /** Saving scenarios is for people with reports beyond their own records (managers, HR, finance, leaders). */
  private planner(s: Awaited<ReturnType<AuthzService['subject']>>) {
    if (!grantsFor(s, 'reports:read').some((g) => g.scope !== 'own')) throw Errors.forbidden('You can look at scenarios but not save them');
  }

  /**
   * Today's headcount per department among the people the viewer can see. Monthly cost (current salary / 12) is
   * included only when payroll is on and the viewer's payroll access covers every person counted, so a partial
   * view never passes for a total.
   */
  private async baseline(tx: Tx): Promise<ScenarioBaseline> {
    const scope = await this.authz.filter('employees:read', EMPLOYEE_FIELDS, tx);
    const f = (await this.entitlements.current(tx)).features;
    const s = await this.authz.subject(tx);
    let costs = f.has('payroll') && grantsFor(s, 'payroll:read').some((g) => g.scope !== 'own');
    const people = await tx.collection('employees').find({ $and: [scope, CURRENT] }, { projection: { id: 1, current_department_id: 1 } });
    const paid = new Set(costs ? await tx.collection('employees').distinct<string>('id', { $and: [await this.authz.filter('payroll:read', EMPLOYEE_FIELDS, tx), CURRENT] }) : []);
    // Each person's salary in force today (the latest that has started).
    const today = new Date().toISOString().slice(0, 10);
    const salary = new Map<string, Doc>();
    if (costs && paid.size) {
      for (const x of await tx.collection('employee_salaries').find({ employee_id: { $in: [...paid] }, effective_from: { $lte: today } }, { sort: { effective_from: 1 } })) salary.set(x.employee_id, x);
    }
    const rows = (await tx.collection('departments').find({ archived_at: null }, { sort: { name: 1 } })).map((d) => {
      const here = people.filter((e) => e.current_department_id === d.id);
      const covered = here.filter((e) => paid.has(e.id));
      const sal = covered.map((e) => salary.get(e.id)).filter((x): x is Doc => !!x);
      const annual = sal.reduce((sum, x) => sum + Number(x.annual_ctc), 0);
      const currencies = sal.map((x) => x.currency as string).sort();
      return { id: d.id as string, name: d.name as string, headcount: here.length, paid: covered.length, monthly: sal.length ? String(annual / 12) : null, currency: currencies[0] ?? null };
    });
    if (costs && rows.some((r) => r.paid !== r.headcount)) costs = false;
    return {
      asOf: new Date().toISOString().slice(0, 10),
      currency: costs ? (rows.find((r) => r.currency)?.currency ?? null) : null,
      costs,
      departments: rows.map((r) => ({ id: r.id, name: r.name, headcount: r.headcount, monthlyCost: costs ? Math.round(Number(r.monthly ?? 0)) : null })),
    };
  }
}
