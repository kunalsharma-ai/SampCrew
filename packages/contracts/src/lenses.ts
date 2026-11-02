import { z } from 'zod';

/**
 * The other lenses of the Workforce Universe: where people work (a globe of locations), what they know (a skills
 * network), how candidates move through hiring (a stage-to-stage flow) and what-if headcount plans (scenarios).
 * The API returns records; the drawing maths lives here so the browser and the tests share it.
 */

// ---------------------------------------------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------------------------------------------

export const SKILL_LEVELS = [1, 2, 3, 4] as const;
export const SKILL_LEVEL_LABEL: Record<number, string> = { 1: 'Learning', 2: 'Working', 3: 'Strong', 4: 'Expert' };

export const setEmployeeSkillsInput = z.object({
  skills: z.array(z.object({
    name: z.string().trim().min(2, 'Name the skill').max(60),
    level: z.number().int().min(1).max(4),
  }).strict()).max(30, 'Up to 30 skills'),
}).strict().refine((v) => new Set(v.skills.map((s) => s.name.toLowerCase())).size === v.skills.length, { message: 'Each skill once', path: ['skills'] });
export type SetEmployeeSkillsInput = z.infer<typeof setEmployeeSkillsInput>;

export interface EmployeeSkill { skillId: string; name: string; level: number; updatedAt: string }

export interface SkillsNetwork {
  skills: { id: string; name: string; category: string | null }[];
  people: { id: string; name: string; departmentId: string | null }[];
  departments: { id: string; name: string }[];
  links: { employeeId: string; skillId: string; level: number }[];
}

export interface SkillSummary {
  id: string; name: string; people: number; experts: number; departments: number;
  /** Few people hold it: a gap if one of them leaves. */
  risk: 'single' | 'thin' | 'ok';
}

/** Per skill: how many people hold it, how many at level 3 or 4, across how many departments, and the risk. */
export function skillSummary(n: SkillsNetwork): SkillSummary[] {
  const dept = new Map(n.people.map((p) => [p.id, p.departmentId]));
  return n.skills.map((s) => {
    const ls = n.links.filter((l) => l.skillId === s.id);
    const strong = ls.filter((l) => l.level >= 3).length;
    const people = ls.length;
    return {
      id: s.id, name: s.name, people, experts: strong,
      departments: new Set(ls.map((l) => dept.get(l.employeeId) ?? 'none')).size,
      risk: strong <= 1 ? 'single' : strong === 2 ? 'thin' : 'ok',
    } satisfies SkillSummary;
  }).sort((a, b) => b.people - a.people || a.name.localeCompare(b.name));
}

/**
 * A fixed layout for the network: skills on a ring (most-held first), each person at the average position of their
 * skills pulled slightly inwards, so people who share skills sit together. Deterministic, so it does not jump.
 */
export function skillsLayout(n: SkillsNetwork, size = 600) {
  const c = size / 2;
  const ring = size * 0.4;
  const order = skillSummary(n);
  const skillPos = new Map(order.map((s, i) => {
    const a = (i / Math.max(1, order.length)) * Math.PI * 2 - Math.PI / 2;
    return [s.id, { x: c + Math.cos(a) * ring, y: c + Math.sin(a) * ring }];
  }));
  const people = n.people.map((p, k) => {
    const mine = n.links.filter((l) => l.employeeId === p.id);
    if (!mine.length) return { id: p.id, x: NaN, y: NaN, skills: 0 };
    let x = 0; let y = 0; let w = 0;
    for (const l of mine) { const s = skillPos.get(l.skillId)!; x += s.x * l.level; y += s.y * l.level; w += l.level; }
    // A small, stable offset so people with the same skills do not sit on top of each other.
    const jitter = ((k * 37) % 17) - 8;
    return { id: p.id, x: c + (x / w - c) * 0.72 + jitter, y: c + (y / w - c) * 0.72 - jitter / 2, skills: mine.length };
  }).filter((p) => !Number.isNaN(p.x));
  return { skills: order.map((s) => ({ ...s, ...skillPos.get(s.id)! })), people };
}

// ---------------------------------------------------------------------------------------------------------------
// Globe
// ---------------------------------------------------------------------------------------------------------------

/**
 * Orthographic projection of a point on the globe, seen from above (lat0, lng0). Returns x, y in [-1, 1] and
 * whether the point is on the visible side.
 */
export function orthographic(lat: number, lng: number, lat0: number, lng0: number) {
  const r = Math.PI / 180;
  const [p, l, p0, l0] = [lat * r, lng * r, lat0 * r, lng0 * r];
  const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l - l0);
  return {
    x: Math.cos(p) * Math.sin(l - l0),
    y: -(Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l - l0)),
    visible: cosc >= 0,
  };
}

/** The point to look at first: the headcount-weighted middle of the locations (on the sphere). */
export function globeCentre(points: { lat: number; lng: number; weight: number }[]) {
  if (!points.length) return { lat: 20, lng: 78 };
  const r = Math.PI / 180;
  let x = 0; let y = 0; let z = 0;
  for (const p of points) {
    const w = Math.max(1, p.weight);
    x += Math.cos(p.lat * r) * Math.cos(p.lng * r) * w; y += Math.cos(p.lat * r) * Math.sin(p.lng * r) * w; z += Math.sin(p.lat * r) * w;
  }
  return { lat: Math.atan2(z, Math.hypot(x, y)) / r, lng: Math.atan2(y, x) / r };
}

// ---------------------------------------------------------------------------------------------------------------
// Recruitment flow
// ---------------------------------------------------------------------------------------------------------------

export const RECRUITMENT_FLOW_PERIODS = ['quarter', 'year', 'all'] as const;
export type RecruitmentFlowPeriod = (typeof RECRUITMENT_FLOW_PERIODS)[number];

export interface RecruitmentFlow {
  period: RecruitmentFlowPeriod;
  from: string | null;
  to: string;
  /** reached: applications that were in the stage at some point in the period; now: in it today. */
  stages: { id: string; name: string; kind: string; position: number; reached: number; now: number }[];
  /** Applications in the period, by where they are now. */
  applications: number;
  /** One row per step an application took: stage to stage, or to an outcome. */
  moves: { from: string; to: string; count: number }[];
}

export const FLOW_OUTCOMES = { rejected: 'Rejected', withdrawn: 'Withdrew', hired: 'Hired' } as const;

/**
 * Per stage: how many reached it, moved on from it, were turned down or withdrew there, and are still in it.
 * "Reached" counts each application once per stage, so moving back and forth does not count twice.
 */
export function flowByStage(f: RecruitmentFlow) {
  return f.stages.map((s) => {
    const out = f.moves.filter((m) => m.from === s.id);
    const sum = (to: string) => out.filter((m) => m.to === to).reduce((a, m) => a + m.count, 0);
    const reached = s.reached;
    const onward = out.filter((m) => !(m.to in FLOW_OUTCOMES) && (f.stages.find((x) => x.id === m.to)?.position ?? -1) > s.position).reduce((a, m) => a + m.count, 0) + sum('hired');
    return {
      id: s.id, name: s.name, kind: s.kind, reached, onward,
      rejected: sum('rejected'), withdrawn: sum('withdrawn'), now: s.now,
      conversion: reached ? Math.round((onward / reached) * 100) : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------------------

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-04');

/** How the plan unfolds: over how many months, from which month, and with what attrition and pay rise. */
export const scenarioAssumptions = z.object({
  /** First month of the projection; left out, the current month. */
  startMonth: month.nullable().default(null),
  horizonMonths: z.number().int().min(3, 'At least 3 months').max(36, 'Up to 36 months').default(12),
  /** People expected to leave in a year, as a share of headcount; leavers are not replaced. */
  attritionPctYear: z.number().min(0).max(60, 'Up to 60% a year').default(0),
  payRisePct: z.number().min(0).max(30, 'Up to 30%').default(0),
  /** When the pay rise takes effect; left out, the first month. */
  payRiseMonth: month.nullable().default(null),
}).strict();
export type ScenarioAssumptions = z.infer<typeof scenarioAssumptions>;
export const DEFAULT_ASSUMPTIONS: ScenarioAssumptions = { startMonth: null, horizonMonths: 12, attritionPctYear: 0, payRisePct: 0, payRiseMonth: null };

export const scenarioInput = z.object({
  name: z.string().trim().min(2, 'Name the scenario').max(80),
  notes: z.string().trim().max(2000).optional().default(''),
  changes: z.array(z.object({
    departmentId: z.string().uuid(),
    /** People added (positive) or removed (negative). */
    delta: z.number().int().min(-1000).max(1000),
    /** Monthly cost per added person; left out, the department's current average is used. */
    monthlyCostPerHead: z.number().min(0).max(100_000_000).nullable().optional(),
    /** The month the change happens; left out, the first month of the projection. */
    startMonth: month.nullable().optional(),
    /** The job the added people do, used as the title of a draft requisition. */
    role: z.string().trim().min(2, 'Name the role').max(120).nullable().optional(),
  }).strict()).min(1, 'Change at least one department').max(100),
  assumptions: scenarioAssumptions.optional(),
}).strict().refine((v) => new Set(v.changes.map((c) => c.departmentId)).size === v.changes.length, { message: 'Each department once', path: ['changes'] })
  .refine((v) => v.changes.some((c) => c.delta !== 0), { message: 'Change at least one department', path: ['changes'] });
export type ScenarioInput = z.infer<typeof scenarioInput>;

export interface ScenarioBaseline {
  asOf: string;
  currency: string | null;
  /** False when the viewer has no salary access: costs are left out everywhere. */
  costs: boolean;
  departments: { id: string; name: string; headcount: number; monthlyCost: number | null }[];
}

export type ScenarioChange = z.infer<typeof scenarioInput>['changes'][number];

export interface Scenario {
  id: string; name: string; notes: string; changes: ScenarioChange[]; assumptions: ScenarioAssumptions;
  /** Draft requisitions raised from this scenario. */
  requisitions: { id: string; code: string; title: string; status: string; departmentId: string; headcount: number }[];
  createdBy: string | null; createdAt: string; updatedAt: string;
}

/** Applies a scenario to the baseline: headcount and monthly cost per department and in total, before and after. */
export function applyScenario(base: ScenarioBaseline, changes: ScenarioChange[]) {
  const byDept = new Map(changes.map((c) => [c.departmentId, c]));
  const rows = base.departments.map((d) => {
    const c = byDept.get(d.id);
    const delta = c?.delta ?? 0;
    const after = Math.max(0, d.headcount + delta);
    const avg = d.headcount && d.monthlyCost != null ? d.monthlyCost / d.headcount : null;
    const perHead = c?.monthlyCostPerHead ?? avg;
    let costAfter: number | null = null;
    if (base.costs && d.monthlyCost != null) {
      const real = after - d.headcount;
      // Removing people takes away the average; adding them costs the stated amount (or the average).
      costAfter = real >= 0 ? d.monthlyCost + real * (perHead ?? 0) : d.monthlyCost + real * (avg ?? 0);
    }
    return { id: d.id, name: d.name, before: d.headcount, delta: after - d.headcount, after, costBefore: base.costs ? d.monthlyCost : null, costAfter, missingCost: base.costs && delta > 0 && perHead == null };
  });
  const total = (k: 'before' | 'after') => rows.reduce((a, r) => a + r[k], 0);
  const cost = (k: 'costBefore' | 'costAfter') => (base.costs ? Math.round(rows.reduce((a, r) => a + (r[k] ?? 0), 0)) : null);
  return { rows, before: total('before'), after: total('after'), costBefore: cost('costBefore'), costAfter: cost('costAfter') };
}

/** "2026-11" plus n months. */
export function addMonths(m: string, n: number) {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const k = y * 12 + (mo - 1) + n;
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`;
}

export interface ProjectionPoint {
  month: string;
  /** Headcount the plan asks for at the end of the month, before attrition. */
  planned: number;
  /** Expected headcount after leavers (not replaced). */
  expected: number;
  /** Expected headcount with no changes at all, for comparison. */
  baseline: number;
  /** Monthly cost of the expected headcount, with the pay rise once it applies; null without salary access. */
  cost: number | null;
  baselineCost: number | null;
}

/**
 * Month by month: each change happens in its month, people leave at the yearly attrition rate (spread evenly over
 * the months, people who join leave at the same rate from when they join) and pay rises from its month. Costs use
 * the department average for current people and the stated cost (or the average) for added people.
 */
export function projectScenario(base: ScenarioBaseline, changes: ScenarioChange[], a: ScenarioAssumptions = DEFAULT_ASSUMPTIONS) {
  const start = a.startMonth ?? base.asOf.slice(0, 7);
  const months = Array.from({ length: a.horizonMonths }, (_, i) => addMonths(start, i));
  const keep = (1 - a.attritionPctYear / 100) ** (1 / 12);
  const riseFrom = a.payRiseMonth ?? start;
  const rise = (m: string) => (a.payRisePct && m >= riseFrom ? 1 + a.payRisePct / 100 : 1);
  const byDept = new Map(changes.map((c) => [c.departmentId, c]));
  const outside: string[] = [];
  const depts = base.departments.map((d) => {
    const c = byDept.get(d.id);
    const at = c?.startMonth && c.startMonth > start ? months.indexOf(c.startMonth) : 0;
    if (c && c.delta && at < 0) outside.push(d.id);
    const avg = d.headcount && d.monthlyCost != null ? d.monthlyCost / d.headcount : 0;
    return { ...d, delta: at < 0 ? 0 : (c?.delta ?? 0), at, avg, perHead: c?.monthlyCostPerHead ?? avg };
  });
  const points: ProjectionPoint[] = months.map((m, i) => {
    let planned = 0; let expected = 0; let baseline = 0; let cost = 0; let baselineCost = 0;
    for (const d of depts) {
      const active = d.delta !== 0 && i >= d.at;
      const now = keep ** (i + 1);
      // Current people leave from the first month; a cut removes people in its month (never below zero).
      const current = Math.max(0, d.headcount * now + (active && d.delta < 0 ? d.delta : 0));
      const joined = active && d.delta > 0 ? d.delta * keep ** (i + 1 - d.at) : 0;
      planned += Math.max(0, d.headcount + (active ? d.delta : 0));
      expected += current + joined;
      baseline += d.headcount * now;
      cost += (current * d.avg + joined * d.perHead) * rise(m);
      baselineCost += d.headcount * now * d.avg * rise(m);
    }
    const r1 = (n: number) => Math.round(n * 10) / 10;
    return { month: m, planned, expected: r1(expected), baseline: r1(baseline), cost: base.costs ? Math.round(cost) : null, baselineCost: base.costs ? Math.round(baselineCost) : null };
  });
  const last = points.at(-1)!;
  const sum = (k: 'cost' | 'baselineCost') => (base.costs ? points.reduce((s, p) => s + (p[k] ?? 0), 0) : null);
  const total = sum('cost'); const baseTotal = sum('baselineCost');
  return {
    start, end: last.month, points, outside,
    /** People expected to leave over the horizon who would need replacing to hold the plan. */
    leavers: Math.round(last.planned - last.expected),
    totalCost: total, baselineTotalCost: baseTotal, difference: total != null && baseTotal != null ? total - baseTotal : null,
  };
}
