import { Injectable } from '@nestjs/common';
import { type AttritionInput, type AttritionReviewInput, insights } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';
import { attrsOf, nameOf, talentEmployee } from '../talent/talent-common';

export const RULES_VERSION = 'attrition-rules-v1';

/**
 * Explainable insights. Attrition risk is a transparent rule score per employee, recalculated daily and kept
 * with its inputs and factors, visible only to HR with `insights:attrition` (never to managers). Payroll checks
 * compare each person's pay with their own recent months before a run is approved. Both are advisory.
 */
@Injectable()
export class InsightsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  /** The inputs for every current employee, gathered in one pass. */
  private async inputs(tx: Tx, asOf: string): Promise<{ employeeId: string; input: AttritionInput }[]> {
    const rows = await many<Record<string, string | number | null> & { id: string }>(
      tx,
      `select e.id,
              (extract(year from age($1::date, e.date_of_joining)) * 12 + extract(month from age($1::date, e.date_of_joining)))::int as tenure,
              (select (extract(year from age($1::date, max(r.effective_from))) * 12 + extract(month from age($1::date, max(r.effective_from))))::int
                 from employment_records r where r.employee_id = e.id and r.change_reason in ('promotion', 'transfer') and r.effective_from <= $1::date) as since_change,
              coalesce((select sum(l.days) from leave_requests l join leave_types t on t.id = l.leave_type_id
                 where l.employee_id = e.id and l.status = 'approved' and (t.code in ('SL', 'CL') or not t.paid)
                   and l.start_date > $1::date - 90 and l.start_date <= $1::date), 0)::float as leave_recent,
              coalesce((select sum(l.days) from leave_requests l join leave_types t on t.id = l.leave_type_id
                 where l.employee_id = e.id and l.status = 'approved' and (t.code in ('SL', 'CL') or not t.paid)
                   and l.start_date > $1::date - 180 and l.start_date <= $1::date - 90), 0)::float as leave_prior,
              (select count(*) from attendance_days d where d.employee_id = e.id and d.work_date > $1::date - 30 and d.work_date <= $1::date
                  and (d.status = 'absent' or 'late' = any(d.flags)))::int as late_absent,
              (select rv.final_rating::float / nullif(jsonb_array_length(c.rating_scale), 0) from reviews rv join review_cycles c on c.id = rv.cycle_id
                 where rv.employee_id = e.id and rv.released_at is not null and rv.final_rating is not null order by rv.released_at desc limit 1) as rating_share,
              (select count(*) from recognitions g where g.to_employee_id = e.id and g.hidden_at is null and g.created_at > $1::date - 180)::int as recognitions,
              (select count(*) from helpdesk_cases h join helpdesk_categories k on k.id = h.category_id
                 where h.employee_id = e.id and not h.confidential and k.name ilike '%pay%' and h.created_at > $1::date - 90)::int as pay_queries
         from employees e where e.status in ('probation', 'active', 'notice')`,
      [asOf],
    );
    return rows.map((r) => ({
      employeeId: r.id,
      input: {
        tenureMonths: Number(r.tenure ?? 0),
        monthsSinceJobChange: r.since_change === null ? null : Number(r.since_change),
        unplannedLeaveRecent: Number(r.leave_recent),
        unplannedLeavePrior: Number(r.leave_prior),
        lateOrAbsentDays30: Number(r.late_absent),
        lastRatingShare: r.rating_share === null ? null : Math.round(Number(r.rating_share) * 100) / 100,
        recognitions180: Number(r.recognitions),
        payQueries90: Number(r.pay_queries),
      },
    }));
  }

  /** Calculates today's scores for everyone (idempotent per day). Used by the daily job and "Recalculate". */
  async computeAttrition(tx: Tx, asOf = new Date().toISOString().slice(0, 10)): Promise<number> {
    const all = await this.inputs(tx, asOf);
    for (const { employeeId, input } of all) {
      const r = insights.attritionRisk(input);
      await tx.query(
        `insert into attrition_scores (tenant_id, employee_id, computed_on, score, band, factors, inputs, rules_version)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)
         on conflict (employee_id, computed_on) do update set score = excluded.score, band = excluded.band, factors = excluded.factors,
                inputs = excluded.inputs, rules_version = excluded.rules_version, created_at = now()`,
        [employeeId, asOf, r.score, r.band, JSON.stringify(r.factors), JSON.stringify(input), RULES_VERSION],
      );
    }
    return all.length;
  }

  async recalculate() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('insights:attrition', undefined, tx);
      const n = await this.computeAttrition(tx);
      await this.audit.record(tx, { action: 'insights.attrition_recalculated', resourceType: 'attrition_scores', metadata: { employees: n } });
      return { employees: n };
    });
  }

  /** Latest score per person in the caller's scope, highest first. */
  async attrition(q: { band?: 'low' | 'medium' | 'high' }) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [q.band ?? null];
      const pred = await this.authz.predicate('insights:attrition', EMPLOYEE_SCOPE, params, tx);
      const rows = await many(
        tx,
        `select e.id as "employeeId", ${nameOf('e')} as name, d.name as department, s.score, s.band, s.factors, s.computed_on as "computedOn",
                rv.outcome as "reviewOutcome", rv.created_at as "reviewedAt"
           from employees e
           join lateral (select * from attrition_scores x where x.employee_id = e.id order by x.computed_on desc limit 1) s on true
           left join departments d on d.id = e.current_department_id
           left join lateral (select outcome, created_at from attrition_reviews r where r.employee_id = e.id and r.score_id = s.id order by created_at desc limit 1) rv on true
          where e.status in ('probation', 'active', 'notice') and ($1::text is null or s.band = $1) and ${pred}
          order by s.score desc, name limit 500`,
        params,
      );
      await this.audit.record(tx, { action: 'insights.attrition_viewed', resourceType: 'attrition_scores', metadata: { band: q.band ?? 'all', rows: rows.length } });
      const lastRun = await one<{ on: string | null }>(tx, 'select max(computed_on)::text as on from attrition_scores');
      return { rulesVersion: RULES_VERSION, rules: insights.ATTRITION_RULES, computedOn: lastRun?.on ?? null, people: rows };
    });
  }

  private async scoped(tx: Tx, employeeId: string) {
    const e = await talentEmployee(tx, employeeId);
    const s = await this.authz.subject(tx);
    if (!can(s, 'insights:attrition', attrsOf(e)).allowed) throw Errors.notFound('Employee');
    return e;
  }

  async attritionFor(employeeId: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.scoped(tx, employeeId);
      const history = await many(tx, `select id, computed_on as "computedOn", score, band, factors, inputs, rules_version as "rulesVersion" from attrition_scores where employee_id = $1 order by computed_on desc limit 60`, [employeeId]);
      const reviews = await many(
        tx,
        `select r.id, r.outcome, r.note, r.created_at as "createdAt", s.score, s.computed_on as "scoreOn", coalesce(nullif(${nameOf('be')}, ''), u.full_name) as "byName"
           from attrition_reviews r join attrition_scores s on s.id = r.score_id join memberships m on m.id = r.by_membership_id join users u on u.id = m.user_id
           left join employees be on be.id = m.employee_id where r.employee_id = $1 order by r.created_at desc`,
        [employeeId],
      );
      await this.audit.record(tx, { action: 'insights.attrition_viewed', resourceType: 'employee', resourceId: employeeId });
      return { employeeId, name: e.name, history, reviews };
    });
  }

  async review(employeeId: string, input: AttritionReviewInput) {
    return this.db.tenant(async (tx) => {
      await this.scoped(tx, employeeId);
      const s = await one<{ id: string }>(tx, 'select id from attrition_scores where employee_id = $1 order by computed_on desc limit 1', [employeeId]);
      if (!s) throw Errors.notFound('Score');
      await tx.query(
        `insert into attrition_reviews (tenant_id, employee_id, score_id, outcome, note, by_membership_id) values (app_tenant_id(), $1, $2, $3, $4, $5)`,
        [employeeId, s.id, input.outcome, input.note, requestContext.tenantActor().membershipId],
      );
      await this.audit.record(tx, { action: 'insights.attrition_reviewed', resourceType: 'employee', resourceId: employeeId, metadata: { outcome: input.outcome } });
      return { ok: true };
    });
  }

  // Payroll checks ------------------------------------------------------------------------------------------------

  /** Checks each person's pay in a run against their own earlier finalised months. Advisory; nothing is changed. */
  async payrollChecks(runId: string) {
    return this.db.tenant(async (tx) => {
      const run = await one<{ id: string; legal_entity_id: string; period_start: string; status: string }>(tx, `select id, legal_entity_id, period_start::text, status from payroll_runs where id = $1`, [runId]);
      if (!run) throw Errors.notFound('Payroll run');
      await this.authz.require('payroll:read', { legalEntityId: run.legal_entity_id }, tx);
      const items = await many<{ id: string; employee_id: string; name: string; gross: string; net: string; lop: string; days: number; lines: { code: string; amount: string }[] }>(
        tx,
        `select i.id, i.employee_id, ${nameOf('e')} as name, i.gross::text, i.net::text, coalesce(i.lop_override, i.lop_days)::text as lop, i.days_in_period as days, i.lines
           from payroll_items i join employees e on e.id = i.employee_id where i.run_id = $1 and i.status = 'included' order by name`,
        [runId],
      );
      const history = await many<{ employee_id: string; gross: string; net: string; lines: { code: string; amount: string }[] }>(
        tx,
        `select i.employee_id, i.gross::text, i.net::text, i.lines from payroll_items i join payroll_runs r on r.id = i.run_id
          where r.status = 'finalised' and r.legal_entity_id = $1 and r.period_start < $2::date and i.status = 'included'
            and i.employee_id = any($3::uuid[]) order by r.period_start desc`,
        [run.legal_entity_id, run.period_start, items.map((i) => i.employee_id)],
      );
      const paid = (lines: { code: string; amount: string }[]) => lines.filter((l) => Number(l.amount) !== 0 && !l.code.startsWith('ADJ') && !l.code.startsWith('REIMB')).map((l) => l.code);
      const people = items.map((i) => {
        const h = history.filter((x) => x.employee_id === i.employee_id).slice(0, 6).map((x) => ({ gross: x.gross, net: x.net, components: paid(x.lines) }));
        const anomalies = insights.payrollAnomalies({ employeeName: i.name, gross: i.gross, net: i.net, lopDays: i.lop, daysInPeriod: i.days, components: paid(i.lines), history: h });
        return { itemId: i.id, employeeId: i.employee_id, name: i.name, months: h.length, anomalies };
      });
      const flagged = people.filter((p) => p.anomalies.some((a) => a.severity !== 'info'));
      return {
        runId,
        thresholdPct: insights.PAY_CHANGE_THRESHOLD_PCT,
        checked: people.length,
        flagged: flagged.length,
        people: people.filter((p) => p.anomalies.length),
      };
    });
  }
}
