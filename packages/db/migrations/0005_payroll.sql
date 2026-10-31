-- Phase 5: payroll and expenses.
-- Money is numeric(14,2) everywhere and is computed with exact integer arithmetic in the API (see
-- packages/contracts/src/money.ts). Finalised payroll is immutable.

-------------------------------------------------------------------------------
-- Pay components and salary structures
-------------------------------------------------------------------------------

create table pay_components (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null check (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  name text not null check (length(name) between 2 and 60),
  kind text not null check (kind in ('earning', 'deduction')),
  taxable boolean not null default true,
  prorate boolean not null default true,
  pf_wage boolean not null default false,
  is_basic boolean not null default false,
  is_system boolean not null default false,
  description text not null default '' check (length(description) <= 300),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (kind = 'earning' or (not pf_wage and not is_basic))
);
create unique index pay_components_code on pay_components (tenant_id, code);
create unique index pay_components_one_basic on pay_components (tenant_id) where is_basic;

create table salary_structures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 2 and 80),
  description text not null default '' check (length(description) <= 300),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index salary_structures_name on salary_structures (tenant_id, lower(name)) where archived_at is null;
create trigger salary_structures_touch before update on salary_structures for each row execute function touch_updated_at();

create table salary_structure_lines (
  tenant_id uuid not null references tenants(id) on delete cascade,
  structure_id uuid not null,
  component_id uuid not null,
  position smallint not null,
  calc text not null check (calc in ('fixed', 'percent_of_ctc', 'percent_of_basic', 'balance')),
  value numeric(14, 4) not null default 0 check (value >= 0),
  primary key (tenant_id, structure_id, component_id),
  foreign key (tenant_id, structure_id) references salary_structures (tenant_id, id) on delete cascade,
  foreign key (tenant_id, component_id) references pay_components (tenant_id, id)
);

-------------------------------------------------------------------------------
-- Employee salaries (effective-dated; the monthly breakdown is stored, not re-derived)
-------------------------------------------------------------------------------

create table employee_salaries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  effective_from date not null,
  annual_ctc numeric(14, 2) not null check (annual_ctc > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  structure_id uuid not null,
  pf_enabled boolean not null default true,
  esi_enabled boolean not null default true,
  pt_enabled boolean not null default true,
  tds_enabled boolean not null default true,
  employer_pf_monthly numeric(14, 2) not null default 0,
  note text check (length(note) <= 500),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, employee_id, effective_from),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, structure_id) references salary_structures (tenant_id, id)
);

create table employee_salary_lines (
  tenant_id uuid not null references tenants(id) on delete cascade,
  salary_id uuid not null,
  component_id uuid not null,
  position smallint not null,
  monthly numeric(14, 2) not null check (monthly >= 0),
  primary key (tenant_id, salary_id, component_id),
  foreign key (tenant_id, salary_id) references employee_salaries (tenant_id, id) on delete cascade,
  foreign key (tenant_id, component_id) references pay_components (tenant_id, id)
);

-------------------------------------------------------------------------------
-- Statutory settings per legal entity, effective-dated. Reviewed by the workspace; never assumed.
-------------------------------------------------------------------------------

create table statutory_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  legal_entity_id uuid not null,
  effective_from date not null,
  lop_source text not null default 'attendance_and_leave' check (lop_source in ('attendance_and_leave', 'leave_only')),
  settings jsonb not null,
  saved_by uuid,
  saved_at timestamptz not null default now(),
  unique (tenant_id, legal_entity_id, effective_from),
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id)
);

-------------------------------------------------------------------------------
-- Payroll runs, items and adjustments
-------------------------------------------------------------------------------

create table payroll_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  legal_entity_id uuid not null,
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  currency text not null,
  status text not null default 'draft' check (status in ('draft', 'computed', 'pending_approval', 'finalised', 'cancelled')),
  statutory_settings_id uuid references statutory_settings(id),
  approval_request_id uuid,
  status_note text check (length(status_note) <= 500),
  employee_count integer not null default 0,
  gross numeric(16, 2) not null default 0,
  deductions numeric(16, 2) not null default 0,
  reimbursements numeric(16, 2) not null default 0,
  net numeric(16, 2) not null default 0,
  employer_contributions numeric(16, 2) not null default 0,
  computed_at timestamptz,
  finalised_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id),
  foreign key (tenant_id, approval_request_id) references approval_requests (tenant_id, id),
  check (period_end >= period_start and period_end - period_start < 31)
);
create unique index payroll_runs_one_per_month on payroll_runs (tenant_id, legal_entity_id, period_start) where status <> 'cancelled';
create trigger payroll_runs_touch before update on payroll_runs for each row execute function touch_updated_at();

create table payroll_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  run_id uuid not null,
  employee_id uuid not null,
  salary_id uuid,
  status text not null default 'included' check (status in ('included', 'on_hold')),
  hold_reason text,
  days_in_period smallint not null,
  employed_days smallint not null,
  lop_days numeric(5, 2) not null default 0,
  lop_override numeric(5, 2),
  lop_override_reason text,
  paid_days numeric(5, 2) not null default 0,
  gross numeric(14, 2) not null default 0,
  deductions numeric(14, 2) not null default 0,
  reimbursements numeric(14, 2) not null default 0,
  net numeric(14, 2) not null default 0,
  employer_contributions numeric(14, 2) not null default 0,
  taxable numeric(14, 2) not null default 0,
  tds numeric(14, 2) not null default 0,
  lines jsonb not null default '[]',
  explanation jsonb not null default '[]',
  warnings jsonb not null default '[]',
  inputs jsonb not null default '{}',
  computed_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (run_id, employee_id),
  foreign key (tenant_id, run_id) references payroll_runs (tenant_id, id) on delete cascade,
  foreign key (tenant_id, employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, salary_id) references employee_salaries (tenant_id, id)
);
create index payroll_items_employee on payroll_items (tenant_id, employee_id);

create table payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  run_id uuid not null,
  employee_id uuid not null,
  kind text not null check (kind in ('earning', 'deduction')),
  label text not null check (length(label) between 2 and 60),
  amount numeric(14, 2) not null check (amount > 0),
  taxable boolean not null default true,
  reason text not null check (length(reason) between 3 and 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, run_id) references payroll_runs (tenant_id, id) on delete cascade,
  foreign key (tenant_id, employee_id) references employees (tenant_id, id)
);

-- Once a run is finalised its items, adjustments and the run's figures are frozen.
create or replace function payroll_frozen() returns trigger language plpgsql as $$
declare st text;
begin
  -- Deleting a whole workspace cascades from inside another trigger; that is allowed.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  if tg_table_name = 'payroll_runs' then
    if old.status = 'finalised' then raise exception 'A finalised payroll run cannot be changed' using errcode = 'P0001'; end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select status into st from payroll_runs where id = coalesce(old.run_id, new.run_id);
  if st = 'finalised' then raise exception 'A finalised payroll run cannot be changed' using errcode = 'P0001'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger payroll_runs_frozen before update or delete on payroll_runs for each row execute function payroll_frozen();
create trigger payroll_items_frozen before insert or update or delete on payroll_items for each row execute function payroll_frozen();
create trigger payroll_adjustments_frozen before insert or update or delete on payroll_adjustments for each row execute function payroll_frozen();

-------------------------------------------------------------------------------
-- Expenses
-------------------------------------------------------------------------------

create table expense_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 2 and 60),
  receipt_required boolean not null default true,
  max_per_claim numeric(14, 2) check (max_per_claim > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index expense_categories_name on expense_categories (tenant_id, lower(name)) where archived_at is null;

create table expense_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  category_id uuid not null,
  spent_on date not null,
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  description text not null check (length(description) between 3 and 500),
  receipt_key text,
  receipt_name text,
  receipt_type text,
  receipt_size integer,
  receipt_sha256 text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'paid')),
  approval_request_id uuid,
  payroll_run_id uuid,
  submitted_by_membership_id uuid,
  decided_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, category_id) references expense_categories (tenant_id, id),
  foreign key (tenant_id, approval_request_id) references approval_requests (tenant_id, id),
  foreign key (tenant_id, payroll_run_id) references payroll_runs (tenant_id, id),
  check (status <> 'paid' or payroll_run_id is not null)
);
create index expense_claims_employee on expense_claims (tenant_id, employee_id, status);
create trigger expense_claims_touch before update on expense_claims for each row execute function touch_updated_at();

-------------------------------------------------------------------------------
-- Defaults for existing workspaces (new ones get these at provisioning)
-------------------------------------------------------------------------------

insert into pay_components (tenant_id, code, name, kind, taxable, prorate, pf_wage, is_basic, is_system, description)
select t.id, c.code, c.name, c.kind, c.taxable, true, c.pf_wage, c.is_basic, true, c.description
from tenants t cross join (values
  ('BASIC', 'Basic', 'earning', true, true, true, 'Basic pay. Provident Fund is calculated on it.'),
  ('HRA', 'House rent allowance', 'earning', true, false, false, 'Taxable in full under the new tax regime.'),
  ('SPECIAL', 'Special allowance', 'earning', true, false, false, 'Usually takes the balance of the CTC.')
) as c(code, name, kind, taxable, pf_wage, is_basic, description)
on conflict do nothing;

insert into salary_structures (tenant_id, name, description)
select id, 'Standard', 'Basic 50% of CTC, HRA 40% of Basic, the rest as special allowance.' from tenants;

insert into salary_structure_lines (tenant_id, structure_id, component_id, position, calc, value)
select s.tenant_id, s.id, c.id, x.pos, x.calc, x.value
from salary_structures s
join (values ('BASIC', 1, 'percent_of_ctc', 50), ('HRA', 2, 'percent_of_basic', 40), ('SPECIAL', 3, 'balance', 0)) as x(code, pos, calc, value) on true
join pay_components c on c.tenant_id = s.tenant_id and c.code = x.code
where s.name = 'Standard';

insert into expense_categories (tenant_id, name, receipt_required, max_per_claim)
select t.id, c.name, c.receipt_required, c.max_per_claim
from tenants t cross join (values ('Travel', true, null::numeric), ('Meals', true, 5000), ('Accommodation', true, null), ('Internet and phone', true, 3000), ('Other', true, null)) as c(name, receipt_required, max_per_claim);

-------------------------------------------------------------------------------
-- Row-Level Security and grants
-------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'pay_components', 'salary_structures', 'salary_structure_lines', 'employee_salaries', 'employee_salary_lines', 'statutory_settings',
    'payroll_runs', 'payroll_items', 'payroll_adjustments', 'expense_categories', 'expense_claims'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select, insert, update, delete on pay_components, salary_structures, salary_structure_lines, payroll_runs, payroll_items, payroll_adjustments,
  expense_categories, expense_claims to crew_app;
-- Salaries and statutory settings are history: a new row supersedes the old one and rows are never edited.
-- The API deletes a row only while no payroll run has used it (to correct a mistake).
grant select, insert, delete on employee_salaries, employee_salary_lines, statutory_settings to crew_app;
grant select, insert, update, delete on all tables in schema public to crew_platform;
grant usage on all sequences in schema public to crew_app, crew_platform;
