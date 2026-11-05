import type { Pool } from 'pg';
import { DEFAULT_IN_STATUTORY, leaveMath, payrollEngine } from '@crew/contracts';
import type { PoolClient } from 'pg';
import { provisionTenant } from '../src/provision';

/**
 * Demo tenant for local development and sales demos. The tenant is flagged is_demo = true and every
 * screen shows a "Demo data" banner. All people and companies here are fictional.
 */
export async function seedDemoTenant(pool: Pool, passwordHash: string): Promise<boolean> {
  const exists = await pool.query(`select 1 from tenants where slug = 'demo-northwind'`);
  if (exists.rowCount) return false;

  const client = await pool.connect();
  try {
    await client.query('begin');
    const t = await provisionTenant(client, {
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
    const q = async <T = { id: string }>(sql: string, params: unknown[]) => (await client.query(sql, params)).rows[0] as T;

    const uk = await q(
      `insert into legal_entities (tenant_id, name, legal_name, country_code, currency, timezone, fiscal_year_start_month)
       values ($1, 'Northwind UK', 'Northwind Manufacturing UK Ltd (Demo)', 'GB', 'GBP', 'Europe/London', 4) returning id`,
      [tid],
    );
    const ops = await q(`insert into business_units (tenant_id, name, code) values ($1, 'Operations', 'OPS') returning id`, [tid]);
    const corp = await q(`insert into business_units (tenant_id, name, code) values ($1, 'Corporate', 'CORP') returning id`, [tid]);

    const pune = await q(
      `insert into locations (tenant_id, legal_entity_id, name, code, kind, timezone, city, region, country_code, latitude, longitude, geofence_radius_m)
       values ($1, $2, 'Pune Plant', 'PNQ-1', 'factory', 'Asia/Kolkata', 'Pune', 'Maharashtra', 'IN', 18.5204, 73.8567, 250) returning id`,
      [tid, t.legalEntityId],
    );
    const blr = await q(
      `insert into locations (tenant_id, legal_entity_id, name, code, kind, timezone, city, region, country_code, latitude, longitude, geofence_radius_m)
       values ($1, $2, 'Bengaluru HQ', 'BLR-HQ', 'office', 'Asia/Kolkata', 'Bengaluru', 'Karnataka', 'IN', 12.9716, 77.5946, 150) returning id`,
      [tid, t.legalEntityId],
    );
    const lon = await q(
      `insert into locations (tenant_id, legal_entity_id, name, code, kind, timezone, city, country_code)
       values ($1, $2, 'London Office', 'LON-1', 'office', 'Europe/London', 'London', 'GB') returning id`,
      [tid, uk.id],
    );

    const dept = (name: string, code: string, parent: string | null, entity: string, bu: string) =>
      q(`insert into departments (tenant_id, name, code, parent_id, legal_entity_id, business_unit_id) values ($1, $2, $3, $4, $5, $6) returning id`, [tid, name, code, parent, entity, bu]);
    const manufacturing = await dept('Manufacturing', 'MFG', null, t.legalEntityId, ops.id);
    const assembly = await dept('Assembly Line', 'MFG-ASM', manufacturing.id, t.legalEntityId, ops.id);
    const quality = await dept('Quality Assurance', 'MFG-QA', manufacturing.id, t.legalEntityId, ops.id);
    const hr = await dept('People & Culture', 'HR', null, t.legalEntityId, corp.id);
    const finance = await dept('Finance', 'FIN', null, t.legalEntityId, corp.id);
    const talent = await dept('Talent Acquisition', 'HR-TA', hr.id, t.legalEntityId, corp.id);
    const sales = await dept('Sales UK', 'SALES-UK', null, uk.id, corp.id);

    const roleId = async (key: string) => (await q(`select id from roles where tenant_id = $1 and key = $2`, [tid, key])).id;

    const people: { email: string; name: string; title: string; dept: string; loc: string; entity: string; manager?: string; roles: string[] }[] = [
      { email: 'hr.admin@demo.crew.local', name: 'Priya Nair', title: 'Head of People', dept: hr.id, loc: blr.id, entity: t.legalEntityId, roles: ['hr_admin'] },
      { email: 'recruiter@demo.crew.local', name: 'Kabir Shah', title: 'Senior Recruiter', dept: talent.id, loc: blr.id, entity: t.legalEntityId, manager: 'hr.admin@demo.crew.local', roles: ['recruiter'] },
      { email: 'payroll@demo.crew.local', name: 'Meera Iyer', title: 'Payroll Lead', dept: finance.id, loc: blr.id, entity: t.legalEntityId, roles: ['payroll_admin'] },
      { email: 'finance@demo.crew.local', name: 'Rohan Gupta', title: 'Finance Manager', dept: finance.id, loc: blr.id, entity: t.legalEntityId, roles: ['finance_manager'] },
      { email: 'plant.head@demo.crew.local', name: 'Vikram Rao', title: 'Plant Head', dept: manufacturing.id, loc: pune.id, entity: t.legalEntityId, roles: ['department_manager', 'hiring_manager'] },
      { email: 'supervisor@demo.crew.local', name: 'Sunita Patil', title: 'Assembly Supervisor', dept: assembly.id, loc: pune.id, entity: t.legalEntityId, manager: 'plant.head@demo.crew.local', roles: ['department_manager'] },
      { email: 'operator1@demo.crew.local', name: 'Arjun Kulkarni', title: 'Machine Operator', dept: assembly.id, loc: pune.id, entity: t.legalEntityId, manager: 'supervisor@demo.crew.local', roles: [] },
      { email: 'operator2@demo.crew.local', name: 'Neha Deshmukh', title: 'Machine Operator', dept: assembly.id, loc: pune.id, entity: t.legalEntityId, manager: 'supervisor@demo.crew.local', roles: [] },
      { email: 'qa.lead@demo.crew.local', name: 'Farhan Qureshi', title: 'QA Lead', dept: quality.id, loc: pune.id, entity: t.legalEntityId, manager: 'plant.head@demo.crew.local', roles: [] },
      { email: 'attendance@demo.crew.local', name: 'Lakshmi Menon', title: 'Time Office Executive', dept: hr.id, loc: pune.id, entity: t.legalEntityId, manager: 'hr.admin@demo.crew.local', roles: ['attendance_admin'] },
      { email: 'uk.hr@demo.crew.local', name: 'Emma Clarke', title: 'HR Manager UK', dept: sales.id, loc: lon.id, entity: uk.id, roles: ['hr_manager'] },
      { email: 'uk.sales@demo.crew.local', name: 'Oliver Bennett', title: 'Account Executive', dept: sales.id, loc: lon.id, entity: uk.id, manager: 'uk.hr@demo.crew.local', roles: [] },
      { email: 'auditor@demo.crew.local', name: 'Ishaan Verma', title: 'Internal Auditor', dept: finance.id, loc: blr.id, entity: t.legalEntityId, roles: ['auditor'] },
    ];

    const membershipByEmail = new Map<string, string>();
    membershipByEmail.set('owner@demo.crew.local', t.ownerMembershipId);
    await client.query(`update memberships set department_id = $2, location_id = $3, title = 'Managing Director' where id = $1`, [t.ownerMembershipId, hr.id, blr.id]);
    for (const p of people) {
      const user = await q(`insert into users (email, full_name, password_hash, email_verified_at) values ($1, $2, $3, now()) returning id`, [p.email, p.name, passwordHash]);
      const m = await q(
        `insert into memberships (tenant_id, user_id, status, legal_entity_id, department_id, location_id, manager_membership_id, title, joined_at)
         values ($1, $2, 'active', $3, $4, $5, $6, $7, now()) returning id`,
        [tid, user.id, p.entity, p.dept, p.loc, p.manager ? membershipByEmail.get(p.manager) : null, p.title],
      );
      membershipByEmail.set(p.email, m.id);
      for (const r of ['employee', ...p.roles]) {
        const constraints = r === 'hr_manager' ? { legalEntityIds: [uk.id] } : {};
        await client.query(`insert into role_assignments (tenant_id, membership_id, role_id, constraints) values ($1, $2, $3, $4)`, [tid, m.id, await roleId(r), constraints]);
      }
    }
    await client.query(`update departments set head_membership_id = $2 where id = $1`, [manufacturing.id, membershipByEmail.get('plant.head@demo.crew.local')]);
    await client.query(`update departments set head_membership_id = $2 where id = $1`, [hr.id, membershipByEmail.get('hr.admin@demo.crew.local')]);
    await client.query(`update users set email_verified_at = now() where email = 'owner@demo.crew.local'`);

    await seedCoreHr(client, {
      tid, indiaId: t.legalEntityId, ukId: uk.id, puneId: pune.id, blrId: blr.id, lonId: lon.id, assemblyId: assembly.id, qualityId: quality.id,
      ownerTitle: 'Managing Director', people: [{ email: 'owner@demo.crew.local', name: 'Aarav Mehta', title: 'Managing Director', dept: hr.id, loc: blr.id, entity: t.legalEntityId }, ...people],
      membershipByEmail,
    });
    await seedAttendance(client, { tid, puneId: pune.id, membershipByEmail });
    await seedRecruitment(client, { tid, indiaId: t.legalEntityId, puneId: pune.id, manufacturingId: manufacturing.id, membershipByEmail });
    await seedPayroll(client, { tid, indiaId: t.legalEntityId, membershipByEmail });
    await seedTalent(client, { tid, assemblyId: assembly.id, manufacturingId: manufacturing.id, membershipByEmail });

    await client.query(
      `insert into audit_events (tenant_id, actor_type, actor_label, action, resource_type, resource_id, metadata)
       values ($1, 'system', 'demo seed', 'tenant.created', 'tenant', $2, '{"demo": true}')`,
      [tid, tid],
    );
    await client.query('commit');
    return true;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

interface DemoPerson { email: string; name: string; title: string; dept: string; loc: string; entity: string; manager?: string }

/** Phase 2 demo data: employee records, designations, leave setup, holidays, onboarding and a few requests. */
async function seedCoreHr(
  client: PoolClient,
  c: { tid: string; indiaId: string; ukId: string; puneId: string; blrId: string; lonId: string; assemblyId: string; qualityId: string; ownerTitle: string; people: DemoPerson[]; membershipByEmail: Map<string, string> },
) {
  const { tid } = c;
  const q = async <T = { id: string }>(sql: string, params: unknown[]) => (await client.query(sql, params)).rows[0] as T;
  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));

  // Designations from the job titles in use.
  const designation = new Map<string, string>();
  const levels: Record<string, number> = { 'Managing Director': 1, 'Head of People': 2, 'Plant Head': 2, 'Finance Manager': 3, 'HR Manager UK': 3 };
  for (const title of [...new Set([...c.people.map((p) => p.title), 'Helper', 'Quality Inspector'])]) {
    designation.set(title, (await q(`insert into designations (tenant_id, name, level) values ($1, $2, $3) returning id`, [tid, title, levels[title] ?? 5])).id);
  }

  // Employee records for every demo member, plus shop-floor staff without CREW logins.
  const joining = ['2019-04-01', '2020-06-15', '2021-01-11', '2021-09-01', '2018-11-05', '2020-02-03', '2022-07-18', '2023-03-06', '2021-05-24', '2022-10-10', '2022-01-17', `${year}-08-03`, '2023-11-13', '2024-02-19'];
  const employeeByEmail = new Map<string, string>();
  let n = 1;
  const addEmployee = async (p: { name: string; email?: string; title: string; dept: string; loc: string; entity: string; managerId: string | null; joined: string; membershipId?: string | null; probationEnd?: string | null }) => {
    const [first, ...rest] = p.name.split(' ');
    const code = `NW${String(n++).padStart(4, '0')}`;
    const onProbation = !!p.probationEnd && p.probationEnd >= today;
    const e = await q(
      `insert into employees (tenant_id, employee_code, first_name, last_name, work_email, date_of_joining, probation_end_date, confirmation_date, status,
                              current_legal_entity_id, current_department_id, current_location_id, current_designation_id, current_manager_employee_id, membership_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
      [tid, code, first, rest.join(' '), p.email ?? null, p.joined, p.probationEnd ?? null, onProbation ? null : p.probationEnd ?? p.joined, onProbation ? 'probation' : 'active',
        p.entity, p.dept, p.loc, designation.get(p.title), p.managerId, p.membershipId ?? null],
    );
    await client.query(
      `insert into employment_records (tenant_id, employee_id, effective_from, legal_entity_id, department_id, location_id, designation_id, manager_employee_id, employment_type, change_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'full_time', 'hire')`,
      [tid, e.id, p.joined, p.entity, p.dept, p.loc, designation.get(p.title), p.managerId],
    );
    await client.query(`insert into lifecycle_events (tenant_id, employee_id, kind, effective_on, details) values ($1, $2, 'hired', $3, '{"demo": true}')`, [tid, e.id, p.joined]);
    return e.id;
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
  for (const [name, title, dept] of [['Ganesh Pawar', 'Helper', c.assemblyId], ['Rekha Jadhav', 'Machine Operator', c.assemblyId], ['Sameer Khan', 'Quality Inspector', c.qualityId]] as const) {
    await addEmployee({ name, title, dept, loc: c.puneId, entity: c.indiaId, managerId: dept === c.qualityId ? employeeByEmail.get('qa.lead@demo.crew.local')! : supervisor, joined: '2023-06-01' });
  }
  await client.query(`insert into employee_number_series (tenant_id, prefix, padding, next_value) values ($1, 'NW', 4, $2)`, [tid, n]);
  // Memberships follow employee placement through a trigger; this reconciles managers set before their reports existed.
  await client.query(`select employees_apply_current(current_date)`);
  await client.query(`update employees set membership_id = membership_id where tenant_id = $1 and membership_id is not null`, [tid]);

  // Leave types and policies. These are demo policies, not a statement of any country's statutory minimum.
  const type = async (code: string, name: string, paid: boolean, color: string, halfDay = true) =>
    (await q(`insert into leave_types (tenant_id, code, name, paid, color, allow_half_day, description) values ($1, $2, $3, $4, $5, $6, 'Demo leave type') returning id`, [tid, code, name, paid, color, halfDay])).id;
  const cl = await type('CL', 'Casual leave', true, '#2563eb');
  const sl = await type('SL', 'Sick leave', true, '#dc2626');
  const el = await type('EL', 'Earned leave', true, '#059669', false);
  const lwp = await type('LWP', 'Leave without pay', false, '#6b7280');
  const al = await type('AL', 'Annual leave', true, '#7c3aed');
  const policy = (typeId: string, entity: string, method: string, entitlement: string, carry: string, extra: { notice?: number; maxRun?: string; probation?: boolean } = {}) =>
    client.query(
      `insert into leave_policies (tenant_id, leave_type_id, legal_entity_id, accrual_method, annual_entitlement, carry_forward_max, min_notice_days, max_consecutive_days, available_during_probation)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tid, typeId, entity, method, entitlement, carry, extra.notice ?? 0, extra.maxRun ?? null, extra.probation ?? true],
    );
  await policy(cl, c.indiaId, 'annual_upfront', '8', '0', { maxRun: '3' });
  await policy(sl, c.indiaId, 'annual_upfront', '8', '0');
  await policy(el, c.indiaId, 'monthly', '18', '30', { notice: 7, probation: false });
  await policy(lwp, c.indiaId, 'none', '0', '0');
  await policy(al, c.ukId, 'monthly', '25', '5', { notice: 3 });
  await policy(lwp, c.ukId, 'none', '0', '0');

  // Holiday calendars. Only fixed-date national holidays are listed for India; add regional ones per location.
  const india = (await q(`insert into holiday_calendars (tenant_id, name, legal_entity_id, weekly_offs) values ($1, 'India offices (demo data)', $2, '{0,6}') returning id`, [tid, c.indiaId])).id;
  const plant = (await q(`insert into holiday_calendars (tenant_id, name, location_id, weekly_offs) values ($1, 'Pune Plant, Sundays off (demo data)', $2, '{0}') returning id`, [tid, c.puneId])).id;
  const ukCal = (await q(`insert into holiday_calendars (tenant_id, name, legal_entity_id, weekly_offs) values ($1, 'England and Wales (demo data)', $2, '{0,6}') returning id`, [tid, c.ukId])).id;
  for (const cal of [india, plant]) {
    for (const y of [year, year + 1]) {
      for (const [md, name] of [['01-26', 'Republic Day'], ['08-15', 'Independence Day'], ['10-02', 'Gandhi Jayanti']]) {
        await client.query(`insert into holidays (tenant_id, calendar_id, holiday_date, name) values ($1, $2, $3, $4)`, [tid, cal, `${y}-${md}`, name]);
      }
    }
  }
  if (year === 2026) {
    for (const [d, name] of [['2026-01-01', "New Year's Day"], ['2026-04-03', 'Good Friday'], ['2026-04-06', 'Easter Monday'], ['2026-05-04', 'Early May bank holiday'],
      ['2026-05-25', 'Spring bank holiday'], ['2026-08-31', 'Summer bank holiday'], ['2026-12-25', 'Christmas Day'], ['2026-12-28', 'Boxing Day (substitute day)']]) {
      await client.query(`insert into holidays (tenant_id, calendar_id, holiday_date, name) values ($1, $2, $3, $4)`, [tid, ukCal, d, name]);
    }
  }

  // Accruals due so far this year, using the same arithmetic as the API.
  const emps = (await client.query<{ id: string; date_of_joining: string; legal_entity_id: string }>(
    `select id, to_char(date_of_joining, 'YYYY-MM-DD') as date_of_joining, current_legal_entity_id as legal_entity_id from employees where tenant_id = $1`, [tid],
  )).rows;
  const pols = (await client.query<{ leave_type_id: string; legal_entity_id: string; accrual_method: 'annual_upfront' | 'monthly' | 'none'; annual_entitlement: string; rounding: 'none' | 'half_day' }>(
    `select leave_type_id, legal_entity_id, accrual_method, annual_entitlement::text, rounding from leave_policies where tenant_id = $1 and active`, [tid],
  )).rows;
  for (const e of emps) {
    for (const p of pols.filter((x) => x.legal_entity_id === e.legal_entity_id)) {
      for (const cr of leaveMath.accrualsDue({ accrualMethod: p.accrual_method, annualEntitlement: leaveMath.toH(p.annual_entitlement), rounding: p.rounding }, { dateOfJoining: e.date_of_joining, lastWorkingDay: null }, today)) {
        await client.query(
          `insert into leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, kind, quantity, effective_on, accrual_key, note) values ($1, $2, $3, $4, 'accrual', $5, $6, $7, $8)`,
          [tid, e.id, p.leave_type_id, year, leaveMath.fromH(cr.quantity), cr.effectiveOn, cr.key, `Accrual ${cr.key.slice(1)}`],
        );
      }
    }
  }

  // A pending request waiting for the assembly supervisor, and an approved one already taken.
  const nextMonday = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7) + 7);
    return d.toISOString().slice(0, 10);
  })();
  const arjun = employeeByEmail.get('operator1@demo.crew.local')!;
  const arjunM = c.membershipByEmail.get('operator1@demo.crew.local')!;
  const supM = c.membershipByEmail.get('supervisor@demo.crew.local')!;
  if (nextMonday.slice(0, 4) === String(year)) {
    const lr = await q(
      `insert into leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, days, reason, requested_by_membership_id) values ($1, $2, $3, $4, $4, 1, 'Family function', $5) returning id`,
      [tid, arjun, cl, nextMonday, arjunM],
    );
    const ar = await q(
      `insert into approval_requests (tenant_id, resource_type, resource_id, subject_employee_id, requested_by_membership_id, summary) values ($1, 'leave_request', $2, $3, $4, $5) returning id`,
      [tid, lr.id, arjun, arjunM, `Arjun Kulkarni: Casual leave, ${nextMonday} (1.00 days). "Family function"`],
    );
    await client.query(`insert into approval_steps (tenant_id, request_id, seq, kind, approver_membership_id, status) values ($1, $2, 1, 'manager', $3, 'pending')`, [tid, ar.id, supM]);
    await client.query(`update leave_requests set approval_request_id = $2 where id = $1`, [lr.id, ar.id]);
    await client.query(`insert into notifications (tenant_id, membership_id, kind, title, body, link) values ($1, $2, 'approval.requested', 'Leave request waiting for your approval', $3, '/approvals')`,
      [tid, supM, `Arjun Kulkarni: Casual leave, ${nextMonday}`]);
  }
  const neha = employeeByEmail.get('operator2@demo.crew.local')!;
  const day = `${year}-03-10`;
  if (day < today) {
    const lr = await q(
      `insert into leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, days, reason, status, decided_at, requested_by_membership_id)
       values ($1, $2, $3, $4, $4, 1, 'Fever', 'approved', now(), $5) returning id`,
      [tid, neha, sl, day, c.membershipByEmail.get('operator2@demo.crew.local')],
    );
    await client.query(
      `insert into leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, kind, quantity, effective_on, leave_request_id) values ($1, $2, $3, $4, 'taken', -1, $5, $6)`,
      [tid, neha, sl, year, day, lr.id],
    );
  }
}

/**
 * Phase 3 demo data: a night shift, a Pune policy, about a week of punches for the plant, and a simulated device
 * whose punches arrive through enrolment numbers. Attendance days are not inserted: the API derives them from these
 * raw punches on first view and in the hourly job, exactly as it does for real data.
 */
async function seedAttendance(client: PoolClient, c: { tid: string; puneId: string; membershipByEmail: Map<string, string> }) {
  const { tid } = c;
  const q = async <T = { id: string }>(sql: string, params: unknown[]) => (await client.query(sql, params)).rows[0] as T;
  const gen = await q(`select id from shift_templates where tenant_id = $1 and code = 'GEN'`, [tid]);
  await client.query(
    `insert into shift_templates (tenant_id, code, name, start_time, end_time, break_minutes, overtime_enabled, overtime_min_minutes, color)
     values ($1, 'NIGHT', 'Night shift (demo data)', '22:00', '06:00', 30, true, 30, '#7c3aed')`,
    [tid],
  );
  await client.query(
    `insert into attendance_policies (tenant_id, location_id, geofence_mode, default_shift_id, correction_window_days) values ($1, $2, 'warn', $3, 30)`,
    [tid, c.puneId, gen.id],
  );

  const emp = async (where: string, value: string) => (await q(`select id from employees where tenant_id = $1 and ${where} = $2`, [tid, value])).id;
  const web = {
    arjun: await emp('work_email', 'operator1@demo.crew.local'),
    neha: await emp('work_email', 'operator2@demo.crew.local'),
    sunita: await emp('work_email', 'supervisor@demo.crew.local'),
  };
  const ganesh = await emp('first_name', 'Ganesh');
  const rekha = await emp('first_name', 'Rekha');

  const device = await q(
    `insert into attendance_devices (tenant_id, name, vendor, model, serial_number, location_id, time_zone, simulated, last_seen_at)
     values ($1, 'Pune gate (simulated demo device)', 'zkteco', 'Simulated', $2, $3, 'Asia/Kolkata', true, now()) returning id`,
    [tid, `DEMO${tid.replace(/-/g, '').slice(0, 10).toUpperCase()}`, c.puneId],
  );
  await client.query(`insert into device_user_mappings (tenant_id, device_id, device_user_id, employee_id) values ($1, null, '101', $2), ($1, null, '102', $3)`, [tid, ganesh, rekha]);

  // The last 26 days before today that the Pune calendar treats as working days (Sundays and holidays skipped).
  const holidays = new Set((await client.query<{ d: string }>(`select to_char(h.holiday_date, 'YYYY-MM-DD') as d from holidays h join holiday_calendars hc on hc.id = h.calendar_id where hc.tenant_id = $1 and hc.location_id = $2`, [tid, c.puneId])).rows.map((r) => r.d));
  const days: string[] = [];
  const cursor = new Date(Date.now() + 5.5 * 3_600_000); // today in India
  while (days.length < 26) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const d = cursor.toISOString().slice(0, 10);
    if (cursor.getUTCDay() !== 0 && !holidays.has(d)) days.push(d);
  }
  const at = (d: string, hm: string) => `${d}T${hm}:00+05:30`;
  const pune = { latitude: 18.5205, longitude: 73.8566, accuracy: 15, distance: 15 };
  let accepted = 0;
  for (const [i, d] of days.entries()) {
    for (const [key, id] of Object.entries(web)) {
      const late = key === 'neha' && i % 3 === 1;
      const missingOut = key === 'arjun' && i === 2; // a forgotten punch-out, to try a correction on
      const punches: [string, 'in' | 'out'][] = [[late ? '09:34' : `08:5${i % 7}`, 'in']];
      if (!missingOut) punches.push([key === 'sunita' && i === 0 ? '19:20' : `18:0${(i * 3) % 10}`, 'out']);
      for (const [hm, direction] of punches) {
        await client.query(
          `insert into attendance_events (tenant_id, employee_id, source, source_event_id, captured_at, direction, latitude, longitude, accuracy_m, geofence_result, distance_m, note)
           values ($1, $2, 'web', $3, $4, $5, $6, $7, $8, 'inside', $9, 'Demo data')`,
          [tid, id, `demo-${key}-${d}-${direction}`, at(d, hm), direction, pune.latitude, pune.longitude, pune.accuracy, pune.distance],
        );
      }
    }
    // Shop floor staff punch on the device. 103 is not mapped yet, so it shows up as an enrolment number to map.
    for (const [pin, inAt, outAt] of [['101', '08:46', '17:58'], ['102', `08:5${i % 9}`, '18:04'], ['103', '08:55', '18:01']] as const) {
      for (const [hm, direction, status] of [[inAt, 'in', 0], [outAt, 'out', 1]] as const) {
        await client.query(
          `insert into attendance_events (tenant_id, device_id, device_user_id, source, source_event_id, captured_at, device_local_time, direction, verify_method, raw)
           values ($1, $2, $3, 'device', $4, $5, $6, $7, 'fingerprint', $8)`,
          [tid, device.id, pin, `demo-${device.id}-${pin}-${d}-${direction}`, at(d, hm), `${d} ${hm}:00`, direction, { demo: true, status }],
        );
        accepted++;
      }
    }
  }
  await client.query(
    `update attendance_devices set records_accepted = $2, last_punch_at = $3 where id = $1`,
    [device.id, accepted, at(days[0]!, '18:04')],
  );
  await client.query(
    `insert into device_ingest_log (tenant_id, device_id, kind, records, accepted, duplicates, rejected, detail) values ($1, $2, 'attlog', $3, $3, 0, 0, 'Demo data: a week of punches')`,
    [tid, device.id, accepted],
  );
}

/**
 * Phase 4 demo data: a career site, an open job with a published posting and three candidates at different
 * stages (one with a past interview awaiting a scorecard), and a draft requisition. Every candidate is tagged
 * "demo" and uses a .local address, so no real person is contacted.
 */
async function seedRecruitment(client: PoolClient, c: { tid: string; indiaId: string; puneId: string; manufacturingId: string; membershipByEmail: Map<string, string> }) {
  const { tid } = c;
  const q = async <T = { id: string }>(sql: string, params: unknown[]) => (await client.query(sql, params)).rows[0] as T;
  const m = (email: string) => c.membershipByEmail.get(email)!;
  const recruiter = m('recruiter@demo.crew.local');
  const plantHead = m('plant.head@demo.crew.local');
  const qaLead = m('qa.lead@demo.crew.local');

  await client.query(
    `insert into career_sites (tenant_id, enabled, slug, headline, intro, privacy_notice, retention_days) values ($1, true, 'northwind-demo', $2, $3, $4, 365)`,
    [
      tid,
      'Build what moves India (demo career site)',
      'This is a demo career site for the Northwind sample workspace. Applications here are stored in the demo workspace only.',
      'Northwind (a demo organisation) uses the details and CV you send only to consider you for this job and similar roles. Our hiring team and the interviewers for the role can see them. We keep them for one year after your last contact with us, then delete them. You can ask us to delete them sooner at any time.',
    ],
  );
  await client.query(`insert into requisition_number_series (tenant_id, next_value) values ($1, 3)`, [tid]);
  const stage = async (kind: string) => (await q(`select id from recruitment_stages where tenant_id = $1 and kind = $2 order by position limit 1`, [tid, kind])).id;

  const open = await q(
    `insert into job_requisitions (tenant_id, code, title, legal_entity_id, department_id, location_id, hiring_manager_membership_id, employment_type, work_mode, headcount,
                                   reason, salary_min, salary_max, currency, justification, description, scorecard, status, created_by_membership_id, approved_at, opened_at)
     values ($1, 'REQ-0001', 'Quality Engineer', $2, $3, $4, $5, 'full_time', 'onsite', 2, 'new_role', 600000, 900000, 'INR',
             'Demo data: second shift line needs in-process inspection cover.', 'Own in-process quality checks on the assembly line and lead root-cause analysis for defects.',
             $6, 'open', $7, now() - interval '20 days', now() - interval '18 days') returning id`,
    [tid, c.indiaId, c.manufacturingId, c.puneId, plantHead, ['Quality systems', 'Problem solving', 'Communication', 'Shop-floor safety'], recruiter],
  );
  await client.query(
    `insert into job_postings (tenant_id, requisition_id, public_title, slug, summary, description, location_text, show_salary, published_at)
     values ($1, $2, 'Quality Engineer (demo)', 'quality-engineer', 'Keep our Pune assembly line right first time',
             $3, 'Pune Plant', true, now() - interval '17 days')`,
    [tid, open.id, 'This is a demo job posting.\n\nYou will run in-process inspections on our assembly line, lead root-cause analysis when defects appear, and work with supervisors to keep quality high on every shift.\n\nYou have 2 or more years in manufacturing quality, know 8D or a similar method, and communicate clearly with operators and engineers.'],
  );
  await client.query(
    `insert into job_requisitions (tenant_id, code, title, legal_entity_id, department_id, location_id, hiring_manager_membership_id, employment_type, work_mode, headcount,
                                   reason, salary_min, salary_max, currency, justification, scorecard, status, created_by_membership_id)
     values ($1, 'REQ-0002', 'CNC Machine Operator', $2, $3, $4, $5, 'full_time', 'onsite', 3, 'new_role', 300000, 420000, 'INR',
             'Demo data: new CNC cell starting next quarter.', $6, 'draft', $5)`,
    [tid, c.indiaId, c.manufacturingId, c.puneId, plantHead, ['Machine skills', 'Safety', 'Reliability']],
  );

  const candidates: { first: string; last: string; email: string; title: string; company: string; source: string; basis: string; kind: string; daysAgo: number; cover?: string }[] = [
    { first: 'Ananya', last: 'Joshi', email: 'ananya.joshi@candidates.demo.crew.local', title: 'Quality Inspector', company: 'Demo Auto Parts', source: 'career_site', basis: 'candidate_consent', kind: 'interview', daysAgo: 12, cover: 'I have led 8D investigations on a press line for three years.' },
    { first: 'Rahul', last: 'Verma', email: 'rahul.verma@candidates.demo.crew.local', title: 'QA Engineer', company: 'Demo Castings', source: 'referral', basis: 'recruiter_confirmed', kind: 'screen', daysAgo: 6 },
    { first: 'Sneha', last: 'Kulkarni', email: 'sneha.kulkarni@candidates.demo.crew.local', title: 'Graduate Engineer Trainee', company: 'Demo Forgings', source: 'career_site', basis: 'candidate_consent', kind: 'new', daysAgo: 2, cover: 'Looking to grow into a quality role on the shop floor.' },
  ];
  const applied = await stage('new');
  for (const cd of candidates) {
    const cand = await q(
      `insert into candidates (tenant_id, first_name, last_name, email, current_title, current_company, location_text, source, source_detail, tags, consent_basis, privacy_notice_version, consent_at, last_activity_at, created_at)
       values ($1, $2, $3, $4, $5, $6, 'Pune', $7, 'Demo data', '{demo}', $8, case when $8 = 'candidate_consent' then 1 end, now() - make_interval(days => $9), now() - make_interval(days => $9), now() - make_interval(days => $9)) returning id`,
      [tid, cd.first, cd.last, cd.email, cd.title, cd.company, cd.source, cd.basis, cd.daysAgo],
    );
    const to = await stage(cd.kind);
    const app = await q(
      `insert into applications (tenant_id, candidate_id, requisition_id, stage_id, source, cover_note, created_by_membership_id, applied_at, stage_entered_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(days => $8), now() - make_interval(days => greatest($8 - 2, 0))) returning id`,
      [tid, cand.id, open.id, to, cd.source, cd.cover ?? null, cd.source === 'career_site' ? null : recruiter, cd.daysAgo],
    );
    await client.query(`insert into application_events (tenant_id, application_id, kind, to_stage_id, detail, created_at) values ($1, $2, 'applied', $3, $4, now() - make_interval(days => $5))`, [tid, app.id, applied, { source: cd.source }, cd.daysAgo]);
    if (to !== applied) {
      await client.query(
        `insert into application_events (tenant_id, application_id, kind, from_stage_id, to_stage_id, actor_membership_id, created_at) values ($1, $2, 'stage_changed', $3, $4, $5, now() - make_interval(days => greatest($6 - 2, 0)))`,
        [tid, app.id, applied, to, recruiter, cd.daysAgo],
      );
    }
    if (cd.kind === 'interview') {
      // Yesterday's interview: the QA lead's scorecard is still due, so the demo can show the scorecard flow.
      const iv = await q(
        `insert into interviews (tenant_id, application_id, title, starts_at, duration_minutes, mode, meeting_url, created_by_membership_id)
         values ($1, $2, 'Technical interview', date_trunc('hour', now()) - interval '1 day', 60, 'video', 'https://meet.example.com/demo-quality-engineer', $3) returning id`,
        [tid, app.id, recruiter],
      );
      await client.query(`insert into interview_panelists (tenant_id, interview_id, membership_id) values ($1, $2, $3), ($1, $2, $4)`, [tid, iv.id, qaLead, plantHead]);
      await client.query(`insert into application_events (tenant_id, application_id, kind, detail, actor_membership_id, created_at) values ($1, $2, 'interview_scheduled', $3, $4, now() - interval '3 days')`, [tid, app.id, { interviewId: iv.id, title: 'Technical interview' }, recruiter]);
    }
  }
}

/**
 * Phase 5 demo data: statutory settings for the India entity (the CREW starting values, saved as demo data), a
 * salary for everyone employed by it, and two expense claims (one approved and waiting for payroll, one waiting
 * for the supervisor). No payroll run is created, so the first run can be tried end to end. The UK entity has no
 * payroll: CREW's statutory rules in this release cover India only.
 */
async function seedPayroll(client: PoolClient, c: { tid: string; indiaId: string; membershipByEmail: Map<string, string> }) {
  const { tid } = c;
  const q = async <T = { id: string }>(sql: string, params: unknown[]) => (await client.query(sql, params)).rows[0] as T;
  const today = new Date().toISOString().slice(0, 10);
  const fy = payrollEngine.fyStart(today);
  await client.query(
    `insert into statutory_settings (tenant_id, legal_entity_id, effective_from, lop_source, settings) values ($1, $2, $3, 'attendance_and_leave', $4)`,
    [tid, c.indiaId, fy, JSON.stringify(DEFAULT_IN_STATUTORY)],
  );
  const structure = await q(`select id from salary_structures where tenant_id = $1 and name = 'Standard'`, [tid]);
  const lines = (await client.query<{ component_id: string; code: string; name: string; kind: 'earning' | 'deduction'; calc: payrollEngine.CalcMethod; value: string; is_basic: boolean }>(
    `select c.id as component_id, c.code, c.name, c.kind, l.calc, l.value::text, c.is_basic from salary_structure_lines l join pay_components c on c.id = l.component_id
      where l.structure_id = $1 order by l.position`,
    [structure.id],
  )).rows;
  // Annual CTC by work email or first name (demo figures).
  const ctc: Record<string, string> = {
    'owner@demo.crew.local': '4800000', 'hr.admin@demo.crew.local': '2400000', 'recruiter@demo.crew.local': '1200000', 'payroll@demo.crew.local': '1500000',
    'finance@demo.crew.local': '1800000', 'plant.head@demo.crew.local': '3000000', 'supervisor@demo.crew.local': '720000', 'operator1@demo.crew.local': '300000',
    'operator2@demo.crew.local': '280000', 'qa.lead@demo.crew.local': '900000', 'attendance@demo.crew.local': '420000', 'auditor@demo.crew.local': '1400000',
    Ganesh: '216000', Rekha: '264000', Sameer: '240000',
  };
  const employees = (await client.query<{ id: string; work_email: string | null; first_name: string; date_of_joining: string }>(
    `select id, work_email, first_name, to_char(date_of_joining, 'YYYY-MM-DD') as date_of_joining from employees where tenant_id = $1 and current_legal_entity_id = $2`,
    [tid, c.indiaId],
  )).rows;
  for (const e of employees) {
    const annual = ctc[e.work_email ?? ''] ?? ctc[e.first_name];
    if (!annual) continue;
    const built = payrollEngine.buildSalary(annual, lines.map((l) => ({ code: l.code, name: l.name, kind: l.kind, calc: l.calc, value: l.value, isBasic: l.is_basic })), { pf: true, settings: DEFAULT_IN_STATUTORY });
    const sal = await q(
      `insert into employee_salaries (tenant_id, employee_id, effective_from, annual_ctc, currency, structure_id, employer_pf_monthly, note) values ($1, $2, $3, $4, 'INR', $5, $6, 'Demo data') returning id`,
      [tid, e.id, e.date_of_joining, annual, structure.id, built.employerPfMonthly],
    );
    await client.query(
      `insert into employee_salary_lines (tenant_id, salary_id, component_id, position, monthly) select $1, $2, x.component_id, x.pos, x.monthly from unnest($3::uuid[], $4::numeric[]) with ordinality as x(component_id, monthly, pos)`,
      [tid, sal.id, lines.map((l) => l.component_id), built.components.map((x) => x.monthly)],
    );
  }

  const emp = async (email: string) => (await q(`select id from employees where tenant_id = $1 and work_email = $2`, [tid, email])).id;
  const category = async (name: string) => (await q(`select id from expense_categories where tenant_id = $1 and name = $2`, [tid, name])).id;
  const prev = new Date();
  prev.setUTCDate(10);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const lastMonth10th = prev.toISOString().slice(0, 10); // inside last month, so the first demo run reimburses it
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await client.query(
    `insert into expense_claims (tenant_id, employee_id, category_id, spent_on, amount, currency, description, status, submitted_by_membership_id, decided_at)
     values ($1, $2, $3, $4, 850, 'INR', 'Cab to the supplier audit in Chakan (demo data)', 'approved', $5, now())`,
    [tid, await emp('operator1@demo.crew.local'), await category('Travel'), lastMonth10th, c.membershipByEmail.get('operator1@demo.crew.local')],
  );
  const nehaM = c.membershipByEmail.get('operator2@demo.crew.local')!;
  const supM = c.membershipByEmail.get('supervisor@demo.crew.local')!;
  const neha = await emp('operator2@demo.crew.local');
  const claim = await q(
    `insert into expense_claims (tenant_id, employee_id, category_id, spent_on, amount, currency, description, status, submitted_by_membership_id)
     values ($1, $2, $3, $4, 640, 'INR', 'Lunch during the night-shift handover training (demo data)', 'pending', $5) returning id`,
    [tid, neha, await category('Meals'), yesterday, nehaM],
  );
  const ar = await q(
    `insert into approval_requests (tenant_id, resource_type, resource_id, subject_employee_id, requested_by_membership_id, summary) values ($1, 'expense_claim', $2, $3, $4, $5) returning id`,
    [tid, claim.id, neha, nehaM, `Neha Deshmukh: Meals expense of INR 640.00 on ${yesterday}. Lunch during the night-shift handover training (demo data)`],
  );
  await client.query(`insert into approval_steps (tenant_id, request_id, seq, kind, approver_membership_id, status) values ($1, $2, 1, 'manager', $3, 'pending')`, [tid, ar.id, supM]);
  await client.query(`update expense_claims set approval_request_id = $2 where id = $1`, [claim.id, ar.id]);
}

/**
 * Phase 6 demo data: goals with check-ins, a mid-year review cycle in progress for the Assembly Line, learning
 * assignments, an open anonymous survey with a few answers, and recognition posts. Every record says it is demo data.
 */
async function seedTalent(client: PoolClient, c: { tid: string; assemblyId: string; manufacturingId: string; membershipByEmail: Map<string, string> }) {
  const { tid } = c;
  const q = async <T = { id: string }>(sql: string, params: unknown[]) => (await client.query(sql, params)).rows[0] as T;
  const emp = async (where: string, value: string) => (await q(`select id from employees where tenant_id = $1 and ${where} = $2`, [tid, value])).id;
  const m = (email: string) => c.membershipByEmail.get(email)!;
  const year = new Date().getUTCFullYear();
  const vikram = await emp('work_email', 'plant.head@demo.crew.local');
  const sunita = await emp('work_email', 'supervisor@demo.crew.local');
  const arjun = await emp('work_email', 'operator1@demo.crew.local');
  const neha = await emp('work_email', 'operator2@demo.crew.local');
  const farhan = await emp('work_email', 'qa.lead@demo.crew.local');
  const ganesh = await emp('first_name', 'Ganesh');
  const rekha = await emp('first_name', 'Rekha');

  // Goals --------------------------------------------------------------------------------------------------------
  const goal = async (employeeId: string, by: string, title: string, parent: string | null, weight: number, progress: number, confidence: string | null) =>
    (await q(
      `insert into goals (tenant_id, employee_id, parent_goal_id, title, description, period_start, period_end, weight, progress, reported_progress, confidence, last_checkin_at, created_by_membership_id)
       values ($1, $2, $3, $4, 'Demo data', $5, $6, $7, $8, $8, $9, case when $9::text is null then null else now() - interval '3 days' end, $10) returning id`,
      [tid, employeeId, parent, title, `${year}-01-01`, `${year}-12-31`, weight, progress, confidence, m(by)],
    )).id;
  const kr = (goalId: string, pos: number, title: string, start: number, target: number, current: number, unit: string) =>
    client.query(
      `insert into goal_key_results (tenant_id, goal_id, position, title, start_value, target_value, current_value, unit) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tid, goalId, pos, title, start, target, current, unit],
    );
  const oee = await goal(vikram, 'plant.head@demo.crew.local', 'Raise assembly line OEE to 85%', null, 60, 38.5, 'on_track');
  await kr(oee, 1, 'Overall equipment effectiveness', 72, 85, 77, '%');
  const defects = await goal(sunita, 'supervisor@demo.crew.local', 'Cut night-shift handover defects', oee, 50, 40, 'at_risk');
  await kr(defects, 1, 'Handover defects per month', 40, 10, 28, 'defects');
  await client.query(
    `insert into goal_checkins (tenant_id, goal_id, progress, confidence, note, values, by_membership_id, created_at)
     values ($1, $2, 40, 'at_risk', 'Checklist adopted on line 2; line 3 still uses paper (demo data)', $3, $4, now() - interval '3 days')`,
    [tid, defects, JSON.stringify([{ title: 'Handover defects per month', from: '34.00', to: '28' }]), m('supervisor@demo.crew.local')],
  );
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
  const cycle = await q(
    `insert into review_cycles (tenant_id, name, period_start, period_end, status, self_review, peer_feedback, questions, rating_scale, department_id, launched_at, created_by_membership_id)
     values ($1, $2, $3, $4, 'active', true, true, $5, $6, $7, now() - interval '10 days', $8) returning id`,
    [tid, `Mid-year ${year} review (demo data)`, `${year}-01-01`, `${year}-06-30`, JSON.stringify(questions), JSON.stringify(scale), c.assemblyId, m('hr.admin@demo.crew.local')],
  );
  const answers = (who: string) => JSON.stringify({
    achievements: `${who} delivered the planned output with fewer stoppages (demo data).`,
    strengths: 'Reliable on night shifts and helps new joiners.',
    growth: 'Take on the changeover checklist and train one colleague.',
  });
  const review = async (employeeId: string, managerId: string, selfDone: boolean, managerRating: number | null) =>
    (await q(
      `insert into reviews (tenant_id, cycle_id, employee_id, manager_employee_id, self_status, self_answers, self_rating, self_submitted_at,
                            manager_status, manager_answers, manager_rating, manager_submitted_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [tid, cycle.id, employeeId, managerId, selfDone ? 'submitted' : 'pending', selfDone ? answers('I') : '{}', selfDone ? 3 : null, selfDone ? new Date() : null,
        managerRating ? 'submitted' : 'pending', managerRating ? answers('They') : '{}', managerRating, managerRating ? new Date() : null],
    )).id;
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
    await client.query(
      `insert into review_feedback (tenant_id, review_id, reviewer_employee_id, requested_by_membership_id, status, answers, submitted_at) values ($1, $2, $3, $4, 'submitted', $5, now() - interval '2 days')`,
      [tid, arjunReview, reviewer, m('supervisor@demo.crew.local'), JSON.stringify({ strengths: `${strengths} (demo data)`, improve })],
    );
  }

  // Learning -----------------------------------------------------------------------------------------------------
  const course = async (title: string, format: string, minutes: number, validity: number | null, category: string, selfEnrol: boolean, description: string) =>
    (await q(
      `insert into courses (tenant_id, title, description, format, duration_minutes, validity_months, category, self_enrol, created_by_membership_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [tid, title, `${description} (demo data, no content link)`, format, minutes, validity, category, selfEnrol, m('hr.admin@demo.crew.local')],
    )).id;
  const forklift = await course('Forklift safety refresher', 'document', 45, 12, 'Safety', false, 'Annual refresher on safe forklift operation in the plant');
  const drill = await course('Fire drill and evacuation', 'classroom', 60, 12, 'Safety', false, 'Practical drill on the shop floor');
  await course('Lean basics: 5S on the line', 'online', 90, null, 'Operations', true, 'Sort, set in order, shine, standardise, sustain');
  await course('Spreadsheets for supervisors', 'online', 120, null, 'Skills', true, 'Shift reports and simple charts');
  const path = await q(`insert into learning_paths (tenant_id, title, description) values ($1, 'Shop floor safety', 'Required every year for plant staff (demo data)') returning id`, [tid]);
  await client.query(`insert into learning_path_courses (tenant_id, path_id, course_id, position) values ($1, $2, $3, 1), ($1, $2, $4, 2)`, [tid, path.id, forklift, drill]);
  const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  for (const who of [arjun, neha]) {
    for (const courseId of [forklift, drill]) {
      await client.query(
        `insert into course_assignments (tenant_id, employee_id, course_id, path_id, source, assigned_by_membership_id, due_on) values ($1, $2, $3, $4, 'assigned', $5, $6)`,
        [tid, who, courseId, path.id, m('supervisor@demo.crew.local'), due],
      );
    }
  }
  await client.query(
    `update course_assignments set status = 'completed', started_at = now() - interval '5 days', completed_on = current_date - 4, completion_note = 'Demo data',
            completed_by_membership_id = $3, expires_on = (current_date - 4 + interval '12 months')::date
      where tenant_id = $1 and employee_id = $2 and course_id = $4`,
    [tid, neha, m('operator2@demo.crew.local'), forklift],
  );

  // An open anonymous survey for Manufacturing, with three demo answers ----------------------------------------------
  const survey = await q(
    `insert into surveys (tenant_id, title, description, min_responses, questions, status, department_id, closes_on, opened_at, created_by_membership_id)
     values ($1, 'Plant pulse (demo data)', 'Five questions, fully anonymous.', 3, $2, 'open', $3, current_date + 10, now() - interval '2 days', $4) returning id`,
    [tid, JSON.stringify([
      { id: 'tools', kind: 'scale', text: 'I have the tools and information I need to do my job well' },
      { id: 'safety', kind: 'scale', text: 'I feel safe raising a problem on the line' },
      { id: 'enps', kind: 'enps', text: 'How likely are you to recommend working here to a friend?' },
      { id: 'comments', kind: 'text', text: 'What one thing would make work better?' },
    ]), c.manufacturingId, m('hr.admin@demo.crew.local')],
  );
  const audience = (await client.query<{ id: string }>(
    `with recursive deps(id) as (select $2::uuid union select d.id from departments d join deps on d.parent_id = deps.id)
     select id from employees where tenant_id = $1 and membership_id is not null and status in ('probation', 'active', 'notice') and current_department_id in (select id from deps)`,
    [tid, c.manufacturingId],
  )).rows.map((r) => r.id);
  await client.query(`insert into survey_invitations (tenant_id, survey_id, employee_id, responded) select $1, $2, x, x = any($4::uuid[]) from unnest($3::uuid[]) x`, [tid, survey.id, audience, [vikram, sunita, farhan]]);
  for (const a of [{ tools: 4, safety: 5, enps: 9, comments: 'More spare parts on the night shift (demo data)' }, { tools: 3, safety: 4, enps: 7 }, { tools: 2, safety: 3, enps: 6, comments: 'Fix the canteen timings (demo data)' }]) {
    await client.query(`insert into survey_responses (tenant_id, survey_id, department_id, answers, submitted_on) values ($1, $2, $3, $4, current_date - 1)`, [tid, survey.id, c.manufacturingId, JSON.stringify(a)]);
  }

  // Recognition --------------------------------------------------------------------------------------------------
  const value = async (name: string) => (await q(`select id from company_values where tenant_id = $1 and name = $2`, [tid, name])).id;
  const recognise = (from: string, to: string, valueName: string, message: string, daysAgo: number) =>
    value(valueName).then((v) => client.query(
      `insert into recognitions (tenant_id, from_employee_id, to_employee_id, value_id, message, created_at) values ($1, $2, $3, $4, $5, now() - make_interval(days => $6))`,
      [tid, from, to, v, `${message} (demo data)`, daysAgo],
    ));
  await recognise(sunita, neha, 'Teamwork', 'Covered two night shifts at short notice so the Diwali order shipped on time.', 6);
  await recognise(vikram, sunita, 'Ownership', 'Rolled out the handover checklist on line 2 without being asked.', 4);
  await recognise(farhan, arjun, 'Safety', 'Stopped the press when the guard sensor failed and reported it straight away.', 1);
}
