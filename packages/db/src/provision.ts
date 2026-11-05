import { SYSTEM_ROLES } from '@crew/contracts';
import type { PoolClient } from 'pg';

export interface ProvisionTenantInput {
  name: string;
  slug: string;
  countryCode: string;
  currency: string;
  timezone: string;
  locale?: string;
  region?: string;
  isDemo?: boolean;
  owner: { email: string; fullName: string; passwordHash: string | null };
  plan: { key: string; seats: number; billingCycle: 'monthly' | 'annual'; trialDays: number };
}

export interface ProvisionedTenant {
  tenantId: string;
  ownerUserId: string;
  ownerMembershipId: string;
  legalEntityId: string;
  /** True when the owner already had a CREW identity (for example a consultant joining a second tenant). */
  existingUser: boolean;
}

export class SlugTakenError extends Error {
  constructor() {
    super('That workspace address is already taken');
  }
}

/**
 * Creates a tenant with its first legal entity, the system roles, the owner's membership and a
 * trial subscription. Must run inside a transaction under a role that can write every table
 * (the platform role or a migration superuser). Sets app.tenant_id for the transaction so that
 * RLS-scoped inserts and the audit chain behave exactly as they do for normal requests.
 */
export async function provisionTenant(db: PoolClient, input: ProvisionTenantInput): Promise<ProvisionedTenant> {
  const existing = await db.query('select 1 from tenants where slug = $1', [input.slug]);
  if (existing.rowCount) throw new SlugTakenError();

  const tenant = await db.query<{ id: string }>(
    `insert into tenants (slug, name, country_code, currency, timezone, locale, region, is_demo)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [input.slug, input.name, input.countryCode, input.currency, input.timezone, input.locale ?? 'en', input.region ?? regionFor(input.countryCode), input.isDemo ?? false],
  );
  const tenantId = tenant.rows[0]!.id;
  await db.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);

  const entity = await db.query<{ id: string }>(
    `insert into legal_entities (tenant_id, name, legal_name, country_code, currency, timezone, fiscal_year_start_month)
     values ($1, $2, $2, $3, $4, $5, $6) returning id`,
    [tenantId, input.name, input.countryCode, input.currency, input.timezone, input.countryCode === 'IN' ? 4 : 1],
  );
  const legalEntityId = entity.rows[0]!.id;

  const roleIds = new Map<string, string>();
  for (const role of SYSTEM_ROLES) {
    const r = await db.query<{ id: string }>(
      `insert into roles (tenant_id, key, name, description, is_system) values ($1, $2, $3, $4, true) returning id`,
      [tenantId, role.key, role.name, role.description],
    );
    const roleId = r.rows[0]!.id;
    roleIds.set(role.key, roleId);
    const grants = Object.entries(role.grants);
    if (grants.length) {
      await db.query(
        `insert into role_permissions (tenant_id, role_id, permission, scope)
         select $1, $2, g.permission, g.scope from unnest($3::text[], $4::text[]) as g(permission, scope)`,
        [tenantId, roleId, grants.map((g) => g[0]), grants.map((g) => g[1])],
      );
    }
  }

  let existingUser = false;
  let userId: string;
  const u = await db.query<{ id: string }>('select id from users where email = $1', [input.owner.email]);
  if (u.rows[0]) {
    userId = u.rows[0].id;
    existingUser = true;
  } else {
    const created = await db.query<{ id: string }>(
      `insert into users (email, full_name, password_hash, status) values ($1, $2, $3, 'active') returning id`,
      [input.owner.email, input.owner.fullName, input.owner.passwordHash],
    );
    userId = created.rows[0]!.id;
  }

  const membershipStatus = input.owner.passwordHash || existingUser ? 'active' : 'invited';
  const m = await db.query<{ id: string }>(
    `insert into memberships (tenant_id, user_id, status, legal_entity_id, title, joined_at)
     values ($1, $2, $3, $4, 'Owner', case when $3 = 'active' then now() end) returning id`,
    [tenantId, userId, membershipStatus, legalEntityId],
  );
  const ownerMembershipId = m.rows[0]!.id;
  for (const key of ['tenant_owner', 'employee']) {
    await db.query('insert into role_assignments (tenant_id, membership_id, role_id) values ($1, $2, $3)', [tenantId, ownerMembershipId, roleIds.get(key)]);
  }

  const plan = await db.query<{ id: string; minimum_seats: number; quote_only: boolean }>(
    'select id, minimum_seats, quote_only from plans where key = $1',
    [input.plan.key],
  );
  if (!plan.rows[0]) throw new Error(`Unknown plan ${input.plan.key}`);
  const price = await db.query<{ monthly_per_seat: string; annual_per_seat_month: string }>(
    'select monthly_per_seat, annual_per_seat_month from plan_prices where plan_id = $1 and currency = $2',
    [plan.rows[0].id, input.currency],
  );
  const fallback = await db.query<{ monthly_per_seat: string; annual_per_seat_month: string }>(
    `select monthly_per_seat, annual_per_seat_month from plan_prices where plan_id = $1 and currency = 'USD'`,
    [plan.rows[0].id],
  );
  const priceRow = price.rows[0] ?? fallback.rows[0];
  const billingCurrency = price.rows[0] ? input.currency : 'USD';
  const unitPrice = priceRow ? (input.plan.billingCycle === 'annual' ? priceRow.annual_per_seat_month : priceRow.monthly_per_seat) : '0';
  await db.query(
    `insert into subscriptions (tenant_id, plan_id, status, billing_cycle, currency, seats, unit_price, trial_ends_on, current_period_start, current_period_end)
     values ($1, $2, $3, $4, $5, $6, $7, $8, current_date, $9)`,
    [
      tenantId,
      plan.rows[0].id,
      input.plan.trialDays > 0 ? 'trialing' : 'active',
      input.plan.billingCycle,
      billingCurrency,
      Math.max(input.plan.seats, 1),
      unitPrice,
      input.plan.trialDays > 0 ? addDays(input.plan.trialDays) : null,
      addDays(input.plan.trialDays > 0 ? input.plan.trialDays : input.plan.billingCycle === 'annual' ? 365 : 30),
    ],
  );

  // Starting points every workspace can edit: a default calendar (no public holidays until HR adds them)
  // and a default onboarding checklist.
  await db.query(
    `insert into holiday_calendars (tenant_id, name, is_default, weekly_offs) values ($1, 'Default calendar', true, '{0,6}')`,
    [tenantId],
  );
  await db.query(
    `insert into onboarding_templates (tenant_id, name, description, tasks, is_default) values ($1, 'Standard onboarding', 'Default checklist for new joiners', $2, true)`,
    [tenantId, JSON.stringify(DEFAULT_ONBOARDING_TASKS)],
  );
  // A general shift and a workspace attendance policy that uses it, so attendance works from day one.
  const shift = await db.query<{ id: string }>(
    `insert into shift_templates (tenant_id, code, name, start_time, end_time, break_minutes) values ($1, 'GEN', 'General shift', '09:00', '18:00', 60) returning id`,
    [tenantId],
  );
  await db.query(`insert into attendance_policies (tenant_id, default_shift_id) values ($1, $2)`, [tenantId, shift.rows[0]!.id]);

  return { tenantId, ownerUserId: userId, ownerMembershipId, legalEntityId, existingUser };
}

function addDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function regionFor(countryCode: string): string {
  if (countryCode === 'IN') return 'in';
  if (countryCode === 'GB') return 'uk';
  if (['US', 'CA', 'MX', 'BR'].includes(countryCode)) return 'us';
  if (['AE', 'SA', 'QA', 'KW', 'OM', 'BH'].includes(countryCode)) return 'me';
  if (['SG', 'MY', 'ID', 'PH', 'TH', 'VN'].includes(countryCode)) return 'sg';
  if (['AU', 'NZ'].includes(countryCode)) return 'au';
  return 'eu';
}

export const DEFAULT_ONBOARDING_TASKS = [
  { title: 'Send offer letter and collect signed copy', owner: 'hr', dueOffsetDays: -14 },
  { title: 'Collect identity and address proof', owner: 'employee', dueOffsetDays: -3 },
  { title: 'Add bank and tax details', owner: 'employee', dueOffsetDays: 0 },
  { title: 'Prepare laptop, email and system access', owner: 'it', dueOffsetDays: -2 },
  { title: 'Plan the first week and assign a buddy', owner: 'manager', dueOffsetDays: -1 },
  { title: 'Welcome meeting and workplace tour', owner: 'manager', dueOffsetDays: 0 },
  { title: 'Read and acknowledge company policies', owner: 'employee', dueOffsetDays: 7 },
  { title: '30-day check-in', owner: 'manager', dueOffsetDays: 30 },
];
