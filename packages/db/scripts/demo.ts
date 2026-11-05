import type { Pool } from 'pg';
import { leaveMath } from '@crew/contracts';
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
