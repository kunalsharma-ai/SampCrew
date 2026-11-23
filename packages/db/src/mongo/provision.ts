import {
  builtInStatutoryPacks, DEFAULT_LEAVE_TYPES, leaveAllocationCriteria, leaveApprovalRules, leaveEligibility, leaveTypePolicy, FEATURES, PLAN_TEMPLATES, SWITCHABLE_FEATURE_KEYS, SYSTEM_ROLES,
} from '@crew/contracts';
import { applyAccessLevelsMongo } from './access-levels';
import { syncHelpLibraryMongo } from './help-library';
import type { Row, Table } from './table';

/** Anything that hands out unrestricted tables in one transaction (the API's PlatformTx, or a script's own). */
export interface Tables {
  collection<T extends Row = Row>(name: string): Table<T>;
}

/**
 * Creates a tenant with its first legal entity, the system roles,
 * the owner's membership, a subscription and the starting data every workspace edits. Run it in a platform
 * transaction so that it all lands or none of it does.
 */
export async function provisionTenantMongo(tx: Tables, input: ProvisionTenantInput): Promise<ProvisionedTenant> {
  if (await tx.collection('tenants').exists({ slug: input.slug })) throw new SlugTakenError();

  const tenant = await tx.collection('tenants').insert({
    slug: input.slug,
    name: input.name,
    country_code: input.countryCode,
    currency: input.currency,
    timezone: input.timezone,
    locale: input.locale ?? 'en',
    region: input.region ?? regionFor(input.countryCode),
    is_demo: input.isDemo ?? false,
  });
  const tenantId = tenant.id as string;
  const t = (name: string) => tx.collection(name);
  const own = (row: Row) => ({ tenant_id: tenantId, ...row });

  const entity = await t('legal_entities').insert(
    own({ name: input.name, legal_name: input.name, country_code: input.countryCode, currency: input.currency, timezone: input.timezone, fiscal_year_start_month: input.countryCode === 'IN' ? 4 : 1 }),
  );
  const legalEntityId = entity.id as string;

  const roleIds = new Map<string, string>();
  for (const role of SYSTEM_ROLES) {
    const r = await t('roles').insert(own({ key: role.key, name: role.name, description: role.description, is_system: true, template_grants: Object.keys(role.grants).sort() }));
    roleIds.set(role.key, r.id as string);
    const grants = Object.entries(role.grants);
    if (grants.length) await t('role_permissions').insertMany(grants.map(([permission, scope]) => own({ role_id: r.id, permission, scope })));
  }

  let existingUser = false;
  let userId: string;
  const u = await t('users').findOne({ email: input.owner.email });
  if (u) {
    userId = u.id as string;
    existingUser = true;
  } else {
    userId = (await t('users').insert({ email: input.owner.email, full_name: input.owner.fullName, password_hash: input.owner.passwordHash, must_change_password: !!(input.owner.passwordHash && input.owner.mustChangePassword), status: 'active' })).id as string;
  }

  const membershipStatus = input.owner.passwordHash || existingUser ? 'active' : 'invited';
  const m = await t('memberships').insert(
    own({ user_id: userId, status: membershipStatus, legal_entity_id: legalEntityId, title: 'Owner', joined_at: membershipStatus === 'active' ? new Date() : null }),
  );
  const ownerMembershipId = m.id as string;
  await t('role_assignments').insertMany(['super_workspace', 'employee_workspace'].map((key) => own({ membership_id: ownerMembershipId, role_id: roleIds.get(key) })));

  const plan = await t('plans').findOne({ key: input.plan.key });
  if (!plan) throw new Error(`Unknown plan ${input.plan.key}`);
  const price = await t('plan_prices').findOne({ plan_id: plan.id, currency: input.currency });
  const priceRow = price ?? (await t('plan_prices').findOne({ plan_id: plan.id, currency: 'USD' }));
  const billingCurrency = price ? input.currency : 'USD';
  const unitPrice = priceRow ? (input.plan.billingCycle === 'annual' ? priceRow.annual_per_seat_month : priceRow.monthly_per_seat) : '0';
  const trial = input.plan.trialDays > 0;
  await t('subscriptions').insert(
    own({
      plan_id: plan.id,
      status: trial ? 'trialing' : 'active',
      billing_cycle: input.plan.billingCycle,
      currency: billingCurrency,
      seats: Math.max(input.plan.seats, 1),
      unit_price: unitPrice,
      trial_ends_on: trial ? addDays(input.plan.trialDays) : null,
      current_period_start: addDays(0),
      current_period_end: addDays(trial ? input.plan.trialDays : input.plan.billingCycle === 'annual' ? 365 : 30),
    }),
  );

  // Starting points every workspace can edit: a default calendar (no public holidays until HR adds them)
  // and a default onboarding checklist.
  await t('holiday_calendars').insert(own({ name: 'Default calendar', is_default: true, weekly_offs: [0, 6] }));
  await t('onboarding_templates').insert(own({ name: 'Standard onboarding', description: 'Default checklist for new joiners', tasks: DEFAULT_ONBOARDING_TASKS, is_default: true }));
  // The starter leave types (Permanent, Casual and Sick Leave), allocated to everyone and available to the company's
  // HR team, so employees can apply for leave from day one. Each is an ordinary type the Super Workspace can change,
  // deactivate or remove; nothing about them is fixed in code.
  if (!input.isDemo && input.leaveTypes !== 'none') {
    const by = { by_level: 'system', by_membership_id: null, by_name: 'SampCrew' };
    for (const lt of DEFAULT_LEAVE_TYPES) {
      const fields = {
        code: lt.code, name: lt.name, description: lt.description, category: lt.category, paid: lt.paid, allow_half_day: lt.allowHalfDay, color: lt.color,
        kind: lt.kind, eligible_gender: lt.eligibleGender, counts_calendar_days: lt.countsCalendarDays, effective_from: null, hr_allocatable: true,
        eligibility: leaveEligibility.parse({}),
        policy: leaveTypePolicy.parse({ accrualMethod: lt.accrualMethod, annualEntitlement: lt.annualEntitlement, carryForwardMax: lt.carryForwardMax }),
        approval: leaveApprovalRules.parse({}),
      };
      const type = await t('leave_types').insert(own({
        ...fields, version: 1, created_by_level: 'system', created_by_membership_id: null, created_by_name: 'SampCrew',
        updated_by_level: 'system', updated_by_membership_id: null, updated_by_name: 'SampCrew',
      }));
      await t('leave_type_versions').insert(own({ leave_type_id: type.id, version: 1, action: 'created', ...by, changes: {}, snapshot: fields, note: 'Starter leave type' }));
      await t('leave_allocations').insert(own({ leave_type_id: type.id, target: 'employees', hr_workspace_id: null, criteria: leaveAllocationCriteria.parse({ all: true }), entitlement_days: null, note: 'Starter allocation to everyone eligible', ...by }));
      await t('leave_allocations').insert(own({ leave_type_id: type.id, target: 'hr_workspace', hr_workspace_id: null, criteria: {}, entitlement_days: null, note: 'Available to the company HR team', ...by }));
    }
  }
  // A general shift and a workspace attendance policy that uses it, so attendance works from day one.
  const shift = await t('shift_templates').insert(own({ code: 'GEN', name: 'General shift', start_time: '09:00', end_time: '18:00', break_minutes: 60 }));
  await t('attendance_policies').insert(own({ default_shift_id: shift.id }));
  // The default recruitment pipeline. Workspaces can rename, add and reorder stages.
  await t('recruitment_stages').insertMany(
    [
      ['Applied', 'new'],
      ['Screening', 'screen'],
      ['Interview', 'interview'],
      ['Offer', 'offer'],
      ['Hired', 'hired'],
    ].map(([name, kind], i) => own({ name, kind, position: i + 1 })),
  );
  // Default pay components, salary structure and expense categories. Statutory settings are not created here:
  // payroll admins review and save them per legal entity before the first run.
  const components = await t('pay_components').insertMany(
    [
      ['BASIC', 'Basic', true, 'Basic pay. Provident Fund is calculated on it.'],
      ['HRA', 'House rent allowance', false, 'Taxable in full under the new tax regime.'],
      ['SPECIAL', 'Special allowance', false, 'Usually takes the balance of the CTC.'],
    ].map(([code, name, basic, description]) => own({ code, name, kind: 'earning', taxable: true, prorate: true, pf_wage: basic, is_basic: basic, is_system: true, description })),
  );
  const componentId = (code: string) => components.find((c) => c.code === code)!.id;
  const structure = await t('salary_structures').insert(own({ name: 'Standard', description: 'Basic 50% of CTC, HRA 40% of Basic, the rest as special allowance.' }));
  await t('salary_structure_lines').insertMany(
    (
      [
        ['BASIC', 1, 'percent_of_ctc', 50],
        ['HRA', 2, 'percent_of_basic', 40],
        ['SPECIAL', 3, 'balance', 0],
      ] as const
    ).map(([code, position, calc, value]) => own({ structure_id: structure.id, component_id: componentId(code), position, calc, value })),
  );
  await t('expense_categories').insertMany(
    (
      [
        ['Travel', null],
        ['Meals', 5000],
        ['Accommodation', null],
        ['Internet and phone', 3000],
        ['Other', null],
      ] as const
    ).map(([name, max]) => own({ name, receipt_required: true, max_per_claim: max })),
  );
  // Company values used to tag recognition. Each workspace edits them.
  await t('company_values').insertMany(
    [
      ['Customer first', 'We start from what the customer needs.'],
      ['Ownership', 'We take responsibility and follow through.'],
      ['Teamwork', 'We help each other succeed.'],
      ['Safety', 'Nobody gets hurt doing their job.'],
    ].map(([name, description]) => own({ name, description })),
  );
  // Starting helpdesk categories with response targets in hours. Each workspace edits them and adds handlers.
  await t('helpdesk_categories').insertMany(
    (
      [
        ['Pay and payslips', 'Questions about salary, deductions, payslips and reimbursements.', 24, 72],
        ['Leave and attendance', 'Balances, holidays, punches and corrections.', 24, 72],
        ['Documents and letters', 'Employment letters, address proofs and other documents.', 24, 120],
        ['IT and access', 'Accounts, devices and access to systems.', 8, 48],
        ['Something else', 'Anything that does not fit the other categories.', 48, 168],
      ] as const
    ).map(([name, description, fr, res]) => own({ name, description, first_response_hours: fr, resolution_hours: res })),
  );

  return { tenantId, ownerUserId: userId, ownerMembershipId, legalEntityId, existingUser };
}

/**
 * SampCrew's built-in statutory country packs into the database. A pack SAMPLEDGE customised in the Console is left
 * alone; the others follow the code, so a release with new rates updates them. Safe on every deploy.
 */
export async function syncStatutoryPacksMongo(tx: Tables): Promise<void> {
  const packs = tx.collection('statutory_packs');
  for (const p of builtInStatutoryPacks()) {
    const existing = await packs.findOne({ country_code: p.countryCode });
    const fields = { country: p.country, currency: p.currency, basis: p.basis, summary: p.summary, settings: p.settings, built_in: true };
    if (!existing) await packs.insert({ country_code: p.countryCode, ...fields });
    else if (!existing.customised_at) await packs.updateOne({ id: existing.id }, { $set: fields });
    else if (!existing.built_in) await packs.updateOne({ id: existing.id }, { $set: { built_in: true } });
  }
}

/**
 * Brings every workspace's system roles up to the role templates in code (packages/contracts/src/roles.ts):
 *  - a system role a workspace does not have yet (added in a release) is created with its template grants;
 *  - a template grant the workspace has never been given is added, at the template's scope.
 * Each role remembers the template grants it was given (template_grants), so a grant HR removed in HR Workspace
 * Admin is not added back, and a grant HR changed keeps HR's scope. Safe on every deploy.
 */
export async function syncSystemRolesMongo(tx: Tables): Promise<{ rolesCreated: number; grantsAdded: number }> {
  let rolesCreated = 0;
  let grantsAdded = 0;
  const tenants = await tx.collection('tenants').find({}, { projection: { _id: 1 } });
  for (const tenant of tenants) {
    const tenantId = tenant.id as string;
    const roles = new Map((await tx.collection('roles').find({ tenant_id: tenantId, is_system: true })).map((r) => [r.key as string, r]));
    for (const tpl of SYSTEM_ROLES) {
      const keys = Object.keys(tpl.grants).sort();
      const existing = roles.get(tpl.key);
      if (!existing) {
        if (await tx.collection('roles').exists({ tenant_id: tenantId, key: tpl.key })) continue; // a custom role took the key
        const r = await tx.collection('roles').insert({ tenant_id: tenantId, key: tpl.key, name: tpl.name, description: tpl.description, is_system: true, template_grants: keys });
        const grants = Object.entries(tpl.grants);
        if (grants.length) await tx.collection('role_permissions').insertMany(grants.map(([permission, scope]) => ({ tenant_id: tenantId, role_id: r.id, permission, scope })));
        rolesCreated++;
        grantsAdded += grants.length;
        continue;
      }
      const current = new Set((await tx.collection('role_permissions').find({ role_id: existing.id }, { projection: { permission: 1 } })).map((g) => g.permission as string));
      // Before this sync existed, system roles could not be edited, so what they hold is what they were given.
      const seen = new Set<string>((existing.template_grants as string[] | undefined) ?? [...current]);
      const fresh = keys.filter((k) => !seen.has(k) && !current.has(k));
      if (fresh.length) {
        await tx.collection('role_permissions').insertMany(fresh.map((permission) => ({ tenant_id: tenantId, role_id: existing.id, permission, scope: tpl.grants[permission as keyof typeof tpl.grants]! })));
        grantsAdded += fresh.length;
      }
      const remembered = [...new Set([...seen, ...keys])].sort();
      if (JSON.stringify(remembered) !== JSON.stringify(((existing.template_grants as string[] | undefined) ?? []).slice().sort())) {
        await tx.collection('roles').updateOne({ id: existing.id }, { $set: { template_grants: remembered } });
      }
    }
  }
  return { rolesCreated, grantsAdded };
}

/** MongoDB version of syncCatalogue (../catalogue.ts): the feature catalogue, default plans and statutory packs, safe on every deploy. */
/**
 * Console > Feature management. The first sync records every module and part as active (what companies already use
 * stays on). After that, a module or part added to the code is written as pending: it stays off for every company
 * until SAMPLEDGE activates it in the Console.
 */
export async function syncFeatureStatesMongo(tx: Tables): Promise<void> {
  const states = tx.collection('platform_feature_states');
  const known = new Set((await states.find({}, { projection: { key: 1 } })).map((r) => r.key as string));
  const first = known.size === 0;
  for (const key of SWITCHABLE_FEATURE_KEYS) {
    if (!known.has(key)) await states.insert({ key, state: first ? 'active' : 'pending', updated_by: 'catalogue' });
  }
}

export async function syncCatalogueMongo(tx: Tables): Promise<void> {
  await syncStatutoryPacksMongo(tx);
  await syncSystemRolesMongo(tx);
  await applyAccessLevelsMongo(tx);
  const features = tx.collection('features');
  const plans = tx.collection('plans');
  const planFeatures = tx.collection('plan_features');
  const known = new Set((await features.find({}, { projection: { key: 1 } })).map((r) => r.key as string));
  const fresh = new Set(FEATURES.map((f) => f.key as string).filter((k) => !known.has(k)));
  for (const f of FEATURES) {
    const row = { key: f.key, name: f.name, module: f.module, kind: f.kind, unit: 'unit' in f ? f.unit : null };
    await features.upsert({ key: f.key }, row, { $set: { name: row.name, module: row.module, kind: row.kind, unit: row.unit } });
  }
  await syncFeatureStatesMongo(tx);
  await syncHelpLibraryMongo(tx);
  for (const p of PLAN_TEMPLATES) {
    const existing = await plans.findOne({ key: p.key });
    if (existing?.customised_at) {
      for (const key of p.features.filter((k) => fresh.has(k))) {
        if (!(await planFeatures.exists({ plan_id: existing.id, feature_key: key }))) await planFeatures.insert({ plan_id: existing.id, feature_key: key });
      }
      for (const [key, value] of Object.entries(p.limits).filter(([k]) => fresh.has(k))) {
        if (!(await planFeatures.exists({ plan_id: existing.id, feature_key: key }))) await planFeatures.insert({ plan_id: existing.id, feature_key: key, limit_value: value });
      }
      continue;
    }
    const fields = { name: p.name, tagline: p.tagline, sort_order: p.sortOrder, minimum_seats: p.minimumSeats, quote_only: p.quoteOnly };
    const plan = await plans.upsert({ key: p.key }, { key: p.key, ...fields }, { $set: fields });
    for (const price of p.prices) {
      if (!(await tx.collection('plan_prices').exists({ plan_id: plan.id, currency: price.currency }))) {
        await tx.collection('plan_prices').insert({ plan_id: plan.id, currency: price.currency, monthly_per_seat: price.monthly, annual_per_seat_month: price.annualPerMonth });
      }
    }
    await planFeatures.delete({ plan_id: plan.id });
    const rows = [...p.features.map((key) => ({ plan_id: plan.id, feature_key: key })), ...Object.entries(p.limits).map(([key, value]) => ({ plan_id: plan.id, feature_key: key, limit_value: value }))];
    if (rows.length) await planFeatures.insertMany(rows);
  }
}

function addDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface ProvisionTenantInput {
  name: string;
  slug: string;
  countryCode: string;
  currency: string;
  timezone: string;
  locale?: string;
  region?: string;
  isDemo?: boolean;
  /** `mustChangePassword` marks a temporary password that the owner replaces at their first sign-in. */
  owner: { email: string; fullName: string; passwordHash: string | null; mustChangePassword?: boolean };
  plan: { key: string; seats: number; billingCycle: 'monthly' | 'annual'; trialDays: number };
  /** 'standard' (the default) starts the workspace with the starter leave types allocated to everyone; 'none' leaves them to the Super Workspace. */
  leaveTypes?: 'standard' | 'none';
}

export interface ProvisionedTenant {
  tenantId: string;
  ownerUserId: string;
  ownerMembershipId: string;
  legalEntityId: string;
  /** True when the owner already had a SampCrew identity (for example a consultant joining a second tenant). */
  existingUser: boolean;
}

export class SlugTakenError extends Error {
  constructor() {
    super('That workspace address is already taken');
  }
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
