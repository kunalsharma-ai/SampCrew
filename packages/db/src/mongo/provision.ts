import { FEATURES, PLAN_TEMPLATES, SYSTEM_ROLES } from '@crew/contracts';
import { DEFAULT_ONBOARDING_TASKS, type ProvisionedTenant, type ProvisionTenantInput, regionFor, SlugTakenError } from '../provision';
import type { Row, Table } from './table';

/** Anything that hands out unrestricted tables in one transaction (the API's PlatformTx, or a script's own). */
export interface Tables {
  collection<T extends Row = Row>(name: string): Table<T>;
}

/**
 * MongoDB version of provisionTenant (../provision.ts): a tenant with its first legal entity, the system roles,
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
    const r = await t('roles').insert(own({ key: role.key, name: role.name, description: role.description, is_system: true }));
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
    userId = (await t('users').insert({ email: input.owner.email, full_name: input.owner.fullName, password_hash: input.owner.passwordHash, status: 'active' })).id as string;
  }

  const membershipStatus = input.owner.passwordHash || existingUser ? 'active' : 'invited';
  const m = await t('memberships').insert(
    own({ user_id: userId, status: membershipStatus, legal_entity_id: legalEntityId, title: 'Owner', joined_at: membershipStatus === 'active' ? new Date() : null }),
  );
  const ownerMembershipId = m.id as string;
  await t('role_assignments').insertMany(['tenant_owner', 'employee'].map((key) => own({ membership_id: ownerMembershipId, role_id: roleIds.get(key) })));

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

/** MongoDB version of syncCatalogue (../catalogue.ts): the feature catalogue and default plans, safe on every deploy. */
export async function syncCatalogueMongo(tx: Tables): Promise<void> {
  const features = tx.collection('features');
  const plans = tx.collection('plans');
  const planFeatures = tx.collection('plan_features');
  const known = new Set((await features.find({}, { projection: { key: 1 } })).map((r) => r.key as string));
  const fresh = new Set(FEATURES.map((f) => f.key as string).filter((k) => !known.has(k)));
  for (const f of FEATURES) {
    const row = { key: f.key, name: f.name, module: f.module, kind: f.kind, unit: 'unit' in f ? f.unit : null };
    await features.upsert({ key: f.key }, row, { $set: { name: row.name, module: row.module, kind: row.kind, unit: row.unit } });
  }
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
