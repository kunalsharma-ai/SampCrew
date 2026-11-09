import { DEFAULT_IN_STATUTORY, leaveMath, payrollEngine } from '@crew/contracts';
import type { ClientSession, Db, MongoClient } from 'mongodb';
import { appendAuditEvent, provisionTenantMongo, Table, type Row } from '../src/mongo';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY));
const addMonths = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return isoDay(d);
};

/**
 * One workspace's collections inside the seed transaction. The tables apply the same rules as the API (types,
 * defaults, enums, unique keys, foreign keys, CHECK rules and row guards); every row is written with the
 * workspace's tenant_id and every read is limited to it.
 */
function workspace(db: Db, session: ClientSession, tid: string) {
  const table = (name: string) => new Table(db, name, session, { scope: null });
  const own = (row: Row) => ({ tenant_id: tid, ...row });
  const ws = {
    table,
    insert: async (name: string, row: Row) => (await table(name).insert(own(row))).id as string,
    insertMany: (name: string, rows: Row[]) => table(name).insertMany(rows.map(own)),
    find: (name: string, filter: Row = {}, options: { sort?: Row; projection?: Row } = {}) => table(name).find(own(filter), options),
    findOne: (name: string, filter: Row, options: { sort?: Row } = {}) => table(name).findOne(own(filter), options),
    /** The id of the one row matching `filter`; a missing row is a bug in the seed, so it throws. */
    id: async (name: string, filter: Row, options: { sort?: Row } = {}) => {
      const r = await ws.findOne(name, filter, options);
      if (!r) throw new Error(`Demo seed: no ${name} row matches ${JSON.stringify(filter)}`);
      return r.id as string;
    },
    set: (name: string, filter: Row, fields: Row) => table(name).update(own(filter), { $set: fields }),
  };
  return ws;
}
type Workspace = ReturnType<typeof workspace>;

/**
 * Demo tenant for local development and sales demos. The tenant is flagged is_demo = true and every
 * screen shows a "Demo data" banner. All people and companies here are fictional. Everything is written in one
 * transaction, so a failed seed leaves nothing behind.
 */
export async function seedDemoTenant(client: MongoClient, db: Db, passwordHash: string): Promise<boolean> {
  if (await db.collection('tenants').findOne({ slug: 'demo-northwind' }, { projection: { _id: 1 } })) return false;
  const session = client.startSession();
  try {
    await session.withTransaction(() => seed(db, session, passwordHash), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } finally {
    await session.endSession();
  }
  return true;
}

async function seed(db: Db, session: ClientSession, passwordHash: string) {
  const unscoped = { collection: <T extends Row = Row>(name: string) => new Table<T>(db, name, session, { scope: null }) };
  const t = await provisionTenantMongo(unscoped, {
    name: 'Northwind Manufacturing (Demo)',
    slug: 'demo-northwind',
    countryCode: 'IN',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    locale: 'en-IN',
    isDemo: true,
    owner: { email: 'owner@demo.crew.local', fullName: 'Aarav Mehta', passwordHash },
    plan: { key: 'business', seats: 120, billingCycle: 'annual', trialDays: 30 },
  });
  const tid = t.tenantId;
  const ws = workspace(db, session, tid);
  // The demo workspace comes fully set up, so its admins are not taken through the first-login company setup.
  await ws.table('tenants').updateOne({ id: tid }, { $set: { industry: 'manufacturing', company_size: '201-500', setup_step: 4, setup_completed_at: new Date() } });

  const uk = await ws.insert('legal_entities', { name: 'Northwind UK', legal_name: 'Northwind Manufacturing UK Ltd (Demo)', country_code: 'GB', currency: 'GBP', timezone: 'Europe/London', fiscal_year_start_month: 4 });
  const ops = await ws.insert('business_units', { name: 'Operations', code: 'OPS' });
  const corp = await ws.insert('business_units', { name: 'Corporate', code: 'CORP' });

  const pune = await ws.insert('locations', {
    legal_entity_id: t.legalEntityId, name: 'Pune Plant', code: 'PNQ-1', kind: 'factory', timezone: 'Asia/Kolkata', city: 'Pune', region: 'Maharashtra', country_code: 'IN',
    latitude: '18.5204', longitude: '73.8567', geofence_radius_m: 250,
  });
  const blr = await ws.insert('locations', {
    legal_entity_id: t.legalEntityId, name: 'Bengaluru HQ', code: 'BLR-HQ', kind: 'office', timezone: 'Asia/Kolkata', city: 'Bengaluru', region: 'Karnataka', country_code: 'IN',
    latitude: '12.9716', longitude: '77.5946', geofence_radius_m: 150,
  });
  const lon = await ws.insert('locations', {
    legal_entity_id: uk, name: 'London Office', code: 'LON-1', kind: 'office', timezone: 'Europe/London', city: 'London', country_code: 'GB', latitude: '51.5072', longitude: '-0.1276',
  });

  const dept = (name: string, code: string, parent: string | null, entity: string, bu: string) =>
    ws.insert('departments', { name, code, parent_id: parent, legal_entity_id: entity, business_unit_id: bu });
  const manufacturing = await dept('Manufacturing', 'MFG', null, t.legalEntityId, ops);
  const assembly = await dept('Assembly Line', 'MFG-ASM', manufacturing, t.legalEntityId, ops);
  const quality = await dept('Quality Assurance', 'MFG-QA', manufacturing, t.legalEntityId, ops);
  const hr = await dept('People & Culture', 'HR', null, t.legalEntityId, corp);
  const finance = await dept('Finance', 'FIN', null, t.legalEntityId, corp);
  const talent = await dept('Talent Acquisition', 'HR-TA', hr, t.legalEntityId, corp);
  const sales = await dept('Sales UK', 'SALES-UK', null, uk, corp);

  const roleId = (key: string) => ws.id('roles', { key });

  const people: DemoPerson[] = [
    { email: 'hr.admin@demo.crew.local', name: 'Priya Nair', title: 'Head of People', dept: hr, loc: blr, entity: t.legalEntityId, roles: ['hr_admin'] },
    { email: 'recruiter@demo.crew.local', name: 'Kabir Shah', title: 'Senior Recruiter', dept: talent, loc: blr, entity: t.legalEntityId, manager: 'hr.admin@demo.crew.local', roles: ['recruiter'] },
    { email: 'payroll@demo.crew.local', name: 'Meera Iyer', title: 'Payroll Lead', dept: finance, loc: blr, entity: t.legalEntityId, roles: ['payroll_admin'] },
    { email: 'finance@demo.crew.local', name: 'Rohan Gupta', title: 'Finance Manager', dept: finance, loc: blr, entity: t.legalEntityId, roles: ['finance_manager'] },
    { email: 'plant.head@demo.crew.local', name: 'Vikram Rao', title: 'Plant Head', dept: manufacturing, loc: pune, entity: t.legalEntityId, roles: ['department_manager', 'hiring_manager'] },
    { email: 'supervisor@demo.crew.local', name: 'Sunita Patil', title: 'Assembly Supervisor', dept: assembly, loc: pune, entity: t.legalEntityId, manager: 'plant.head@demo.crew.local', roles: ['department_manager'] },
    { email: 'operator1@demo.crew.local', name: 'Arjun Kulkarni', title: 'Machine Operator', dept: assembly, loc: pune, entity: t.legalEntityId, manager: 'supervisor@demo.crew.local', roles: [] },
    { email: 'operator2@demo.crew.local', name: 'Neha Deshmukh', title: 'Machine Operator', dept: assembly, loc: pune, entity: t.legalEntityId, manager: 'supervisor@demo.crew.local', roles: [] },
    { email: 'qa.lead@demo.crew.local', name: 'Farhan Qureshi', title: 'QA Lead', dept: quality, loc: pune, entity: t.legalEntityId, manager: 'plant.head@demo.crew.local', roles: [] },
    { email: 'attendance@demo.crew.local', name: 'Lakshmi Menon', title: 'Time Office Executive', dept: hr, loc: pune, entity: t.legalEntityId, manager: 'hr.admin@demo.crew.local', roles: ['attendance_admin'] },
    { email: 'uk.hr@demo.crew.local', name: 'Emma Clarke', title: 'HR Manager UK', dept: sales, loc: lon, entity: uk, roles: ['hr_manager'] },
    { email: 'uk.sales@demo.crew.local', name: 'Oliver Bennett', title: 'Account Executive', dept: sales, loc: lon, entity: uk, manager: 'uk.hr@demo.crew.local', roles: [] },
    { email: 'hr.ops@demo.crew.local', name: 'Anjali Rao', title: 'HR Operations Manager', dept: hr, loc: blr, entity: t.legalEntityId, manager: 'hr.admin@demo.crew.local', roles: ['hr_admin'] },
    { email: 'auditor@demo.crew.local', name: 'Ishaan Verma', title: 'Internal Auditor', dept: finance, loc: blr, entity: t.legalEntityId, roles: ['auditor'] },
  ];

  const membershipByEmail = new Map<string, string>();
  membershipByEmail.set('owner@demo.crew.local', t.ownerMembershipId);
  await ws.set('memberships', { id: t.ownerMembershipId }, { department_id: hr, location_id: blr, title: 'Managing Director' });
  for (const p of people) {
    const user = (await ws.table('users').insert({ email: p.email, full_name: p.name, password_hash: passwordHash, email_verified_at: new Date() })).id as string;
    const m = await ws.insert('memberships', {
      user_id: user, status: 'active', legal_entity_id: p.entity, department_id: p.dept, location_id: p.loc,
      manager_membership_id: p.manager ? membershipByEmail.get(p.manager) : null, title: p.title, joined_at: new Date(),
    });
    membershipByEmail.set(p.email, m);
    for (const r of ['employee', ...(p.roles ?? [])]) {
      await ws.insert('role_assignments', { membership_id: m, role_id: await roleId(r), constraints: r === 'hr_manager' ? { legalEntityIds: [uk] } : {} });
    }
  }
  await ws.set('departments', { id: manufacturing }, { head_membership_id: membershipByEmail.get('plant.head@demo.crew.local') });
  await ws.set('departments', { id: hr }, { head_membership_id: membershipByEmail.get('hr.admin@demo.crew.local') });
  await ws.table('users').update({ email: 'owner@demo.crew.local' }, { $set: { email_verified_at: new Date() } });

  await seedCoreHr(ws, {
    indiaId: t.legalEntityId, ukId: uk, puneId: pune, assemblyId: assembly, qualityId: quality,
    people: [{ email: 'owner@demo.crew.local', name: 'Aarav Mehta', title: 'Managing Director', dept: hr, loc: blr, entity: t.legalEntityId }, ...people],
    membershipByEmail,
  });
  await seedAttendance(ws, { tid, puneId: pune });
  await seedRecruitment(ws, { indiaId: t.legalEntityId, puneId: pune, manufacturingId: manufacturing, membershipByEmail });
  await seedPayroll(ws, { indiaId: t.legalEntityId, membershipByEmail });
  await seedTalent(ws, { assemblyId: assembly, manufacturingId: manufacturing, membershipByEmail });
  await seedHelpdesk(ws, { tid, manufacturingId: manufacturing, membershipByEmail });
  await seedAiAutomation(ws, { membershipByEmail });
  await seedLenses(ws, { membershipByEmail });

  await appendAuditEvent(db, session, {
    tenant_id: tid, actor_type: 'system', actor_id: null, actor_label: 'demo seed', action: 'tenant.created', resource_type: 'tenant', resource_id: tid,
    changes: {}, metadata: { demo: true }, ip: null, user_agent: null, request_id: null,
  });
}

/** Skills for the Workforce Universe skills network, by job title, and one saved headcount scenario. */
async function seedLenses(ws: Workspace, c: { membershipByEmail: Map<string, string> }) {
  const SKILL_CATEGORY: Record<string, string> = {
    'CNC operation': 'Shop floor', Forklift: 'Shop floor', '5S': 'Shop floor', 'Shift planning': 'Shop floor', 'Lean manufacturing': 'Shop floor', Metrology: 'Quality',
    'First aid': 'Safety', 'Six Sigma': 'Quality', 'Root cause analysis': 'Quality', 'ISO 9001': 'Quality',
    'Employment law': 'People', Interviewing: 'People', 'Payroll basics': 'People', Sourcing: 'People', 'Employer branding': 'People', Coaching: 'People',
    'Statutory compliance': 'Finance', 'Excel modelling': 'Finance', Negotiation: 'Business', 'Key accounts': 'Business', Strategy: 'Business',
  };
  // [skill, level] by words in the job title. Demo figures.
  const byTitle: [RegExp, [string, number][]][] = [
    [/operator|technician/i, [['CNC operation', 3], ['Forklift', 2], ['5S', 2], ['First aid', 1]]],
    [/supervisor|plant head|manager/i, [['Shift planning', 3], ['Lean manufacturing', 3], ['5S', 3], ['Coaching', 2]]],
    [/quality|inspector|qa/i, [['Six Sigma', 3], ['Root cause analysis', 3], ['ISO 9001', 2], ['Metrology', 2]]],
    [/hr|people/i, [['Employment law', 3], ['Interviewing', 3], ['Payroll basics', 2], ['Coaching', 2]]],
    [/recruit|talent/i, [['Interviewing', 4], ['Sourcing', 3], ['Employer branding', 2]]],
    [/finance|payroll|account/i, [['Payroll basics', 4], ['Statutory compliance', 3], ['Excel modelling', 3]]],
    [/sales/i, [['Negotiation', 3], ['Key accounts', 3], ['Excel modelling', 1]]],
    [/director|owner/i, [['Strategy', 4], ['Negotiation', 3], ['Lean manufacturing', 2]]],
  ];
  const designations = new Map((await ws.find('designations')).map((d) => [d.id as string, d.name as string]));
  const employees = await ws.find('employees', { status: { $nin: ['exited', 'pre_boarding'] } }, { sort: { employee_code: 1 } });
  const skillId = new Map<string, string>();
  for (const [index, e] of employees.entries()) {
    const n = index + 1;
    const title = designations.get(e.current_designation_id) ?? '';
    const set = byTitle.find(([re]) => re.test(title))?.[1] ?? [['First aid', 1]];
    // Vary levels a little so the network is not uniform.
    for (const [i, [name, level]] of set.entries()) {
      if ((n + i) % 5 === 0) continue;
      if (!skillId.has(name)) skillId.set(name, await ws.insert('skills', { name, category: SKILL_CATEGORY[name] ?? null }));
      const lv = Math.max(1, Math.min(4, level + ((n + i) % 3 === 0 ? 1 : (n + i) % 4 === 0 ? -1 : 0)));
      await ws.insert('employee_skills', { employee_id: e.id, skill_id: skillId.get(name), level: lv });
    }
  }
  const assembly = (await ws.findOne('departments', { name: 'Assembly Line' }))?.id;
  const quality = (await ws.findOne('departments', { name: 'Quality Assurance' }))?.id;
  if (assembly && quality) {
    const today = new Date();
    const q = Math.floor(today.getUTCMonth() / 3) * 3 + 3;
    const nextQuarter = `${today.getUTCFullYear() + Math.floor(q / 12)}-${String((q % 12) + 1).padStart(2, '0')}`;
    await ws.insert('workforce_scenarios', {
      name: 'Second shift on line 2',
      notes: 'Demo data: what a second shift would add from next quarter.',
      changes: [
        { departmentId: assembly, delta: 6, monthlyCostPerHead: 32000, startMonth: nextQuarter, role: 'Machine Operator (second shift)' },
        { departmentId: quality, delta: 1, startMonth: nextQuarter, role: 'Quality Inspector' },
      ],
      assumptions: { startMonth: null, horizonMonths: 12, attritionPctYear: 12, payRisePct: 8, payRiseMonth: `${today.getUTCFullYear() + 1}-04` },
      created_by_membership_id: c.membershipByEmail.get('plant.head@demo.crew.local'),
    });
  }
}

interface DemoPerson { email: string; name: string; title: string; dept: string; loc: string; entity: string; manager?: string; roles?: string[] }

/** Phase 2 demo data: employee records, designations, leave setup, holidays, onboarding and a few requests. */
async function seedCoreHr(
  ws: Workspace,
  c: { indiaId: string; ukId: string; puneId: string; assemblyId: string; qualityId: string; people: DemoPerson[]; membershipByEmail: Map<string, string> },
) {
  const today = isoDay(new Date());
  const year = Number(today.slice(0, 4));

  // Designations from the job titles in use.
  const designation = new Map<string, string>();
  const levels: Record<string, number> = { 'Managing Director': 1, 'Head of People': 2, 'Plant Head': 2, 'Finance Manager': 3, 'HR Manager UK': 3 };
  for (const title of [...new Set([...c.people.map((p) => p.title), 'Helper', 'Quality Inspector'])]) {
    designation.set(title, await ws.insert('designations', { name: title, level: levels[title] ?? 5 }));
  }

  // Employee records for every demo member, plus shop-floor staff without SampCrew logins.
  const joining = ['2019-04-01', '2020-06-15', '2021-01-11', '2021-09-01', '2018-11-05', '2020-02-03', '2022-07-18', '2023-03-06', '2021-05-24', '2022-10-10', '2022-01-17', `${year}-08-03`, '2023-11-13', '2024-02-19'];
  const employeeByEmail = new Map<string, string>();
  let n = 1;
  const addEmployee = async (p: { name: string; email?: string; title: string; dept: string; loc: string; entity: string; managerId: string | null; joined: string; membershipId?: string | null; probationEnd?: string | null }) => {
    const [first, ...rest] = p.name.split(' ');
    const code = `NW${String(n++).padStart(4, '0')}`;
    const onProbation = !!p.probationEnd && p.probationEnd >= today;
    const id = await ws.insert('employees', {
      employee_code: code, first_name: first, last_name: rest.join(' '), work_email: p.email ?? null, date_of_joining: p.joined, probation_end_date: p.probationEnd ?? null,
      confirmation_date: onProbation ? null : p.probationEnd ?? p.joined, status: onProbation ? 'probation' : 'active',
      current_legal_entity_id: p.entity, current_department_id: p.dept, current_location_id: p.loc, current_designation_id: designation.get(p.title),
      current_manager_employee_id: p.managerId, membership_id: p.membershipId ?? null,
    });
    await ws.insert('employment_records', {
      employee_id: id, effective_from: p.joined, legal_entity_id: p.entity, department_id: p.dept, location_id: p.loc, designation_id: designation.get(p.title),
      manager_employee_id: p.managerId, employment_type: 'full_time', change_reason: 'hire',
    });
    await ws.insert('lifecycle_events', { employee_id: id, kind: 'hired', effective_on: p.joined, details: { demo: true } });
    return id;
  };
  for (const [i, p] of c.people.entries()) {
    const probationEnd = p.email === 'uk.sales@demo.crew.local' ? `${year + 1}-02-02` : null;
    const id = await addEmployee({
      ...p, managerId: p.manager ? employeeByEmail.get(p.manager)! : null, joined: joining[i] ?? '2022-01-03',
      membershipId: c.membershipByEmail.get(p.email), probationEnd,
    });
    employeeByEmail.set(p.email, id);
  }
  const supervisor = employeeByEmail.get('supervisor@demo.crew.local')!;
  const qaLead = employeeByEmail.get('qa.lead@demo.crew.local')!;
  const shopFloor = new Map<string, string>();
  for (const [name, title, dept] of [['Ganesh Pawar', 'Helper', c.assemblyId], ['Rekha Jadhav', 'Machine Operator', c.assemblyId], ['Sameer Khan', 'Quality Inspector', c.qualityId]] as const) {
    shopFloor.set(name, await addEmployee({ name, title, dept, loc: c.puneId, entity: c.indiaId, managerId: dept === c.qualityId ? qaLead : supervisor, joined: '2023-06-01' }));
  }
  // Some history for the Workforce Universe timeline: Rekha started as a quality inspector and moved to the
  // assembly line as a machine operator the next spring.
  const rekha = shopFloor.get('Rekha Jadhav')!;
  const moveOn = '2024-04-01';
  await ws.set('employment_records', { employee_id: rekha }, {
    department_id: c.qualityId, designation_id: designation.get('Quality Inspector'), manager_employee_id: qaLead, effective_to: addDays(moveOn, -1),
  });
  await ws.insert('employment_records', {
    employee_id: rekha, effective_from: moveOn, legal_entity_id: c.indiaId, department_id: c.assemblyId, location_id: c.puneId, designation_id: designation.get('Machine Operator'),
    manager_employee_id: supervisor, employment_type: 'full_time', change_reason: 'transfer',
  });
  await ws.insert('lifecycle_events', { employee_id: rekha, kind: 'transferred', effective_on: moveOn, details: { demo: true } });
  await ws.insert('employee_number_series', { prefix: 'NW', padding: 4, next_value: n });

  // Each login follows its employee record (as the API's syncMembership does): placement, manager and title.
  const employees = await ws.find('employees', { membership_id: { $ne: null } });
  const byId = new Map(employees.map((e) => [e.id as string, e]));
  const titles = new Map([...designation].map(([title, id]) => [id, title]));
  for (const e of employees) {
    await ws.set('memberships', { id: e.membership_id }, {
      legal_entity_id: e.current_legal_entity_id, department_id: e.current_department_id, location_id: e.current_location_id,
      manager_membership_id: e.current_manager_employee_id ? byId.get(e.current_manager_employee_id)?.membership_id ?? null : null,
      employee_id: e.id, title: titles.get(e.current_designation_id) ?? null,
    });
  }

  // Leave types and policies. These are demo policies, not a statement of any country's statutory minimum.
  const type = (code: string, name: string, paid: boolean, color: string, halfDay = true) =>
    ws.insert('leave_types', { code, name, paid, color, allow_half_day: halfDay, description: 'Demo leave type' });
  const cl = await type('CL', 'Casual leave', true, '#2563eb');
  const sl = await type('SL', 'Sick leave', true, '#dc2626');
  const el = await type('EL', 'Earned leave', true, '#059669', false);
  const lwp = await type('LWP', 'Leave without pay', false, '#6b7280');
  const al = await type('AL', 'Annual leave', true, '#7c3aed');
  const policy = (typeId: string, entity: string, method: string, entitlement: string, carry: string, extra: { notice?: number; maxRun?: string; probation?: boolean } = {}) =>
    ws.insert('leave_policies', {
      leave_type_id: typeId, legal_entity_id: entity, accrual_method: method, annual_entitlement: entitlement, carry_forward_max: carry,
      min_notice_days: extra.notice ?? 0, max_consecutive_days: extra.maxRun ?? null, available_during_probation: extra.probation ?? true,
    });
  await policy(cl, c.indiaId, 'annual_upfront', '8', '0', { maxRun: '3' });
  await policy(sl, c.indiaId, 'annual_upfront', '8', '0');
  await policy(el, c.indiaId, 'monthly', '18', '30', { notice: 7, probation: false });
  await policy(lwp, c.indiaId, 'none', '0', '0');
  await policy(al, c.ukId, 'monthly', '25', '5', { notice: 3 });
  await policy(lwp, c.ukId, 'none', '0', '0');

  // Holiday calendars. Only fixed-date national holidays are listed for India; add regional ones per location.
  const india = await ws.insert('holiday_calendars', { name: 'India offices (demo data)', legal_entity_id: c.indiaId, weekly_offs: [0, 6] });
  const plant = await ws.insert('holiday_calendars', { name: 'Pune Plant, Sundays off (demo data)', location_id: c.puneId, weekly_offs: [0] });
  const ukCal = await ws.insert('holiday_calendars', { name: 'England and Wales (demo data)', legal_entity_id: c.ukId, weekly_offs: [0, 6] });
  for (const cal of [india, plant]) {
    for (const y of [year, year + 1]) {
      for (const [md, name] of [['01-26', 'Republic Day'], ['08-15', 'Independence Day'], ['10-02', 'Gandhi Jayanti']]) {
        await ws.insert('holidays', { calendar_id: cal, holiday_date: `${y}-${md}`, name });
      }
    }
  }
  if (year === 2026) {
    for (const [d, name] of [['2026-01-01', "New Year's Day"], ['2026-04-03', 'Good Friday'], ['2026-04-06', 'Easter Monday'], ['2026-05-04', 'Early May bank holiday'],
      ['2026-05-25', 'Spring bank holiday'], ['2026-08-31', 'Summer bank holiday'], ['2026-12-25', 'Christmas Day'], ['2026-12-28', 'Boxing Day (substitute day)']]) {
      await ws.insert('holidays', { calendar_id: ukCal, holiday_date: d, name });
    }
  }

  // Accruals due so far this year, using the same arithmetic as the API.
  const emps = await ws.find('employees');
  const pols = await ws.find('leave_policies', { active: true });
  for (const e of emps) {
    for (const p of pols.filter((x) => x.legal_entity_id === e.current_legal_entity_id)) {
      for (const cr of leaveMath.accrualsDue({ accrualMethod: p.accrual_method, annualEntitlement: leaveMath.toH(p.annual_entitlement), rounding: p.rounding }, { dateOfJoining: e.date_of_joining, lastWorkingDay: null }, today)) {
        await ws.insert('leave_ledger', {
          employee_id: e.id, leave_type_id: p.leave_type_id, leave_year: year, kind: 'accrual', quantity: leaveMath.fromH(cr.quantity), effective_on: cr.effectiveOn,
          accrual_key: cr.key, note: `Accrual ${cr.key.slice(1)}`,
        });
      }
    }
  }

  // A pending request waiting for the assembly supervisor, and an approved one already taken.
  const nextMonday = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7) + 7);
    return isoDay(d);
  })();
  const arjun = employeeByEmail.get('operator1@demo.crew.local')!;
  const arjunM = c.membershipByEmail.get('operator1@demo.crew.local')!;
  const supM = c.membershipByEmail.get('supervisor@demo.crew.local')!;
  if (nextMonday.slice(0, 4) === String(year)) {
    const lr = await ws.insert('leave_requests', {
      employee_id: arjun, leave_type_id: cl, start_date: nextMonday, end_date: nextMonday, days: '1', reason: 'Family function', requested_by_membership_id: arjunM,
    });
    const ar = await ws.insert('approval_requests', {
      resource_type: 'leave_request', resource_id: lr, subject_employee_id: arjun, requested_by_membership_id: arjunM,
      summary: `Arjun Kulkarni: Casual leave, ${nextMonday} (1.00 days). "Family function"`,
    });
    await ws.insert('approval_steps', { request_id: ar, seq: 1, kind: 'manager', approver_membership_id: supM, status: 'pending' });
    await ws.set('leave_requests', { id: lr }, { approval_request_id: ar });
    await ws.insert('notifications', {
      membership_id: supM, kind: 'approval.requested', title: 'Leave request waiting for your approval', body: `Arjun Kulkarni: Casual leave, ${nextMonday}`, link: '/approvals',
    });
  }
  const neha = employeeByEmail.get('operator2@demo.crew.local')!;
  const day = `${year}-03-10`;
  if (day < today) {
    const lr = await ws.insert('leave_requests', {
      employee_id: neha, leave_type_id: sl, start_date: day, end_date: day, days: '1', reason: 'Fever', status: 'approved', decided_at: new Date(),
      requested_by_membership_id: c.membershipByEmail.get('operator2@demo.crew.local'),
    });
    await ws.insert('leave_ledger', { employee_id: neha, leave_type_id: sl, leave_year: year, kind: 'taken', quantity: '-1', effective_on: day, leave_request_id: lr });
  }
}

/**
 * Phase 3 demo data: a night shift, a Pune policy, about a week of punches for the plant, and a simulated device
 * whose punches arrive through enrolment numbers. Attendance days are not inserted: the API derives them from these
 * raw punches on first view and in the hourly job, exactly as it does for real data.
 */
async function seedAttendance(ws: Workspace, c: { tid: string; puneId: string }) {
  const gen = await ws.id('shift_templates', { code: 'GEN' });
  await ws.insert('shift_templates', {
    code: 'NIGHT', name: 'Night shift (demo data)', start_time: '22:00', end_time: '06:00', break_minutes: 30, overtime_enabled: true, overtime_min_minutes: 30, color: '#7c3aed',
  });
  await ws.insert('attendance_policies', { location_id: c.puneId, geofence_mode: 'warn', default_shift_id: gen, correction_window_days: 30 });

  const web = {
    arjun: await ws.id('employees', { work_email: 'operator1@demo.crew.local' }),
    neha: await ws.id('employees', { work_email: 'operator2@demo.crew.local' }),
    sunita: await ws.id('employees', { work_email: 'supervisor@demo.crew.local' }),
  };
  const ganesh = await ws.id('employees', { first_name: 'Ganesh' });
  const rekha = await ws.id('employees', { first_name: 'Rekha' });

  const device = await ws.insert('attendance_devices', {
    name: 'Pune gate (simulated demo device)', vendor: 'zkteco', model: 'Simulated', serial_number: `DEMO${c.tid.replace(/-/g, '').slice(0, 10).toUpperCase()}`,
    location_id: c.puneId, time_zone: 'Asia/Kolkata', simulated: true, last_seen_at: new Date(),
  });
  await ws.insertMany('device_user_mappings', [
    { device_id: null, device_user_id: '101', employee_id: ganesh },
    { device_id: null, device_user_id: '102', employee_id: rekha },
  ]);

  // The last 26 days before today that the Pune calendar treats as working days (Sundays and holidays skipped).
  const calendars = (await ws.find('holiday_calendars', { location_id: c.puneId })).map((x) => x.id);
  const holidays = new Set((await ws.find('holidays', { calendar_id: { $in: calendars } })).map((h) => h.holiday_date as string));
  const days: string[] = [];
  const cursor = new Date(Date.now() + 5.5 * HOUR); // today in India
  while (days.length < 26) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const d = isoDay(cursor);
    if (cursor.getUTCDay() !== 0 && !holidays.has(d)) days.push(d);
  }
  const at = (d: string, hm: string) => new Date(`${d}T${hm}:00+05:30`);
  const events: Row[] = [];
  let accepted = 0;
  for (const [i, d] of days.entries()) {
    for (const [key, id] of Object.entries(web)) {
      const late = key === 'neha' && i % 3 === 1;
      const missingOut = key === 'arjun' && i === 2; // a forgotten punch-out, to try a correction on
      const punches: [string, 'in' | 'out'][] = [[late ? '09:34' : `08:5${i % 7}`, 'in']];
      if (!missingOut) punches.push([key === 'sunita' && i === 0 ? '19:20' : `18:0${(i * 3) % 10}`, 'out']);
      for (const [hm, direction] of punches) {
        events.push({
          employee_id: id, source: 'web', source_event_id: `demo-${key}-${d}-${direction}`, captured_at: at(d, hm), direction,
          latitude: '18.5205', longitude: '73.8566', accuracy_m: 15, geofence_result: 'inside', distance_m: 15, note: 'Demo data',
        });
      }
    }
    // Shop floor staff punch on the device. 103 is not mapped yet, so it shows up as an enrolment number to map.
    for (const [pin, inAt, outAt] of [['101', '08:46', '17:58'], ['102', `08:5${i % 9}`, '18:04'], ['103', '08:55', '18:01']] as const) {
      for (const [hm, direction, status] of [[inAt, 'in', 0], [outAt, 'out', 1]] as const) {
        events.push({
          device_id: device, device_user_id: pin, source: 'device', source_event_id: `demo-${device}-${pin}-${d}-${direction}`, captured_at: at(d, hm),
          device_local_time: `${d} ${hm}:00`, direction, verify_method: 'fingerprint', raw: { demo: true, status },
        });
        accepted++;
      }
    }
  }
  await ws.insertMany('attendance_events', events);
  await ws.set('attendance_devices', { id: device }, { records_accepted: accepted, last_punch_at: at(days[0]!, '18:04') });
  await ws.insert('device_ingest_log', { device_id: device, kind: 'attlog', records: accepted, accepted, duplicates: 0, rejected: 0, detail: 'Demo data: a week of punches' });
}

/**
 * Phase 4 demo data: a career site, an open job with a published posting and three candidates at different
 * stages (one with a past interview awaiting a scorecard), and a draft requisition. Every candidate is tagged
 * "demo" and uses a .local address, so no real person is contacted.
 */
async function seedRecruitment(ws: Workspace, c: { indiaId: string; puneId: string; manufacturingId: string; membershipByEmail: Map<string, string> }) {
  const m = (email: string) => c.membershipByEmail.get(email)!;
  const recruiter = m('recruiter@demo.crew.local');
  const plantHead = m('plant.head@demo.crew.local');
  const qaLead = m('qa.lead@demo.crew.local');

  await ws.insert('career_sites', {
    enabled: true, slug: 'northwind-demo', headline: 'Build what moves India (demo career site)',
    intro: 'This is a demo career site for the Northwind sample workspace. Applications here are stored in the demo workspace only.',
    privacy_notice: 'Northwind (a demo organisation) uses the details and CV you send only to consider you for this job and similar roles. Our hiring team and the interviewers for the role can see them. We keep them for one year after your last contact with us, then delete them. You can ask us to delete them sooner at any time.',
    retention_days: 365,
  });
  await ws.insert('requisition_number_series', { next_value: 3 });
  const stage = (kind: string) => ws.id('recruitment_stages', { kind }, { sort: { position: 1 } });

  const open = await ws.insert('job_requisitions', {
    code: 'REQ-0001', title: 'Quality Engineer', legal_entity_id: c.indiaId, department_id: c.manufacturingId, location_id: c.puneId, hiring_manager_membership_id: plantHead,
    employment_type: 'full_time', work_mode: 'onsite', headcount: 2, reason: 'new_role', salary_min: '600000', salary_max: '900000', currency: 'INR',
    justification: 'Demo data: second shift line needs in-process inspection cover.',
    description: 'Own in-process quality checks on the assembly line and lead root-cause analysis for defects.',
    scorecard: ['Quality systems', 'Problem solving', 'Communication', 'Shop-floor safety'], status: 'open', created_by_membership_id: recruiter,
    approved_at: ago(20 * DAY), opened_at: ago(18 * DAY),
  });
  await ws.insert('job_postings', {
    requisition_id: open, public_title: 'Quality Engineer (demo)', slug: 'quality-engineer', summary: 'Keep our Pune assembly line right first time',
    description: 'This is a demo job posting.\n\nYou will run in-process inspections on our assembly line, lead root-cause analysis when defects appear, and work with supervisors to keep quality high on every shift.\n\nYou have 2 or more years in manufacturing quality, know 8D or a similar method, and communicate clearly with operators and engineers.',
    location_text: 'Pune Plant', show_salary: true, published_at: ago(17 * DAY),
  });
  await ws.insert('job_requisitions', {
    code: 'REQ-0002', title: 'CNC Machine Operator', legal_entity_id: c.indiaId, department_id: c.manufacturingId, location_id: c.puneId, hiring_manager_membership_id: plantHead,
    employment_type: 'full_time', work_mode: 'onsite', headcount: 3, reason: 'new_role', salary_min: '300000', salary_max: '420000', currency: 'INR',
    justification: 'Demo data: new CNC cell starting next quarter.', scorecard: ['Machine skills', 'Safety', 'Reliability'], status: 'draft', created_by_membership_id: plantHead,
  });

  const candidates: { first: string; last: string; email: string; title: string; company: string; source: string; basis: string; kind: string; daysAgo: number; cover?: string }[] = [
    { first: 'Ananya', last: 'Joshi', email: 'ananya.joshi@candidates.demo.crew.local', title: 'Quality Inspector', company: 'Demo Auto Parts', source: 'career_site', basis: 'candidate_consent', kind: 'interview', daysAgo: 12, cover: 'I have led 8D investigations on a press line for three years.' },
    { first: 'Rahul', last: 'Verma', email: 'rahul.verma@candidates.demo.crew.local', title: 'QA Engineer', company: 'Demo Castings', source: 'referral', basis: 'recruiter_confirmed', kind: 'screen', daysAgo: 6 },
    { first: 'Sneha', last: 'Kulkarni', email: 'sneha.kulkarni@candidates.demo.crew.local', title: 'Graduate Engineer Trainee', company: 'Demo Forgings', source: 'career_site', basis: 'candidate_consent', kind: 'new', daysAgo: 2, cover: 'Looking to grow into a quality role on the shop floor.' },
  ];
  const applied = await stage('new');
  for (const cd of candidates) {
    const since = ago(cd.daysAgo * DAY);
    const moved = ago(Math.max(cd.daysAgo - 2, 0) * DAY);
    const cand = await ws.insert('candidates', {
      first_name: cd.first, last_name: cd.last, email: cd.email, current_title: cd.title, current_company: cd.company, location_text: 'Pune', source: cd.source,
      source_detail: 'Demo data', tags: ['demo'], consent_basis: cd.basis, privacy_notice_version: cd.basis === 'candidate_consent' ? 1 : null,
      consent_at: since, last_activity_at: since, created_at: since,
    });
    const to = await stage(cd.kind);
    const app = await ws.insert('applications', {
      candidate_id: cand, requisition_id: open, stage_id: to, source: cd.source, cover_note: cd.cover ?? null,
      created_by_membership_id: cd.source === 'career_site' ? null : recruiter, applied_at: since, stage_entered_at: moved,
    });
    await ws.insert('application_events', { application_id: app, kind: 'applied', to_stage_id: applied, detail: { source: cd.source }, created_at: since });
    if (to !== applied) {
      await ws.insert('application_events', { application_id: app, kind: 'stage_changed', from_stage_id: applied, to_stage_id: to, actor_membership_id: recruiter, created_at: moved });
    }
    if (cd.kind === 'interview') {
      // Yesterday's interview: the QA lead's scorecard is still due, so the demo can show the scorecard flow.
      const hour = new Date();
      hour.setUTCMinutes(0, 0, 0);
      const iv = await ws.insert('interviews', {
        application_id: app, title: 'Technical interview', starts_at: new Date(hour.getTime() - DAY), duration_minutes: 60, mode: 'video',
        meeting_url: 'https://meet.example.com/demo-quality-engineer', created_by_membership_id: recruiter,
      });
      await ws.insertMany('interview_panelists', [{ interview_id: iv, membership_id: qaLead }, { interview_id: iv, membership_id: plantHead }]);
      await ws.insert('application_events', {
        application_id: app, kind: 'interview_scheduled', detail: { interviewId: iv, title: 'Technical interview' }, actor_membership_id: recruiter, created_at: ago(3 * DAY),
      });
    }
  }
}

/**
 * Phase 5 demo data: statutory settings for the India entity (the SampCrew starting values, saved as demo data), a
 * salary for everyone employed by it, and two expense claims (one approved and waiting for payroll, one waiting
 * for the supervisor). No payroll run is created, so the first run can be tried end to end. The UK entity has no
 * payroll: SampCrew's statutory rules in this release cover India only.
 */
async function seedPayroll(ws: Workspace, c: { indiaId: string; membershipByEmail: Map<string, string> }) {
  const today = isoDay(new Date());
  const fy = payrollEngine.fyStart(today);
  await ws.insert('statutory_settings', { legal_entity_id: c.indiaId, effective_from: fy, lop_source: 'attendance_and_leave', settings: DEFAULT_IN_STATUTORY });
  const structure = await ws.id('salary_structures', { name: 'Standard' });
  const components = new Map((await ws.find('pay_components')).map((p) => [p.id as string, p]));
  const lines = (await ws.find('salary_structure_lines', { structure_id: structure }, { sort: { position: 1 } })).map((l) => {
    const k = components.get(l.component_id)!;
    return { componentId: l.component_id as string, code: k.code, name: k.name, kind: k.kind, calc: l.calc as payrollEngine.CalcMethod, value: l.value as string, isBasic: k.is_basic as boolean };
  });
  // Annual CTC by work email or first name (demo figures).
  const ctc: Record<string, string> = {
    'owner@demo.crew.local': '4800000', 'hr.admin@demo.crew.local': '2400000', 'recruiter@demo.crew.local': '1200000', 'payroll@demo.crew.local': '1500000',
    'finance@demo.crew.local': '1800000', 'plant.head@demo.crew.local': '3000000', 'supervisor@demo.crew.local': '720000', 'operator1@demo.crew.local': '300000',
    'operator2@demo.crew.local': '280000', 'qa.lead@demo.crew.local': '900000', 'attendance@demo.crew.local': '420000', 'auditor@demo.crew.local': '1400000', 'hr.ops@demo.crew.local': '1600000',
    Ganesh: '216000', Rekha: '264000', Sameer: '240000',
  };
  for (const e of await ws.find('employees', { current_legal_entity_id: c.indiaId })) {
    const annual = ctc[e.work_email ?? ''] ?? ctc[e.first_name];
    if (!annual) continue;
    const built = payrollEngine.buildSalary(annual, lines, { pf: true, settings: DEFAULT_IN_STATUTORY });
    const sal = await ws.insert('employee_salaries', {
      employee_id: e.id, effective_from: e.date_of_joining, annual_ctc: annual, currency: 'INR', structure_id: structure, employer_pf_monthly: built.employerPfMonthly, note: 'Demo data',
    });
    await ws.insertMany('employee_salary_lines', lines.map((l, i) => ({ salary_id: sal, component_id: l.componentId, position: i + 1, monthly: built.components[i]!.monthly })));
  }

  const emp = (email: string) => ws.id('employees', { work_email: email });
  const category = (name: string) => ws.id('expense_categories', { name });
  const prev = new Date();
  prev.setUTCDate(10);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const lastMonth10th = isoDay(prev); // inside last month, so the first demo run reimburses it
  const yesterday = isoDay(ago(DAY));
  await ws.insert('expense_claims', {
    employee_id: await emp('operator1@demo.crew.local'), category_id: await category('Travel'), spent_on: lastMonth10th, amount: '850', currency: 'INR',
    description: 'Cab to the supplier audit in Chakan (demo data)', status: 'approved', submitted_by_membership_id: c.membershipByEmail.get('operator1@demo.crew.local'), decided_at: new Date(),
  });
  const nehaM = c.membershipByEmail.get('operator2@demo.crew.local')!;
  const supM = c.membershipByEmail.get('supervisor@demo.crew.local')!;
  const neha = await emp('operator2@demo.crew.local');
  const claim = await ws.insert('expense_claims', {
    employee_id: neha, category_id: await category('Meals'), spent_on: yesterday, amount: '640', currency: 'INR',
    description: 'Lunch during the night-shift handover training (demo data)', status: 'pending', submitted_by_membership_id: nehaM,
  });
  const ar = await ws.insert('approval_requests', {
    resource_type: 'expense_claim', resource_id: claim, subject_employee_id: neha, requested_by_membership_id: nehaM,
    summary: `Neha Deshmukh: Meals expense of INR 640.00 on ${yesterday}. Lunch during the night-shift handover training (demo data)`,
  });
  await ws.insert('approval_steps', { request_id: ar, seq: 1, kind: 'manager', approver_membership_id: supM, status: 'pending' });
  await ws.set('expense_claims', { id: claim }, { approval_request_id: ar });
}

/**
 * Phase 6 demo data: goals with check-ins, a mid-year review cycle in progress for the Assembly Line, learning
 * assignments, an open anonymous survey with a few answers, and recognition posts. Every record says it is demo data.
 */
async function seedTalent(ws: Workspace, c: { assemblyId: string; manufacturingId: string; membershipByEmail: Map<string, string> }) {
  const emp = (filter: Row) => ws.id('employees', filter);
  const m = (email: string) => c.membershipByEmail.get(email)!;
  const year = new Date().getUTCFullYear();
  const today = isoDay(new Date());
  const vikram = await emp({ work_email: 'plant.head@demo.crew.local' });
  const sunita = await emp({ work_email: 'supervisor@demo.crew.local' });
  const arjun = await emp({ work_email: 'operator1@demo.crew.local' });
  const neha = await emp({ work_email: 'operator2@demo.crew.local' });
  const farhan = await emp({ work_email: 'qa.lead@demo.crew.local' });
  const ganesh = await emp({ first_name: 'Ganesh' });
  const rekha = await emp({ first_name: 'Rekha' });

  // Goals --------------------------------------------------------------------------------------------------------
  const goal = (employeeId: string, by: string, title: string, parent: string | null, weight: number, progress: number, confidence: string | null) =>
    ws.insert('goals', {
      employee_id: employeeId, parent_goal_id: parent, title, description: 'Demo data', period_start: `${year}-01-01`, period_end: `${year}-12-31`,
      weight, progress, reported_progress: progress, confidence, last_checkin_at: confidence === null ? null : ago(3 * DAY), created_by_membership_id: m(by),
    });
  const kr = (goalId: string, position: number, title: string, start: number, target: number, current: number, unit: string) =>
    ws.insert('goal_key_results', { goal_id: goalId, position, title, start_value: start, target_value: target, current_value: current, unit });
  const oee = await goal(vikram, 'plant.head@demo.crew.local', 'Raise assembly line OEE to 85%', null, 60, 38.5, 'on_track');
  await kr(oee, 1, 'Overall equipment effectiveness', 72, 85, 77, '%');
  const defects = await goal(sunita, 'supervisor@demo.crew.local', 'Cut night-shift handover defects', oee, 50, 40, 'at_risk');
  await kr(defects, 1, 'Handover defects per month', 40, 10, 28, 'defects');
  await ws.insert('goal_checkins', {
    goal_id: defects, progress: 40, confidence: 'at_risk', note: 'Checklist adopted on line 2; line 3 still uses paper (demo data)',
    values: [{ title: 'Handover defects per month', from: '34.00', to: '28' }], by_membership_id: m('supervisor@demo.crew.local'), created_at: ago(3 * DAY),
  });
  await goal(arjun, 'supervisor@demo.crew.local', 'Get certified on the new CNC cell', defects, 40, 50, 'on_track');

  // Review cycle in progress -------------------------------------------------------------------------------------
  const questions = [
    { id: 'achievements', text: 'What were the most important results this period?' },
    { id: 'strengths', text: 'Which strengths made the biggest difference?' },
    { id: 'growth', text: 'What should change or grow next period?' },
  ];
  const scale = [
    { value: 1, label: 'Below expectations' }, { value: 2, label: 'Partly meets expectations' }, { value: 3, label: 'Meets expectations' },
    { value: 4, label: 'Exceeds expectations' }, { value: 5, label: 'Outstanding' },
  ];
  const cycle = await ws.insert('review_cycles', {
    name: `Mid-year ${year} review (demo data)`, period_start: `${year}-01-01`, period_end: `${year}-06-30`, status: 'active', self_review: true, peer_feedback: true,
    questions, rating_scale: scale, department_id: c.assemblyId, launched_at: ago(10 * DAY), created_by_membership_id: m('hr.admin@demo.crew.local'),
  });
  const answers = (who: string) => ({
    achievements: `${who} delivered the planned output with fewer stoppages (demo data).`,
    strengths: 'Reliable on night shifts and helps new joiners.',
    growth: 'Take on the changeover checklist and train one colleague.',
  });
  const review = (employeeId: string, managerId: string, selfDone: boolean, managerRating: number | null) =>
    ws.insert('reviews', {
      cycle_id: cycle, employee_id: employeeId, manager_employee_id: managerId,
      self_status: selfDone ? 'submitted' : 'pending', self_answers: selfDone ? answers('I') : {}, self_rating: selfDone ? 3 : null, self_submitted_at: selfDone ? new Date() : null,
      manager_status: managerRating ? 'submitted' : 'pending', manager_answers: managerRating ? answers('They') : {}, manager_rating: managerRating, manager_submitted_at: managerRating ? new Date() : null,
    });
  await review(sunita, vikram, true, 4);
  await review(neha, sunita, true, 3);
  await review(ganesh, sunita, false, 3);
  await review(rekha, sunita, false, 4);
  const arjunReview = await review(arjun, sunita, false, null);
  const peer = [
    [neha, 'Always first to help with a jammed feeder.', 'Write down the fixes so others can learn them.'],
    [rekha, 'Calm and careful during changeovers.', 'Speak up earlier when parts run low.'],
    [ganesh, 'Explains the machine clearly to helpers.', 'Hand over the shift log on time.'],
  ] as const;
  for (const [reviewer, strengths, improve] of peer) {
    await ws.insert('review_feedback', {
      review_id: arjunReview, reviewer_employee_id: reviewer, requested_by_membership_id: m('supervisor@demo.crew.local'), status: 'submitted',
      answers: { strengths: `${strengths} (demo data)`, improve }, submitted_at: ago(2 * DAY),
    });
  }

  // Learning -----------------------------------------------------------------------------------------------------
  const course = (title: string, format: string, minutes: number, validity: number | null, category: string, selfEnrol: boolean, description: string) =>
    ws.insert('courses', {
      title, description: `${description} (demo data, no content link)`, format, duration_minutes: minutes, validity_months: validity, category, self_enrol: selfEnrol,
      created_by_membership_id: m('hr.admin@demo.crew.local'),
    });
  const forklift = await course('Forklift safety refresher', 'document', 45, 12, 'Safety', false, 'Annual refresher on safe forklift operation in the plant');
  const drill = await course('Fire drill and evacuation', 'classroom', 60, 12, 'Safety', false, 'Practical drill on the shop floor');
  await course('Lean basics: 5S on the line', 'online', 90, null, 'Operations', true, 'Sort, set in order, shine, standardise, sustain');
  await course('Spreadsheets for supervisors', 'online', 120, null, 'Skills', true, 'Shift reports and simple charts');
  const path = await ws.insert('learning_paths', { title: 'Shop floor safety', description: 'Required every year for plant staff (demo data)' });
  await ws.insertMany('learning_path_courses', [{ path_id: path, course_id: forklift, position: 1 }, { path_id: path, course_id: drill, position: 2 }]);
  const due = isoDay(new Date(Date.now() + 14 * DAY));
  for (const who of [arjun, neha]) {
    for (const courseId of [forklift, drill]) {
      await ws.insert('course_assignments', { employee_id: who, course_id: courseId, path_id: path, source: 'assigned', assigned_by_membership_id: m('supervisor@demo.crew.local'), due_on: due });
    }
  }
  const completedOn = addDays(today, -4);
  await ws.set('course_assignments', { employee_id: neha, course_id: forklift }, {
    status: 'completed', started_at: ago(5 * DAY), completed_on: completedOn, completion_note: 'Demo data',
    completed_by_membership_id: m('operator2@demo.crew.local'), expires_on: addMonths(completedOn, 12),
  });

  // An open anonymous survey for Manufacturing, with three demo answers ----------------------------------------------
  const survey = await ws.insert('surveys', {
    title: 'Plant pulse (demo data)', description: 'Five questions, fully anonymous.', min_responses: 3,
    questions: [
      { id: 'tools', kind: 'scale', text: 'I have the tools and information I need to do my job well' },
      { id: 'safety', kind: 'scale', text: 'I feel safe raising a problem on the line' },
      { id: 'enps', kind: 'enps', text: 'How likely are you to recommend working here to a friend?' },
      { id: 'comments', kind: 'text', text: 'What one thing would make work better?' },
    ],
    status: 'open', department_id: c.manufacturingId, closes_on: addDays(today, 10), opened_at: ago(2 * DAY), created_by_membership_id: m('hr.admin@demo.crew.local'),
  });
  // Everyone with a login in Manufacturing or any department under it.
  const departments = await ws.find('departments', {}, { projection: { parent_id: 1 } });
  const within = new Set([c.manufacturingId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const d of departments) if (d.parent_id && within.has(d.parent_id) && !within.has(d.id)) (within.add(d.id), (grew = true));
  }
  const audience = await ws.find('employees', { membership_id: { $ne: null }, status: { $in: ['probation', 'active', 'notice'] }, current_department_id: { $in: [...within] } });
  const responded = new Set([vikram, sunita, farhan]);
  await ws.insertMany('survey_invitations', audience.map((e) => ({ survey_id: survey, employee_id: e.id, responded: responded.has(e.id) })));
  for (const a of [{ tools: 4, safety: 5, enps: 9, comments: 'More spare parts on the night shift (demo data)' }, { tools: 3, safety: 4, enps: 7 }, { tools: 2, safety: 3, enps: 6, comments: 'Fix the canteen timings (demo data)' }]) {
    await ws.insert('survey_responses', { survey_id: survey, department_id: c.manufacturingId, answers: a, submitted_on: addDays(today, -1) });
  }

  // Recognition --------------------------------------------------------------------------------------------------
  const recognise = async (from: string, to: string, valueName: string, message: string, daysAgo: number) =>
    ws.insert('recognitions', { from_employee_id: from, to_employee_id: to, value_id: await ws.id('company_values', { name: valueName }), message: `${message} (demo data)`, created_at: ago(daysAgo * DAY) });
  await recognise(sunita, neha, 'Teamwork', 'Covered two night shifts at short notice so the Diwali order shipped on time.', 6);
  await recognise(vikram, sunita, 'Ownership', 'Rolled out the handover checklist on line 2 without being asked.', 4);
  await recognise(farhan, arjun, 'Safety', 'Stopped the press when the guard sensor failed and reported it straight away.', 1);
}

/** Phase 7 demo data: helpdesk handlers, a confidential grievance category, help articles, a few cases and announcements. */
async function seedHelpdesk(ws: Workspace, c: { tid: string; manufacturingId: string; membershipByEmail: Map<string, string> }) {
  const m = (email: string) => c.membershipByEmail.get(email)!;
  const emp = (email: string) => ws.id('employees', { work_email: email });
  const category = (name: string) => ws.id('helpdesk_categories', { name });
  const hr = m('hr.admin@demo.crew.local');

  // HR handles pay, leave and document questions; grievances are confidential and seen only by the Head of People.
  for (const name of ['Pay and payslips', 'Leave and attendance', 'Documents and letters']) {
    await ws.insert('helpdesk_category_handlers', { category_id: await category(name), membership_id: hr, position: 1 });
  }
  const grievance = await ws.insert('helpdesk_categories', {
    name: 'Grievance', description: 'Raise a concern about treatment at work in confidence. Only the named HR handlers can see it.', confidential: true, first_response_hours: 24, resolution_hours: 240,
  });
  await ws.insert('helpdesk_category_handlers', { category_id: grievance, membership_id: hr, position: 1 });

  const article = async (cat: string, title: string, body: string) =>
    ws.insert('helpdesk_articles', { category_id: await category(cat), title, body: `${body}\n\n(Demo data)`, updated_by_membership_id: hr });
  await article('Pay and payslips', 'How to read your payslip', 'Your payslip lists earnings, then deductions such as provident fund and professional tax, then reimbursements. Net pay is earnings minus deductions plus reimbursements. Open a payslip in SampCrew to see how each line was worked out.');
  await article('Leave and attendance', 'Forgot to punch out?', 'Open Attendance, choose the day and ask for a correction with the time you left. Your manager approves it and the day is worked out again.');
  await article('Documents and letters', 'Address proof letter for a bank', 'HR can issue a letter confirming your employment and address. Raise a case in Documents and letters with the bank name; letters are usually ready in two working days.');

  // Cases (numbers continue from the workspace counter, as the API numbers them).
  const neha = await emp('operator2@demo.crew.local');
  const farhan = await emp('qa.lead@demo.crew.local');
  const counters = ws.table('helpdesk_counters');
  await counters.upsert({ tenant_id: c.tid }, { tenant_id: c.tid, last_number: 0 });
  const kase = async (o: { employee: string; requester: string; cat: string; subject: string; description: string; status: string; ageHours: number; assigned: boolean; reply?: string; resolvedHoursAgo?: number }) => {
    const k = (await ws.findOne('helpdesk_categories', { name: o.cat }))!;
    const number = (await counters.updateAndGet({ tenant_id: c.tid }, { $inc: { last_number: 1 } }))!.last_number as number;
    const created = ago(o.ageHours * HOUR).getTime();
    const id = await ws.insert('helpdesk_cases', {
      number, employee_id: o.employee, requester_membership_id: o.requester, raised_by_membership_id: o.requester, category_id: k.id, confidential: k.confidential,
      subject: o.subject, description: `${o.description} (demo data)`, status: o.status, assignee_membership_id: o.assigned ? hr : null,
      first_response_due_at: new Date(created + k.first_response_hours * HOUR), resolution_due_at: new Date(created + k.resolution_hours * HOUR),
      first_responded_at: o.reply ? new Date(created + 3 * HOUR) : null, resolved_at: o.resolvedHoursAgo === undefined ? null : ago(o.resolvedHoursAgo * HOUR),
      created_at: new Date(created), updated_at: new Date(),
    });
    await ws.insert('helpdesk_events', { case_id: id, by_membership_id: o.requester, action: 'created', to_value: 'open', created_at: new Date(created) });
    if (o.reply) await ws.insert('helpdesk_messages', { case_id: id, author_membership_id: hr, body: o.reply, created_at: new Date(created + 3 * HOUR) });
  };
  await kase({ employee: neha, requester: m('operator2@demo.crew.local'), cat: 'Documents and letters', subject: 'Address proof letter for my bank', description: 'I am opening a salary account and the bank needs a letter with my address.', status: 'in_progress', ageHours: 20, assigned: true, reply: 'Happy to help. Which bank and branch should the letter be addressed to?' });
  await kase({ employee: farhan, requester: m('qa.lead@demo.crew.local'), cat: 'Pay and payslips', subject: 'Night shift allowance', description: 'Is the night shift allowance paid in the same month or the month after?', status: 'resolved', ageHours: 72, assigned: true, reply: 'It is paid with the next month\'s salary, once attendance for the month is locked.', resolvedHoursAgo: 40 });
  await kase({ employee: neha, requester: m('operator2@demo.crew.local'), cat: 'Leave and attendance', subject: 'Holiday list for next year', description: 'When will next year\'s holiday calendar be published?', status: 'open', ageHours: 30, assigned: false });

  // Announcements.
  await ws.insert('announcements', {
    title: 'Welcome to the SampCrew app', body: 'You can now punch attendance, apply for leave, see payslips and ask HR from your phone. Ask your supervisor if you need help signing in. (Demo data)',
    pinned: true, status: 'published', published_at: ago(3 * DAY), published_by_membership_id: hr, created_by_membership_id: hr,
  });
  const plantHead = m('plant.head@demo.crew.local');
  await ws.insert('announcements', {
    title: 'Safety shoes required on the shop floor', body: 'From Monday, safety shoes are required everywhere on the shop floor, including the canteen corridor. Please acknowledge that you have read this. (Demo data)',
    department_id: c.manufacturingId, requires_ack: true, status: 'published', published_at: ago(DAY), published_by_membership_id: plantHead, created_by_membership_id: plantHead,
  });
}

/**
 * Phase 8 demo data: AI features switched on for the workspace (they still do nothing until the installation
 * sets an AI provider) and one tested, active workflow. Attrition scores are calculated by the daily HR job,
 * which runs shortly after the API starts.
 */
async function seedAiAutomation(ws: Workspace, c: { membershipByEmail: Map<string, string> }) {
  const hr = c.membershipByEmail.get('hr.admin@demo.crew.local')!;
  await ws.insert('ai_settings', { features: { assistant: true, helpdesk_draft: true, workflow_draft: true }, prompt_log_days: 90, updated_by_membership_id: hr });
  const definition = {
    trigger: { event: 'leave.requested' },
    steps: [
      { id: 'condition_1', type: 'condition', field: 'leave.type', op: 'eq', value: 'Sick leave' },
      { id: 'condition_2', type: 'condition', field: 'leave.days', op: 'gte', value: 3 },
      { id: 'notify_1', type: 'notify', to: 'role', role: 'hr_admin', title: '{{employee.name}} asked for {{leave.days}} days of sick leave', body: 'Consider checking in with {{employee.name}} ({{employee.department}}) to see whether they need any support.', email: false },
    ],
  };
  const w = await ws.insert('workflows', {
    name: 'Check in after long sick leave', description: 'Lets HR know when someone asks for three or more days of sick leave. (Demo data)', trigger_event: 'leave.requested', owner_membership_id: hr,
  });
  const v = await ws.insert('workflow_versions', { workflow_id: w, version: 1, definition, created_by_membership_id: hr, tested_at: new Date() });
  // The test run that let version 1 be activated.
  const run = await ws.insert('workflow_runs', {
    workflow_id: w, version_id: v, mode: 'test', context: { 'employee.name': 'Sample Employee', 'employee.department': 'Assembly Line', 'leave.type': 'Sick leave', 'leave.days': 4 },
    status: 'succeeded', step_index: 3, outcome: 'Reached the end', started_by_membership_id: hr, finished_at: new Date(),
  });
  const trace = [
    ['condition_1', 'condition', 'Met: leave.type is "Sick leave"'],
    ['condition_2', 'condition', 'Met: leave.days is "4"'],
    ['notify_1', 'notify', 'Would notify 2 people with the hr_admin role: "Sample Employee asked for 4 days of sick leave"'],
  ];
  await ws.insertMany('workflow_step_runs', trace.map(([id, type, detail], i) => ({ run_id: run, step_index: i, step_id: id, type, status: type === 'condition' ? 'succeeded' : 'simulated', detail })));
  await ws.set('workflows', { id: w }, { status: 'active', active_version_id: v });
}
