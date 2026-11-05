import { Injectable } from '@nestjs/common';
import { DEFAULT_ASSUMPTIONS, scenarioAssumptions } from '@crew/contracts';
import type {
  EmployeeSkill, RecruitmentFlow, RecruitmentFlowPeriod, Scenario, ScenarioBaseline, ScenarioInput,
   SetEmployeeSkillsInput, SkillsNetwork, RequisitionInput,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor } from '../../platform/authz/policy';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { EMPLOYEE_SCOPE, employeeAttrs } from '../employees/employee-attrs';
import { EmployeesService } from '../employees/employees.service';
import { REQ_SCOPE } from '../recruitment/recruitment-common';
import { RequisitionsService } from '../recruitment/requisitions.service';

const SCENARIO_COLS = `s.id, s.name, s.notes, s.changes, s.assumptions,
  coalesce((select json_agg(json_build_object('id', r.id, 'code', r.code, 'title', r.title, 'status', r.status, 'departmentId', r.department_id, 'headcount', r.headcount) order by r.created_at)
     from job_requisitions r where r.source_scenario_id = s.id), '[]') as requisitions,
  u.full_name as "createdBy", s.created_at as "createdAt", s.updated_at as "updatedAt"`;

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
      const params: unknown[] = [];
      const scope = await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx);
      const people = await many<SkillsNetwork['people'][number]>(
        tx,
        `select e.id, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name, e.current_department_id as "departmentId"
           from employees e where ${scope} and e.status not in ('exited', 'pre_boarding') order by 2`,
        params,
      );
      const ids = people.map((p) => p.id);
      const links = await many<SkillsNetwork['links'][number]>(
        tx, `select employee_id as "employeeId", skill_id as "skillId", level from employee_skills where employee_id = any($1::uuid[])`, [ids],
      );
      const used = [...new Set(links.map((l) => l.skillId))];
      const skills = await many<SkillsNetwork['skills'][number]>(tx, `select id, name::text as name, category from skills where id = any($1::uuid[]) order by name`, [used]);
      const departments = await many<SkillsNetwork['departments'][number]>(tx, `select id, name from departments where archived_at is null order by name`);
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
      for (const s of input.skills) {
        const row = await one<{ id: string }>(
          tx,
          `insert into skills (tenant_id, name) values (app_tenant_id(), $1) on conflict (tenant_id, name) do update set name = skills.name returning id`,
          [s.name.replace(/\s+/g, ' ')],
        );
        ids.push(row!.id);
        await tx.query(
          `insert into employee_skills (tenant_id, employee_id, skill_id, level, updated_by_membership_id) values (app_tenant_id(), $1, $2, $3, $4)
           on conflict (tenant_id, employee_id, skill_id) do update set level = excluded.level, updated_by_membership_id = excluded.updated_by_membership_id,
             updated_at = case when employee_skills.level = excluded.level then employee_skills.updated_at else now() end`,
          [employeeId, row!.id, s.level, membershipId],
        );
      }
      await tx.query(`delete from employee_skills where employee_id = $1 and not (skill_id = any($2::uuid[]))`, [employeeId, ids]);
      const after = await this.list(tx, employeeId);
      await this.audit.record(tx, {
        action: 'employee.skills_updated', resourceType: 'employee', resourceId: employeeId,
        changes: { before: before.map((s) => `${s.name}:${s.level}`), after: after.map((s) => `${s.name}:${s.level}`) },
      });
      return { skills: after, canEdit };
    });
  }

  private list(tx: Tx, employeeId: string) {
    return many<EmployeeSkill>(
      tx,
      `select k.id as "skillId", k.name::text as name, es.level, es.updated_at as "updatedAt" from employee_skills es join skills k on k.id = es.skill_id
        where es.employee_id = $1 order by es.level desc, k.name`,
      [employeeId],
    );
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
      const params: unknown[] = [from];
      const scope = await this.authz.predicate('requisitions:read', REQ_SCOPE, params, tx);
      // The cohort: applications made in the period on jobs the viewer can see.
      const cohort = `select a.id, a.stage_id, a.status from applications a join job_requisitions r on r.id = a.requisition_id
                       where ($1::date is null or a.applied_at::date >= $1) and ${scope}`;
      const stages = await many<{ id: string; name: string; kind: string; position: number }>(
        tx, `select id, name, kind, position from recruitment_stages where archived_at is null order by position`,
      );
      const total = (await one<{ n: number }>(tx, `select count(*)::int as n from (${cohort}) c`, params))!.n;
      // Stage moves (including into Hired), then rejections and withdrawals from the stage the application stopped in.
      const moves = await many<{ from: string; to: string; count: number }>(
        tx,
        `with c as (${cohort})
         select e.from_stage_id::text as "from", e.to_stage_id::text as "to", count(*)::int as count
           from application_events e join c on c.id = e.application_id
          where e.kind in ('stage_changed', 'hired') and e.from_stage_id is not null and e.to_stage_id is not null and e.from_stage_id <> e.to_stage_id
          group by 1, 2
         union all
         select c.stage_id::text, c.status, count(*)::int from c where c.status in ('rejected', 'withdrawn') group by 1, 2`,
        params,
      );
      const reached = await many<{ stage: string; n: number }>(
        tx,
        `with c as (${cohort}),
              s as (select e.application_id, e.to_stage_id as stage from application_events e join c on c.id = e.application_id where e.to_stage_id is not null
                    union select c.id, c.stage_id from c)
         select stage::text, count(distinct application_id)::int as n from s group by 1`,
        params,
      );
      const now2 = await many<{ stage: string; n: number }>(
        tx, `with c as (${cohort}) select stage_id::text as stage, count(*)::int as n from c where status in ('active', 'hired') group by 1`, params,
      );
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
      const scenarios = (await many<Scenario>(
        tx, `select ${SCENARIO_COLS} from workforce_scenarios s left join memberships m on m.id = s.created_by_membership_id left join users u on u.id = m.user_id order by s.updated_at desc limit 50`,
      )).map((x) => ({ ...x, assumptions: scenarioAssumptions.parse(x.assumptions ?? {}) }));
      return { baseline, scenarios };
    });
  }

  async saveScenario(id: string | null, input: ScenarioInput): Promise<Scenario> {
    return this.db.tenant(async (tx) => {
      const known = new Set((await many<{ id: string }>(tx, `select id from departments where archived_at is null`)).map((d) => d.id));
      const bad = input.changes.findIndex((c) => !known.has(c.departmentId));
      if (bad >= 0) throw Errors.validation([{ path: ['changes', bad, 'departmentId'], message: 'Unknown department' }]);
      const s = await this.authz.subject(tx);
      this.planner(s);
      const changes = JSON.stringify(input.changes.filter((c) => c.delta !== 0 || c.monthlyCostPerHead != null));
      const assumptions = JSON.stringify(input.assumptions ?? DEFAULT_ASSUMPTIONS);
      const row = id
        ? await one<{ id: string }>(tx, `update workforce_scenarios set name = $2, notes = $3, changes = $4, assumptions = $5, updated_at = now() where id = $1 returning id`, [id, input.name, input.notes, changes, assumptions])
        : await one<{ id: string }>(
          tx, `insert into workforce_scenarios (tenant_id, name, notes, changes, assumptions, created_by_membership_id) values (app_tenant_id(), $1, $2, $3, $4, $5) returning id`,
          [input.name, input.notes, changes, assumptions, s.membershipId],
        );
      if (!row) throw Errors.notFound('Scenario');
      await this.audit.record(tx, { action: id ? 'scenario.updated' : 'scenario.created', resourceType: 'workforce_scenario', resourceId: row.id });
      return (await this.loadScenario(tx, row.id))!;
    });
  }

  private async loadScenario(tx: Tx, id: string) {
    const s = await one<Scenario>(tx, `select ${SCENARIO_COLS} from workforce_scenarios s left join memberships m on m.id = s.created_by_membership_id left join users u on u.id = m.user_id where s.id = $1`, [id]);
    return s && { ...s, assumptions: scenarioAssumptions.parse(s.assumptions ?? {}) };
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
      const depts = await many<{ id: string; name: string; legalEntityId: string | null; head: string | null }>(
        tx, `select id, name, legal_entity_id as "legalEntityId", head_membership_id as head from departments where id = any($1::uuid[])`, [wanted.map((c) => c.departmentId)],
      );
      const fallback = await one<{ id: string; currency: string }>(tx, `select id, currency from legal_entities order by created_at limit 1`);
      const entities = new Map((await many<{ id: string; currency: string }>(tx, `select id, currency from legal_entities`)).map((e) => [e.id, e.currency]));
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
        await tx.query(`update job_requisitions set source_scenario_id = $2 where id = $1`, [r.id, id]);
        await this.audit.record(tx, { action: 'scenario.requisition_raised', resourceType: 'workforce_scenario', resourceId: id, changes: { requisitionId: r.id, departmentId: p.departmentId, headcount: p.input.headcount } });
      });
    }
    return this.db.tenant(async (tx) => (await this.loadScenario(tx, id))!);
  }

  async deleteScenario(id: string) {
    return this.db.tenant(async (tx) => {
      this.planner(await this.authz.subject(tx));
      const r = await tx.query(`delete from workforce_scenarios where id = $1`, [id]);
      if (!r.rowCount) throw Errors.notFound('Scenario');
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
    const params: unknown[] = [];
    const scope = await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx);
    const f = (await this.entitlements.current(tx)).features;
    const s = await this.authz.subject(tx);
    let costs = f.has('payroll') && grantsFor(s, 'payroll:read').some((g) => g.scope !== 'own');
    let payScope = 'false';
    if (costs) payScope = await this.authz.predicate('payroll:read', EMPLOYEE_SCOPE, params, tx);
    const rows = await many<{ id: string; name: string; headcount: number; paid: number; monthly: string | null; currency: string | null }>(
      tx,
      `select d.id, d.name, count(e.id)::int as headcount, count(e.id) filter (where ${payScope})::int as paid,
              (sum(sal.annual_ctc) filter (where ${payScope}) / 12)::text as monthly, min(sal.currency) as currency
         from departments d
         left join employees e on e.current_department_id = d.id and e.status not in ('exited', 'pre_boarding') and ${scope}
         left join lateral (select annual_ctc, currency from employee_salaries x where x.employee_id = e.id and x.effective_from <= current_date order by effective_from desc limit 1) sal on true
        where d.archived_at is null
        group by d.id, d.name order by d.name`,
      params,
    );
    if (costs && rows.some((r) => r.paid !== r.headcount)) costs = false;
    return {
      asOf: new Date().toISOString().slice(0, 10),
      currency: costs ? (rows.find((r) => r.currency)?.currency ?? null) : null,
      costs,
      departments: rows.map((r) => ({ id: r.id, name: r.name, headcount: r.headcount, monthlyCost: costs ? Math.round(Number(r.monthly ?? 0)) : null })),
    };
  }
}
