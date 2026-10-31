-- Phase 2: Core HR
-- Employees with effective-dated employment history, lifecycle events, protected personal data, the shared
-- approvals engine, leave (types, policies, an append-only balance ledger, holidays, requests), onboarding
-- checklists, employee documents, in-app notifications and outgoing email.

-------------------------------------------------------------------------------
-- Employees
-------------------------------------------------------------------------------

create table designations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  code text,
  level smallint check (level between 0 and 100),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index designations_name on designations (tenant_id, lower(name)) where archived_at is null;
create trigger designations_touch before update on designations for each row execute function touch_updated_at();

-- Employee numbers come from a per-tenant series (prefix + zero-padded counter), allocated under a row lock.
create table employee_number_series (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  prefix text not null default 'EMP' check (prefix ~ '^[A-Z0-9-]{0,10}$'),
  padding smallint not null default 4 check (padding between 1 and 10),
  next_value integer not null default 1 check (next_value > 0)
);

create table employees (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_code text not null check (length(employee_code) between 1 and 40),
  first_name text not null check (length(first_name) between 1 and 80),
  last_name text not null default '' check (length(last_name) <= 80),
  preferred_name text,
  work_email citext,
  personal_email citext,
  phone text,
  date_of_birth date,
  gender text check (gender in ('female', 'male', 'non_binary', 'undisclosed')),
  date_of_joining date not null,
  probation_end_date date,
  confirmation_date date,
  employment_type text not null default 'full_time' check (employment_type in ('full_time', 'part_time', 'contract', 'intern', 'temporary')),
  status text not null default 'active' check (status in ('pre_boarding', 'probation', 'active', 'notice', 'exited')),
  resignation_date date,
  last_working_day date,
  exit_type text check (exit_type in ('resignation', 'termination', 'retirement', 'contract_end', 'other')),
  exit_reason text,
  -- Current placement, derived from the employment record in effect today (see employees_apply_current).
  current_legal_entity_id uuid,
  current_department_id uuid,
  current_location_id uuid,
  current_designation_id uuid,
  current_manager_employee_id uuid,
  current_grade text,
  membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, employee_code),
  unique (tenant_id, membership_id),
  foreign key (tenant_id, current_legal_entity_id) references legal_entities (tenant_id, id),
  foreign key (tenant_id, current_department_id) references departments (tenant_id, id),
  foreign key (tenant_id, current_location_id) references locations (tenant_id, id),
  foreign key (tenant_id, current_designation_id) references designations (tenant_id, id),
  foreign key (tenant_id, current_manager_employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id),
  check (current_manager_employee_id is null or current_manager_employee_id <> id),
  check (probation_end_date is null or probation_end_date >= date_of_joining),
  check (last_working_day is null or last_working_day >= date_of_joining)
);
create unique index employees_work_email on employees (tenant_id, work_email) where work_email is not null and status <> 'exited';
create index employees_manager on employees (tenant_id, current_manager_employee_id);
create index employees_department on employees (tenant_id, current_department_id);
create index employees_name on employees (tenant_id, lower(first_name || ' ' || last_name));
create trigger employees_touch before update on employees for each row execute function touch_updated_at();

alter table memberships
  add constraint memberships_employee_fk foreign key (tenant_id, employee_id) references employees (tenant_id, id);

create or replace function employees_no_manager_cycle() returns trigger language plpgsql as $$
begin
  if new.current_manager_employee_id is null then return new; end if;
  if exists (
    with recursive chain(id, manager_id, depth) as (
      select e.id, e.current_manager_employee_id, 1 from employees e where e.tenant_id = new.tenant_id and e.id = new.current_manager_employee_id
      union all
      select e.id, e.current_manager_employee_id, c.depth + 1 from employees e join chain c on e.id = c.manager_id
      where e.tenant_id = new.tenant_id and c.depth < 100
    )
    select 1 from chain where id = new.id
  ) then
    raise exception 'reporting line cycle' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger employees_manager_cycle before insert or update of current_manager_employee_id on employees
  for each row execute function employees_no_manager_cycle();

-- An employee's current placement is the single source of truth. When the employee has a login, their
-- membership (which drives access scopes) follows it, including the manager's membership.
create or replace function employees_sync_membership() returns trigger language plpgsql as $$
begin
  if new.membership_id is null then return new; end if;
  update memberships m set
    legal_entity_id = new.current_legal_entity_id,
    department_id = new.current_department_id,
    location_id = new.current_location_id,
    manager_membership_id = (select mgr.membership_id from employees mgr where mgr.tenant_id = new.tenant_id and mgr.id = new.current_manager_employee_id),
    title = coalesce((select d.name from designations d where d.tenant_id = new.tenant_id and d.id = new.current_designation_id), m.title),
    employee_id = new.id
  where m.tenant_id = new.tenant_id and m.id = new.membership_id;
  -- People who report to this employee follow their manager's membership too.
  if tg_op = 'UPDATE' and new.membership_id is distinct from old.membership_id then
    update memberships m set manager_membership_id = new.membership_id
      from employees r where r.tenant_id = new.tenant_id and r.current_manager_employee_id = new.id and m.id = r.membership_id;
  end if;
  return new;
end $$;
create trigger employees_membership_sync after insert or update of current_legal_entity_id, current_department_id, current_location_id,
  current_designation_id, current_manager_employee_id, membership_id on employees
  for each row execute function employees_sync_membership();

-- Bank, tax and national identifiers, encrypted by the API (AES-256-GCM) before they reach the database.
create table employee_sensitive (
  employee_id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  bank_name text,
  bank_account_enc text,
  bank_routing_enc text,
  tax_id_enc text,
  national_id_enc text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade
);

-- Effective-dated job history. Rows never overlap for one employee; a future-dated row takes effect on its date.
create table employment_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  effective_from date not null,
  effective_to date,
  legal_entity_id uuid not null,
  department_id uuid,
  location_id uuid,
  designation_id uuid,
  manager_employee_id uuid,
  grade text,
  employment_type text not null check (employment_type in ('full_time', 'part_time', 'contract', 'intern', 'temporary')),
  change_reason text not null check (change_reason in ('hire', 'transfer', 'promotion', 'manager_change', 'correction', 'rehire', 'other')),
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id),
  foreign key (tenant_id, department_id) references departments (tenant_id, id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id),
  foreign key (tenant_id, designation_id) references designations (tenant_id, id),
  foreign key (tenant_id, manager_employee_id) references employees (tenant_id, id),
  check (effective_to is null or effective_to >= effective_from),
  exclude using gist (tenant_id with =, employee_id with =, daterange(effective_from, effective_to, '[]') with &&)
);
create index employment_records_employee on employment_records (tenant_id, employee_id, effective_from desc);

-- Copies the record in effect on p_on into each employee's current placement. Idempotent; run on every change
-- and daily so future-dated transfers take effect without anyone touching the record.
create or replace function employees_apply_current(p_on date default current_date) returns integer language plpgsql as $$
declare n integer;
begin
  with due as (
    select distinct on (r.employee_id) r.*
      from employment_records r
     where r.tenant_id = app_tenant_id() and r.effective_from <= p_on and (r.effective_to is null or r.effective_to >= p_on)
     order by r.employee_id, r.effective_from desc
  )
  update employees e set
    current_legal_entity_id = due.legal_entity_id,
    current_department_id = due.department_id,
    current_location_id = due.location_id,
    current_designation_id = due.designation_id,
    current_manager_employee_id = due.manager_employee_id,
    current_grade = due.grade,
    employment_type = due.employment_type
  from due
  where e.tenant_id = app_tenant_id() and e.id = due.employee_id and (
    e.current_legal_entity_id is distinct from due.legal_entity_id or e.current_department_id is distinct from due.department_id or
    e.current_location_id is distinct from due.location_id or e.current_designation_id is distinct from due.designation_id or
    e.current_manager_employee_id is distinct from due.manager_employee_id or e.current_grade is distinct from due.grade or
    e.employment_type is distinct from due.employment_type
  );
  get diagnostics n = row_count;
  return n;
end $$;

-- What happened to an employee and when. Append-only, like the audit trail.
create table lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  kind text not null check (kind in ('hired', 'confirmed', 'probation_extended', 'transferred', 'promoted', 'manager_changed',
                                     'resigned', 'exit_scheduled', 'exit_withdrawn', 'exited', 'rehired', 'linked_login')),
  effective_on date not null,
  details jsonb not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade
);
create index lifecycle_events_employee on lifecycle_events (tenant_id, employee_id, effective_on desc, created_at desc);
create trigger lifecycle_events_immutable before update or delete on lifecycle_events for each row execute function reject_mutation();

-------------------------------------------------------------------------------
-- Approvals engine (shared by leave now; attendance, recruitment, payroll and AI actions later)
-------------------------------------------------------------------------------

create table approval_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  resource_type text not null check (resource_type ~ '^[a-z_]+$'),
  -- Ordered steps, e.g. [{"type":"manager"},{"type":"role","role":"hr_manager"}]
  steps jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 5),
  updated_at timestamptz not null default now(),
  unique (tenant_id, resource_type)
);
create trigger approval_policies_touch before update on approval_policies for each row execute function touch_updated_at();

create table approval_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  resource_type text not null,
  resource_id uuid not null,
  subject_employee_id uuid,
  requested_by_membership_id uuid,
  summary text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, subject_employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, requested_by_membership_id) references memberships (tenant_id, id)
);
create index approval_requests_resource on approval_requests (tenant_id, resource_type, resource_id);

create table approval_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  request_id uuid not null,
  seq smallint not null,
  kind text not null check (kind in ('manager', 'skip_level_manager', 'role')),
  approver_membership_id uuid,
  approver_role_key text,
  status text not null check (status in ('waiting', 'pending', 'approved', 'rejected', 'skipped', 'cancelled')),
  decided_by_membership_id uuid,
  decided_at timestamptz,
  comment text check (length(comment) <= 1000),
  unique (tenant_id, request_id, seq),
  foreign key (tenant_id, request_id) references approval_requests (tenant_id, id) on delete cascade,
  foreign key (tenant_id, approver_membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, decided_by_membership_id) references memberships (tenant_id, id),
  check (approver_membership_id is not null or approver_role_key is not null)
);
create index approval_steps_inbox on approval_steps (tenant_id, approver_membership_id) where status = 'pending';
create index approval_steps_role_inbox on approval_steps (tenant_id, approver_role_key) where status = 'pending';

-------------------------------------------------------------------------------
-- Leave
-------------------------------------------------------------------------------

create table leave_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_]{1,12}$'),
  name text not null check (length(name) between 1 and 80),
  description text,
  paid boolean not null default true,
  allow_half_day boolean not null default true,
  color text not null default '#4f46e5' check (color ~ '^#[0-9a-fA-F]{6}$'),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);
create trigger leave_types_touch before update on leave_types for each row execute function touch_updated_at();

-- Who gets how much of a leave type. A policy for a legal entity overrides the tenant-wide one (legal_entity_id null).
create table leave_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  leave_type_id uuid not null,
  legal_entity_id uuid,
  accrual_method text not null check (accrual_method in ('annual_upfront', 'monthly', 'none')),
  annual_entitlement numeric(6, 2) not null default 0 check (annual_entitlement between 0 and 365),
  carry_forward_max numeric(6, 2) not null default 0 check (carry_forward_max >= 0),
  allow_negative_balance boolean not null default false,
  min_notice_days smallint not null default 0 check (min_notice_days between 0 and 365),
  max_consecutive_days numeric(6, 2) check (max_consecutive_days > 0),
  available_during_probation boolean not null default true,
  rounding text not null default 'half_day' check (rounding in ('none', 'half_day')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, leave_type_id) references leave_types (tenant_id, id),
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id)
);
create unique index leave_policies_one_active on leave_policies (tenant_id, leave_type_id, coalesce(legal_entity_id, '00000000-0000-0000-0000-000000000000'::uuid)) where active;
create trigger leave_policies_touch before update on leave_policies for each row execute function touch_updated_at();

-- Every change to a balance is a signed ledger row; the balance is their sum. Rows are never edited:
-- corrections are new 'adjustment' or 'reversal' rows, so any balance can be explained line by line.
create table leave_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  leave_type_id uuid not null,
  leave_year smallint not null check (leave_year between 2000 and 2200),
  kind text not null check (kind in ('accrual', 'carry_forward', 'lapse', 'adjustment', 'taken', 'reversal')),
  quantity numeric(6, 2) not null check (quantity <> 0),
  effective_on date not null,
  leave_request_id uuid,
  -- Makes scheduled accruals idempotent: one row per employee, type and accrual period.
  accrual_key text,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, leave_type_id) references leave_types (tenant_id, id)
);
create unique index leave_ledger_accrual_once on leave_ledger (tenant_id, employee_id, leave_type_id, accrual_key) where accrual_key is not null;
create index leave_ledger_balance on leave_ledger (tenant_id, employee_id, leave_type_id, leave_year);
create trigger leave_ledger_immutable before update or delete on leave_ledger for each row execute function reject_mutation();

create table holiday_calendars (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  -- Applies to a location, else to a legal entity, else is the tenant default.
  legal_entity_id uuid,
  location_id uuid,
  is_default boolean not null default false,
  -- Days of week that are not working days (0 = Sunday ... 6 = Saturday).
  weekly_offs smallint[] not null default '{0,6}' check (weekly_offs <@ array[0,1,2,3,4,5,6]::smallint[]),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id)
);
create unique index holiday_calendars_one_default on holiday_calendars (tenant_id) where is_default;
create trigger holiday_calendars_touch before update on holiday_calendars for each row execute function touch_updated_at();

create table holidays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  calendar_id uuid not null,
  holiday_date date not null,
  name text not null check (length(name) between 1 and 120),
  is_optional boolean not null default false,
  unique (tenant_id, calendar_id, holiday_date),
  foreign key (tenant_id, calendar_id) references holiday_calendars (tenant_id, id) on delete cascade
);

create table leave_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  leave_type_id uuid not null,
  start_date date not null,
  end_date date not null,
  start_half text not null default 'full' check (start_half in ('full', 'second_half')),
  end_half text not null default 'full' check (end_half in ('full', 'first_half')),
  days numeric(6, 2) not null check (days > 0),
  reason text check (length(reason) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  approval_request_id uuid,
  requested_by_membership_id uuid,
  decided_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, leave_type_id) references leave_types (tenant_id, id),
  foreign key (tenant_id, approval_request_id) references approval_requests (tenant_id, id),
  check (end_date >= start_date),
  check (start_date < end_date or (start_half = 'full' or end_half = 'full')),
  -- One person cannot hold two live requests on the same day.
  exclude using gist (tenant_id with =, employee_id with =, daterange(start_date, end_date, '[]') with &&) where (status in ('pending', 'approved'))
);
create index leave_requests_employee on leave_requests (tenant_id, employee_id, start_date desc);
create trigger leave_requests_touch before update on leave_requests for each row execute function touch_updated_at();

alter table leave_ledger
  add constraint leave_ledger_request_fk foreign key (tenant_id, leave_request_id) references leave_requests (tenant_id, id);

-------------------------------------------------------------------------------
-- Onboarding
-------------------------------------------------------------------------------

create table onboarding_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  description text,
  -- [{"title": "...", "description": "...", "owner": "hr|manager|employee|it", "dueOffsetDays": 0}]
  tasks jsonb not null check (jsonb_typeof(tasks) = 'array' and jsonb_array_length(tasks) between 1 and 60),
  is_default boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index onboarding_templates_one_default on onboarding_templates (tenant_id) where is_default and archived_at is null;
create trigger onboarding_templates_touch before update on onboarding_templates for each row execute function touch_updated_at();

create table onboarding_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  template_id uuid,
  title text not null check (length(title) between 1 and 200),
  description text,
  owner text not null check (owner in ('hr', 'manager', 'employee', 'it')),
  assignee_membership_id uuid,
  due_on date,
  status text not null default 'open' check (status in ('open', 'done', 'skipped')),
  completed_by_membership_id uuid,
  completed_at timestamptz,
  sort smallint not null default 0,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, template_id) references onboarding_templates (tenant_id, id),
  foreign key (tenant_id, assignee_membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, completed_by_membership_id) references memberships (tenant_id, id)
);
create index onboarding_tasks_employee on onboarding_tasks (tenant_id, employee_id, sort);
create index onboarding_tasks_assignee on onboarding_tasks (tenant_id, assignee_membership_id) where status = 'open';

-------------------------------------------------------------------------------
-- Documents
-------------------------------------------------------------------------------

create table employee_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  category text not null check (category in ('id_proof', 'address_proof', 'contract', 'offer_letter', 'policy', 'certificate', 'tax', 'other')),
  title text not null check (length(title) between 1 and 200),
  file_name text not null,
  content_type text not null,
  size_bytes integer not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text not null,
  -- 'employee': the employee and authorised HR can see it. 'hr_only': only people who manage documents.
  visibility text not null default 'employee' check (visibility in ('employee', 'hr_only')),
  uploaded_by_membership_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (storage_key),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade
);
create index employee_documents_employee on employee_documents (tenant_id, employee_id, created_at desc);

-------------------------------------------------------------------------------
-- Notifications and email
-------------------------------------------------------------------------------

create table notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  membership_id uuid not null,
  kind text not null,
  title text not null,
  body text,
  link text check (link is null or link ~ '^/'),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id) on delete cascade
);
create index notifications_inbox on notifications (tenant_id, membership_id, created_at desc);

-- Outgoing email, written in the same transaction as the change that causes it and sent by the dispatcher.
create table email_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  to_email citext not null,
  subject text not null,
  text_body text not null,
  template text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  attempts smallint not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index email_messages_queue on email_messages (next_attempt_at) where status = 'queued';

-------------------------------------------------------------------------------
-- Row-Level Security and grants
-------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'designations', 'employee_number_series', 'employees', 'employee_sensitive', 'employment_records', 'lifecycle_events',
    'approval_policies', 'approval_requests', 'approval_steps', 'leave_types', 'leave_policies', 'leave_ledger',
    'holiday_calendars', 'holidays', 'leave_requests', 'onboarding_templates', 'onboarding_tasks', 'employee_documents',
    'notifications'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

alter table email_messages enable row level security;
alter table email_messages force row level security;
create policy email_insert on email_messages for insert with check (tenant_id = app_tenant_id());

grant select, insert, update, delete on designations, employees, employee_sensitive, employment_records, approval_policies,
  approval_requests, approval_steps, leave_types, leave_policies, holiday_calendars, holidays, leave_requests,
  onboarding_templates, onboarding_tasks, employee_documents, notifications to crew_app;
grant select, insert, update on employee_number_series to crew_app;
grant select, insert on lifecycle_events, leave_ledger to crew_app;
grant insert on email_messages to crew_app;
grant execute on function employees_apply_current(date) to crew_app;
grant select, insert, update, delete on all tables in schema public to crew_platform;
grant usage on all sequences in schema public to crew_app, crew_platform;

-- The owner role is shown as "Workspace Owner" (the internal key stays tenant_owner).
update roles set name = 'Workspace Owner' where key = 'tenant_owner' and is_system and name = 'Tenant Owner';
