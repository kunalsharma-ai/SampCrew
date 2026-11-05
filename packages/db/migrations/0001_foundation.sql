-- CREW foundation schema: tenancy, identity, organisation, access control,
-- audit trail, outbox, billing catalogue and subscriptions.
--
-- Security model
--   crew_app      NOLOGIN, NOBYPASSRLS. All tenant traffic. Row-Level Security limits every row to app.tenant_id.
--   crew_platform NOLOGIN, BYPASSRLS. Authentication bootstrap and the SAMPLEDGE Super Admin Console only.
--   crew_api      LOGIN, NOINHERIT. The API's connection user. Holds no table privileges itself; every
--                 transaction must SET LOCAL ROLE to crew_app or crew_platform, so forgetting to do so fails closed.

create extension if not exists citext;
create extension if not exists pgcrypto;
create extension if not exists btree_gist;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'crew_app') then
    create role crew_app nologin nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'crew_platform') then
    create role crew_platform nologin bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'crew_api') then
    create role crew_api login noinherit;
  end if;
end $$;

grant crew_app to crew_api;
grant crew_platform to crew_api;
grant usage on schema public to crew_app, crew_platform;

-- Session context helpers used by RLS policies. Values are set with SET LOCAL inside each transaction.
create or replace function app_tenant_id() returns uuid
  language sql stable parallel safe
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create or replace function app_user_id() returns uuid
  language sql stable parallel safe
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-------------------------------------------------------------------------------
-- Tenancy and identity
-------------------------------------------------------------------------------

create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug citext not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' and length(slug) between 3 and 40),
  name text not null check (length(name) between 1 and 160),
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  status_reason text,
  region text not null default 'in' check (region in ('in', 'eu', 'us', 'uk', 'me', 'sg', 'au')),
  timezone text not null default 'UTC',
  currency char(3) not null default 'USD',
  locale text not null default 'en',
  country_code char(2),
  brand_color text check (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  require_mfa boolean not null default false,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger tenants_touch before update on tenants for each row execute function touch_updated_at();

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique check (position('@' in email) > 1),
  full_name text not null check (length(full_name) between 1 and 160),
  password_hash text,
  mfa_secret_enc text,
  mfa_enabled boolean not null default false,
  email_verified_at timestamptz,
  status text not null default 'active' check (status in ('active', 'locked', 'disabled')),
  failed_login_count int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger users_touch before update on users for each row execute function touch_updated_at();

-------------------------------------------------------------------------------
-- Organisation structure
-------------------------------------------------------------------------------

create table legal_entities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 160),
  legal_name text,
  country_code char(2) not null check (country_code ~ '^[A-Z]{2}$'),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  timezone text not null,
  registration_number text,
  tax_id text,
  fiscal_year_start_month smallint not null default 4 check (fiscal_year_start_month between 1 and 12),
  address text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create trigger legal_entities_touch before update on legal_entities for each row execute function touch_updated_at();

create table business_units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 160),
  code text,
  description text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create unique index business_units_code on business_units (tenant_id, lower(code)) where code is not null;
create trigger business_units_touch before update on business_units for each row execute function touch_updated_at();

create table locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  legal_entity_id uuid not null,
  name text not null check (length(name) between 1 and 160),
  code text,
  kind text not null default 'office' check (kind in ('office', 'branch', 'factory', 'warehouse', 'store', 'hospital', 'site', 'remote_hub')),
  timezone text not null,
  address_line text,
  city text,
  region text,
  country_code char(2) not null check (country_code ~ '^[A-Z]{2}$'),
  postal_code text,
  latitude numeric(9, 6) check (latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude between -180 and 180),
  geofence_radius_m int check (geofence_radius_m between 25 and 5000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name),
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id),
  check ((latitude is null) = (longitude is null)),
  check (geofence_radius_m is null or latitude is not null)
);
create unique index locations_code on locations (tenant_id, lower(code)) where code is not null;
create trigger locations_touch before update on locations for each row execute function touch_updated_at();

create table departments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  parent_id uuid,
  legal_entity_id uuid,
  business_unit_id uuid,
  name text not null check (length(name) between 1 and 160),
  code text,
  head_membership_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, parent_id) references departments (tenant_id, id),
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id),
  foreign key (tenant_id, business_unit_id) references business_units (tenant_id, id),
  check (parent_id is null or parent_id <> id)
);
create unique index departments_code on departments (tenant_id, lower(code)) where code is not null;
create unique index departments_name_per_parent on departments (tenant_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) where archived_at is null;
create index departments_parent on departments (tenant_id, parent_id);
create trigger departments_touch before update on departments for each row execute function touch_updated_at();

-- Prevent cycles in the department tree.
create or replace function departments_no_cycle() returns trigger language plpgsql as $$
begin
  if new.parent_id is null then return new; end if;
  if exists (
    with recursive chain(id, parent_id, depth) as (
      select d.id, d.parent_id, 1 from departments d where d.tenant_id = new.tenant_id and d.id = new.parent_id
      union all
      select d.id, d.parent_id, c.depth + 1 from departments d join chain c on d.id = c.parent_id
      where d.tenant_id = new.tenant_id and c.depth < 100
    )
    select 1 from chain where id = new.id
  ) then
    raise exception 'department hierarchy cycle' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger departments_cycle before insert or update of parent_id on departments for each row execute function departments_no_cycle();

-------------------------------------------------------------------------------
-- Memberships, roles and permissions
-------------------------------------------------------------------------------

create table memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  status text not null default 'active' check (status in ('invited', 'active', 'suspended')),
  legal_entity_id uuid,
  department_id uuid,
  location_id uuid,
  manager_membership_id uuid,
  employee_id uuid,
  title text,
  invited_by uuid,
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, user_id),
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id),
  foreign key (tenant_id, department_id) references departments (tenant_id, id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id),
  foreign key (tenant_id, manager_membership_id) references memberships (tenant_id, id),
  check (manager_membership_id is null or manager_membership_id <> id)
);
create index memberships_user on memberships (user_id);
create index memberships_manager on memberships (tenant_id, manager_membership_id);
create index memberships_department on memberships (tenant_id, department_id);
create trigger memberships_touch before update on memberships for each row execute function touch_updated_at();

alter table departments
  add constraint departments_head_fk foreign key (tenant_id, head_membership_id) references memberships (tenant_id, id);

-- Prevent cycles in the reporting line.
create or replace function memberships_no_manager_cycle() returns trigger language plpgsql as $$
begin
  if new.manager_membership_id is null then return new; end if;
  if exists (
    with recursive chain(id, manager_membership_id, depth) as (
      select m.id, m.manager_membership_id, 1 from memberships m where m.tenant_id = new.tenant_id and m.id = new.manager_membership_id
      union all
      select m.id, m.manager_membership_id, c.depth + 1 from memberships m join chain c on m.id = c.manager_membership_id
      where m.tenant_id = new.tenant_id and c.depth < 100
    )
    select 1 from chain where id = new.id
  ) then
    raise exception 'reporting line cycle' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger memberships_manager_cycle before insert or update of manager_membership_id on memberships for each row execute function memberships_no_manager_cycle();

create table roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{2,40}$'),
  name text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, key)
);
create trigger roles_touch before update on roles for each row execute function touch_updated_at();

create table role_permissions (
  tenant_id uuid not null references tenants(id) on delete cascade,
  role_id uuid not null,
  permission text not null check (permission ~ '^[a-z]+(:[a-z]+)+$'),
  scope text not null check (scope in ('own', 'team', 'department', 'entity', 'tenant')),
  primary key (role_id, permission),
  foreign key (tenant_id, role_id) references roles (tenant_id, id) on delete cascade
);

create table role_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  membership_id uuid not null,
  role_id uuid not null,
  constraints jsonb not null default '{}'::jsonb check (jsonb_typeof(constraints) = 'object'),
  granted_by uuid,
  created_at timestamptz not null default now(),
  unique (membership_id, role_id),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id) on delete cascade,
  foreign key (tenant_id, role_id) references roles (tenant_id, id) on delete cascade
);
create index role_assignments_role on role_assignments (tenant_id, role_id);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  membership_id uuid not null,
  email citext not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  invited_by uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id) on delete cascade
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  tenant_id uuid references tenants(id) on delete cascade,
  refresh_token_hash text not null unique,
  family_id uuid not null,
  mfa_verified boolean not null default false,
  client text not null default 'web' check (client in ('web', 'mobile', 'api')),
  ip inet,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text
);
create index sessions_user on sessions (user_id) where revoked_at is null;
create index sessions_family on sessions (family_id);

-------------------------------------------------------------------------------
-- Audit trail (append-only, hash-chained per tenant) and transactional outbox
-------------------------------------------------------------------------------

create table audit_events (
  id bigint generated always as identity primary key,
  tenant_id uuid references tenants(id) on delete restrict,
  chain_seq bigint not null,
  actor_type text not null check (actor_type in ('user', 'platform_admin', 'system', 'ai_agent', 'integration')),
  actor_id uuid,
  actor_label text,
  action text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  resource_type text not null,
  resource_id text,
  changes jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  ip inet,
  user_agent text,
  request_id text,
  created_at timestamptz not null default now(),
  prev_hash bytea,
  hash bytea not null
);
create unique index audit_events_chain on audit_events (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), chain_seq);
create index audit_events_tenant_time on audit_events (tenant_id, created_at desc);
create index audit_events_resource on audit_events (tenant_id, resource_type, resource_id);
create index audit_events_actor on audit_events (tenant_id, actor_id);

create or replace function audit_event_payload(e audit_events) returns bytea language sql immutable as $$
  select convert_to(concat_ws('|',
    coalesce(e.tenant_id::text, '-'), e.chain_seq::text, e.actor_type, coalesce(e.actor_id::text, '-'),
    e.action, e.resource_type, coalesce(e.resource_id, '-'), e.changes::text, e.metadata::text,
    to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'UTF8')
$$;

create or replace function audit_events_chain() returns trigger language plpgsql as $$
declare
  chain_key uuid := coalesce(new.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid);
  last_hash bytea;
  last_seq bigint;
begin
  -- Serialise appends per tenant so the chain stays linear.
  perform pg_advisory_xact_lock(hashtextextended('audit:' || chain_key::text, 0));
  select a.hash, a.chain_seq into last_hash, last_seq
    from audit_events a
   where coalesce(a.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) = chain_key
   order by a.chain_seq desc limit 1;
  new.chain_seq := coalesce(last_seq, 0) + 1;
  new.prev_hash := last_hash;
  new.created_at := clock_timestamp();
  new.hash := sha256(coalesce(last_hash, '\x'::bytea) || audit_event_payload(new));
  return new;
end $$;
create trigger audit_events_chain before insert on audit_events for each row execute function audit_events_chain();

create or replace function reject_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;
create trigger audit_events_immutable before update or delete on audit_events for each row execute function reject_mutation();

-- Recompute the chain for a tenant. Returns the first broken sequence number, or null if intact.
create or replace function audit_verify_chain(p_tenant uuid) returns table (checked bigint, first_broken_seq bigint)
  language plpgsql stable as $$
declare
  rec audit_events;
  expected_prev bytea := null;
  n bigint := 0;
begin
  for rec in
    select * from audit_events a
     where coalesce(a.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(p_tenant, '00000000-0000-0000-0000-000000000000'::uuid)
     order by a.chain_seq
  loop
    n := n + 1;
    if rec.chain_seq <> n
       or rec.prev_hash is distinct from expected_prev
       or rec.hash <> sha256(coalesce(expected_prev, '\x'::bytea) || audit_event_payload(rec)) then
      checked := n; first_broken_seq := rec.chain_seq; return next; return;
    end if;
    expected_prev := rec.hash;
  end loop;
  checked := n; first_broken_seq := null; return next;
end $$;

create table outbox_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  type text not null check (type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text,
  published_at timestamptz
);
create index outbox_pending on outbox_events (available_at) where published_at is null;

create table idempotency_keys (
  tenant_id uuid not null references tenants(id) on delete cascade,
  key text not null check (length(key) between 8 and 128),
  actor_id uuid not null,
  request_hash text not null,
  response_status int,
  response_body jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_id, key)
);

-------------------------------------------------------------------------------
-- Billing catalogue (global) and tenant subscriptions
-------------------------------------------------------------------------------

create table features (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  module text not null,
  kind text not null check (kind in ('boolean', 'limit')),
  unit text
);

create table plans (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  tagline text,
  sort_order int not null default 0,
  minimum_seats int not null default 1 check (minimum_seats >= 1),
  quote_only boolean not null default false,
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger plans_touch before update on plans for each row execute function touch_updated_at();

create table plan_prices (
  plan_id uuid not null references plans(id) on delete cascade,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  monthly_per_seat numeric(12, 2) not null check (monthly_per_seat >= 0),
  annual_per_seat_month numeric(12, 2) not null check (annual_per_seat_month >= 0),
  primary key (plan_id, currency)
);

create table plan_features (
  plan_id uuid not null references plans(id) on delete cascade,
  feature_key text not null references features(key),
  limit_value int,
  primary key (plan_id, feature_key)
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references tenants(id) on delete cascade,
  plan_id uuid not null references plans(id),
  status text not null check (status in ('trialing', 'active', 'past_due', 'cancelled', 'suspended')),
  billing_cycle text not null check (billing_cycle in ('monthly', 'annual')),
  currency char(3) not null,
  seats int not null check (seats >= 1),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  trial_ends_on date,
  current_period_start date not null,
  current_period_end date not null,
  cancel_at_period_end boolean not null default false,
  provider text not null default 'manual' check (provider in ('manual', 'stripe', 'razorpay')),
  provider_ref text,
  feature_overrides jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (current_period_end > current_period_start)
);
create trigger subscriptions_touch before update on subscriptions for each row execute function touch_updated_at();

create table invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  number text not null unique,
  status text not null check (status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
  currency char(3) not null,
  subtotal numeric(14, 2) not null,
  tax numeric(14, 2) not null default 0,
  total numeric(14, 2) not null,
  period_start date not null,
  period_end date not null,
  issued_at timestamptz,
  due_at timestamptz,
  paid_at timestamptz,
  provider_ref text,
  created_at timestamptz not null default now(),
  check (total = subtotal + tax)
);
create index invoices_tenant on invoices (tenant_id, created_at desc);

create table invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  description text not null,
  quantity numeric(14, 4) not null,
  unit_amount numeric(14, 4) not null,
  amount numeric(14, 2) not null
);

create table usage_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  metric text not null check (metric in ('ai_credits', 'storage_bytes', 'api_calls', 'active_employees', 'sms', 'whatsapp')),
  quantity numeric(18, 4) not null,
  source text,
  occurred_at timestamptz not null default now()
);
create index usage_records_tenant on usage_records (tenant_id, metric, occurred_at desc);

-------------------------------------------------------------------------------
-- SAMPLEDGE platform administration (separate realm)
-------------------------------------------------------------------------------

create table platform_admins (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  full_name text not null,
  password_hash text not null,
  role text not null check (role in ('super_admin', 'support', 'billing_ops', 'viewer')),
  mfa_secret_enc text,
  mfa_enabled boolean not null default false,
  status text not null default 'active' check (status in ('active', 'disabled')),
  failed_login_count int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger platform_admins_touch before update on platform_admins for each row execute function touch_updated_at();

create table platform_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references platform_admins(id) on delete cascade,
  refresh_token_hash text not null unique,
  mfa_verified boolean not null default false,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table support_access_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  platform_admin_id uuid not null references platform_admins(id),
  reason text not null,
  duration_minutes int not null check (duration_minutes between 15 and 480),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'revoked', 'expired')),
  decided_by uuid,
  decided_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index support_access_tenant on support_access_grants (tenant_id, created_at desc);

-------------------------------------------------------------------------------
-- Row-Level Security
-------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'legal_entities', 'business_units', 'locations', 'departments', 'roles', 'role_permissions',
    'role_assignments', 'invitations', 'idempotency_keys', 'subscriptions', 'invoices', 'invoice_lines',
    'usage_records', 'support_access_grants'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

-- Memberships: tenant-scoped. Outside a tenant (pre-selection flows run with only app.user_id set) a user
-- may list their own memberships for the workspace switcher. Once a tenant is set, other tenants are invisible.
alter table memberships enable row level security;
alter table memberships force row level security;
create policy tenant_isolation on memberships
  using (tenant_id = app_tenant_id() or (app_tenant_id() is null and user_id = app_user_id()))
  with check (tenant_id = app_tenant_id());

-- Tenants: the current tenant; outside a tenant, the tenants the user belongs to (for the workspace switcher).
alter table tenants enable row level security;
alter table tenants force row level security;
create policy tenant_read on tenants for select
  using (id = app_tenant_id() or (app_tenant_id() is null and exists (
    select 1 from memberships m where m.tenant_id = tenants.id and m.user_id = app_user_id() and m.status = 'active')));
create policy tenant_update on tenants for update using (id = app_tenant_id()) with check (id = app_tenant_id());

-- Users: yourself, plus people who share the current tenant.
alter table users enable row level security;
alter table users force row level security;
create policy user_visibility on users for select
  using (id = app_user_id() or exists (select 1 from memberships m where m.user_id = users.id and m.tenant_id = app_tenant_id()));
create policy user_self_update on users for update using (id = app_user_id()) with check (id = app_user_id());

-- Audit: tenant-scoped reads and inserts only (no update/delete grants, plus the immutability trigger).
alter table audit_events enable row level security;
alter table audit_events force row level security;
create policy audit_read on audit_events for select using (tenant_id = app_tenant_id());
create policy audit_insert on audit_events for insert with check (tenant_id = app_tenant_id());

alter table outbox_events enable row level security;
alter table outbox_events force row level security;
create policy outbox_insert on outbox_events for insert with check (tenant_id = app_tenant_id());

-- Sessions are managed only through the platform role by the auth service.
alter table sessions enable row level security;
alter table sessions force row level security;

-------------------------------------------------------------------------------
-- Grants
-------------------------------------------------------------------------------

grant select, insert, update, delete on legal_entities, business_units, locations, departments, memberships,
  roles, role_permissions, role_assignments, invitations, idempotency_keys, subscriptions to crew_app;
grant select on invoices, invoice_lines, usage_records, support_access_grants to crew_app;
grant insert on usage_records to crew_app;
grant update (status, decided_by, decided_at, expires_at) on support_access_grants to crew_app;
grant select, insert on audit_events, outbox_events to crew_app;
grant select (id, slug, name, status, region, timezone, currency, locale, country_code, brand_color, require_mfa, is_demo, created_at) on tenants to crew_app;
grant update (name, timezone, currency, locale, brand_color, require_mfa) on tenants to crew_app;
-- No password hash or MFA secret for the tenant role.
grant select (id, email, full_name, mfa_enabled, status, last_login_at, created_at) on users to crew_app;
grant update (full_name) on users to crew_app;
grant select on features, plans, plan_prices, plan_features to crew_app;
grant execute on function audit_verify_chain(uuid) to crew_app;

grant select, insert, update, delete on all tables in schema public to crew_platform;
revoke update, delete on audit_events from crew_platform;
grant usage on all sequences in schema public to crew_app, crew_platform;
