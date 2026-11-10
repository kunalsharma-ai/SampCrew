import { Injectable } from '@nestjs/common';
import { type AttritionInput, type AttritionReviewInput, insights } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { displayName, employeeNames, fieldById, memberNames } from '../employees/employee-view';
import { attrsOf, talentEmployee } from '../talent/talent-common';

export const RULES_VERSION = 'attrition-rules-v1';

const CURRENT = ['probation', 'active', 'notice'];

/** Whole months from `from` to `to` ('YYYY-MM-DD'), as PostgreSQL age() counts them. */
export function monthsBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = to.split('-').map(Number) as [number, number, number];
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayStart = (date: string) => new Date(`${date}T00:00:00Z`);

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
  private async inputs(tx: TenantTx, asOf: string): Promise<{ employeeId: string; input: AttritionInput }[]> {
    const emps = await tx.collection('employees').find({ status: { $in: CURRENT } }, { projection: { date_of_joining: 1 } });
    const ids = emps.map((e) => e.id as string);
    const byEmployee = <T extends Record<string, unknown>>(rows: T[], field = 'employee_id') => {
      const m = new Map<string, T[]>();
      for (const x of rows) m.set(x[field] as string, [...(m.get(x[field] as string) ?? []), x]);
      return m;
    };
    const changes = byEmployee(await tx.collection('employment_records').find({ employee_id: { $in: ids }, change_reason: { $in: ['promotion', 'transfer'] }, effective_from: { $lte: asOf } }, { projection: { employee_id: 1, effective_from: 1 } }));
    const unplannedTypes = (await tx.collection('leave_types').find({ $or: [{ code: { $in: ['SL', 'CL'] } }, { paid: false }] }, { projection: { _id: 1 } })).map((t) => t.id);
    const leave = byEmployee(await tx.collection('leave_requests').find(
      { employee_id: { $in: ids }, status: 'approved', leave_type_id: { $in: unplannedTypes }, start_date: { $gt: addDays(asOf, -180), $lte: asOf } },
      { projection: { employee_id: 1, start_date: 1, days: 1 } },
    ));
    const days = byEmployee(await tx.collection('attendance_days').find(
      { employee_id: { $in: ids }, work_date: { $gt: addDays(asOf, -30), $lte: asOf }, $or: [{ status: 'absent' }, { flags: 'late' }] },
      { projection: { employee_id: 1 } },
    ));
    const reviews = byEmployee(await tx.collection('reviews').find({ employee_id: { $in: ids }, released_at: { $ne: null }, final_rating: { $ne: null } }, { sort: { released_at: -1 }, projection: { employee_id: 1, final_rating: 1, cycle_id: 1 } }));
    const scales = new Map((await tx.collection('review_cycles').find({ id: { $in: [...reviews.values()].flat().map((x) => x.cycle_id) } }, { projection: { rating_scale: 1 } })).map((c) => [c.id as string, (c.rating_scale as unknown[]).length]));
    const recognitions = byEmployee(await tx.collection('recognitions').find({ to_employee_id: { $in: ids }, hidden_at: null, created_at: { $gt: dayStart(addDays(asOf, -180)) } }, { projection: { to_employee_id: 1 } }), 'to_employee_id');
    const payCategories = (await tx.collection('helpdesk_categories').find({ name: { $regex: 'pay', $options: 'i' } }, { projection: { _id: 1 } })).map((k) => k.id);
    const payQueries = byEmployee(await tx.collection('helpdesk_cases').find(
      { employee_id: { $in: ids }, confidential: false, category_id: { $in: payCategories }, created_at: { $gt: dayStart(addDays(asOf, -90)) } },
      { projection: { employee_id: 1 } },
    ));
    const sumDays = (rows: Array<Record<string, unknown>>) => rows.reduce((a, x) => a + Number(x.days ?? 0), 0);
    return emps.map((e) => {
      const lastChange = (changes.get(e.id) ?? []).map((x) => x.effective_from as string).sort().pop();
      const mine = leave.get(e.id) ?? [];
      const recentFrom = addDays(asOf, -90);
      const last = (reviews.get(e.id) ?? [])[0];
      const scale = last ? scales.get(last.cycle_id) : undefined;
      return {
        employeeId: e.id as string,
        input: {
          tenureMonths: monthsBetween(e.date_of_joining, asOf),
          monthsSinceJobChange: lastChange ? monthsBetween(lastChange, asOf) : null,
          unplannedLeaveRecent: sumDays(mine.filter((x) => (x.start_date as string) > recentFrom)),
          unplannedLeavePrior: sumDays(mine.filter((x) => (x.start_date as string) <= recentFrom)),
          lateOrAbsentDays30: (days.get(e.id) ?? []).length,
          lastRatingShare: last && scale ? Math.round((Number(last.final_rating) / scale) * 100) / 100 : null,
          recognitions180: (recognitions.get(e.id) ?? []).length,
          payQueries90: (payQueries.get(e.id) ?? []).length,
        },
      };
    });
  }

  /** Calculates today's scores for everyone (idempotent per day). Used by the daily job and "Recalculate". */
  async computeAttrition(tx: TenantTx, asOf = new Date().toISOString().slice(0, 10)): Promise<number> {
    const all = await this.inputs(tx, asOf);
    for (const { employeeId, input } of all) {
      const r = insights.attritionRisk(input);
      const values = { score: r.score, band: r.band, factors: r.factors, inputs: input, rules_version: RULES_VERSION };
      await tx.collection('attrition_scores').upsert({ employee_id: employeeId, computed_on: asOf }, { employee_id: employeeId, computed_on: asOf, ...values }, { $set: { ...values, created_at: new Date() } });
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
      const scope = await this.authz.filter('insights:attrition', EMPLOYEE_FIELDS, tx);
      const emps = await tx.collection('employees').find({ $and: [scope, { status: { $in: CURRENT } }] });
      const scores = await tx.collection('attrition_scores').find({ employee_id: { $in: emps.map((e) => e.id) } }, { sort: { computed_on: -1 } });
      const latest = new Map<string, (typeof scores)[number]>();
      for (const x of scores) if (!latest.has(x.employee_id)) latest.set(x.employee_id, x);
      const reviewDocs = await tx.collection('attrition_reviews').find({ score_id: { $in: [...latest.values()].map((x) => x.id) } }, { sort: { created_at: -1 } });
      const departments = await fieldById(tx, 'departments', emps.map((e) => e.current_department_id));
      const rows = emps
        .filter((e) => latest.has(e.id) && (!q.band || latest.get(e.id)!.band === q.band))
        .map((e) => {
          const sc = latest.get(e.id)!;
          const rv = reviewDocs.find((x) => x.employee_id === e.id && x.score_id === sc.id);
          return {
            employeeId: e.id, name: displayName(e as never), department: departments.get(e.current_department_id) ?? null, score: sc.score, band: sc.band, factors: sc.factors,
            computedOn: sc.computed_on, reviewOutcome: rv?.outcome ?? null, reviewedAt: rv?.created_at ?? null,
          };
        })
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, 500);
      await this.audit.record(tx, { action: 'insights.attrition_viewed', resourceType: 'attrition_scores', metadata: { band: q.band ?? 'all', rows: rows.length } });
      const lastRun = await tx.collection('attrition_scores').findOne({}, { sort: { computed_on: -1 }, projection: { computed_on: 1 } });
      return { rulesVersion: RULES_VERSION, rules: insights.ATTRITION_RULES, computedOn: lastRun?.computed_on ?? null, people: rows };
    });
  }

  private async scoped(tx: TenantTx, employeeId: string) {
    const e = await talentEmployee(tx, employeeId);
    const s = await this.authz.subject(tx);
    if (!can(s, 'insights:attrition', attrsOf(e)).allowed) throw Errors.notFound('Employee');
    return e;
  }

  async attritionFor(employeeId: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.scoped(tx, employeeId);
      const scoreDocs = await tx.collection('attrition_scores').find({ employee_id: employeeId }, { sort: { computed_on: -1 }, limit: 60 });
      const history = scoreDocs.map((x) => ({ id: x.id, computedOn: x.computed_on, score: x.score, band: x.band, factors: x.factors, inputs: x.inputs, rulesVersion: x.rules_version }));
      const reviewDocs = await tx.collection('attrition_reviews').find({ employee_id: employeeId }, { sort: { created_at: -1 } });
      const reviewed = new Map((await tx.collection('attrition_scores').find({ id: { $in: reviewDocs.map((x) => x.score_id) } })).map((x) => [x.id as string, x]));
      const by = await memberNames(tx, reviewDocs.map((x) => x.by_membership_id));
      const reviews = reviewDocs.map((x) => ({
        id: x.id, outcome: x.outcome, note: x.note, createdAt: x.created_at, score: reviewed.get(x.score_id)?.score ?? null, scoreOn: reviewed.get(x.score_id)?.computed_on ?? null,
        byName: by.get(x.by_membership_id) ?? null,
      }));
      await this.audit.record(tx, { action: 'insights.attrition_viewed', resourceType: 'employee', resourceId: employeeId });
      return { employeeId, name: e.name, history, reviews };
    });
  }

  async review(employeeId: string, input: AttritionReviewInput) {
    return this.db.tenant(async (tx) => {
      await this.scoped(tx, employeeId);
      const s = await tx.collection('attrition_scores').findOne({ employee_id: employeeId }, { sort: { computed_on: -1 } });
      if (!s) throw Errors.notFound('Score');
      await tx.collection('attrition_reviews').insert({ employee_id: employeeId, score_id: s.id, outcome: input.outcome, note: input.note, by_membership_id: requestContext.tenantActor().membershipId });
      await this.audit.record(tx, { action: 'insights.attrition_reviewed', resourceType: 'employee', resourceId: employeeId, metadata: { outcome: input.outcome } });
      return { ok: true };
    });
  }

  // Payroll checks ------------------------------------------------------------------------------------------------

  /** Checks each person's pay in a run against their own earlier finalised months. Advisory; nothing is changed. */
  async payrollChecks(runId: string) {
    return this.db.tenant(async (tx) => {
      const run = await tx.collection<{ id: string; legal_entity_id: string; period_start: string; status: string }>('payroll_runs').findOne({ id: runId });
      if (!run) throw Errors.notFound('Payroll run');
      await this.authz.require('payroll:read', { legalEntityId: run.legal_entity_id }, tx);
      const docs = await tx.collection('payroll_items').find({ run_id: runId, status: 'included' });
      const names = await employeeNames(tx, docs.map((i) => i.employee_id));
      const items = docs
        .map((i) => ({
          id: i.id as string, employee_id: i.employee_id as string, name: names.get(i.employee_id)?.name ?? '', gross: i.gross as string, net: i.net as string,
          lop: (i.lop_override ?? i.lop_days) as string, days: i.days_in_period as number, lines: i.lines as { code: string; amount: string }[],
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const earlier = await tx.collection('payroll_runs').find({ status: 'finalised', legal_entity_id: run.legal_entity_id, period_start: { $lt: run.period_start } }, { sort: { period_start: -1 } });
      const order = new Map(earlier.map((x, i) => [x.id as string, i]));
      const history = (await tx.collection('payroll_items').find({ run_id: { $in: earlier.map((x) => x.id) }, status: 'included', employee_id: { $in: items.map((i) => i.employee_id) } }))
        .sort((a, b) => order.get(a.run_id)! - order.get(b.run_id)!)
        .map((x) => ({ employee_id: x.employee_id as string, gross: x.gross as string, net: x.net as string, lines: x.lines as { code: string; amount: string }[] }));
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
