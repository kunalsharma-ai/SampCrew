import type { Pool } from 'pg';
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
