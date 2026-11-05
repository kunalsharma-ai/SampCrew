-- Phase 7: HR helpdesk (cases, categories with handlers and response targets, help articles), announcements
-- with read receipts, and the mobile app's devices, push messages and offline punches. Case messages and case
-- history are insert-only.

-------------------------------------------------------------------------------
-- Helpdesk
-------------------------------------------------------------------------------

create table helpdesk_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 2 and 80),
  description text not null default '' check (length(description) <= 500),
  -- Confidential cases are visible only to the category's handlers and the person who raised them.
  confidential boolean not null default false,
  first_response_hours smallint check (first_response_hours between 1 and 2160),
  resolution_hours smallint check (resolution_hours between 1 and 2160),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (first_response_hours is null or resolution_hours is null or resolution_hours >= first_response_hours)
);
create unique index helpdesk_categories_name on helpdesk_categories (tenant_id, lower(name)) where archived_at is null;
create trigger helpdesk_categories_touch before update on helpdesk_categories for each row execute function touch_updated_at();

create table helpdesk_category_handlers (
  tenant_id uuid not null references tenants(id) on delete cascade,
  category_id uuid not null,
  membership_id uuid not null,
  position smallint not null,
  primary key (category_id, membership_id),
  foreign key (tenant_id, category_id) references helpdesk_categories (tenant_id, id) on delete cascade,
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id) on delete cascade
);

create table helpdesk_articles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  category_id uuid,
  title text not null check (length(title) between 3 and 200),
  body text not null check (length(body) between 10 and 20000),
  published boolean not null default true,
  updated_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, category_id) references helpdesk_categories (tenant_id, id),
  foreign key (tenant_id, updated_by_membership_id) references memberships (tenant_id, id)
);
create trigger helpdesk_articles_touch before update on helpdesk_articles for each row execute function touch_updated_at();

-- Case numbers run per workspace (HR-0001, HR-0002, ...).
create table helpdesk_counters (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  last_number integer not null default 0
);

create table helpdesk_cases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  number integer not null,
  -- The person the case is about, and who raised it (the same person, or a handler logging a call).
  employee_id uuid not null,
  requester_membership_id uuid,
  raised_by_membership_id uuid not null,
  category_id uuid not null,
  -- Copied from the category when the case is raised or moved.
  confidential boolean not null,
  subject text not null check (length(subject) between 3 and 200),
  description text not null check (length(description) between 10 and 5000),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting_on_employee', 'resolved', 'closed')),
  assignee_membership_id uuid,
  first_response_due_at timestamptz,
  resolution_due_at timestamptz,
  first_responded_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  reopened_count smallint not null default 0,
  satisfaction smallint check (satisfaction between 1 and 5),
  satisfaction_comment text check (length(satisfaction_comment) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, requester_membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, raised_by_membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, category_id) references helpdesk_categories (tenant_id, id),
  foreign key (tenant_id, assignee_membership_id) references memberships (tenant_id, id)
);
create index helpdesk_cases_queue on helpdesk_cases (tenant_id, status, created_at desc);
create index helpdesk_cases_employee on helpdesk_cases (tenant_id, employee_id, created_at desc);
create index helpdesk_cases_assignee on helpdesk_cases (tenant_id, assignee_membership_id) where status not in ('resolved', 'closed');
create trigger helpdesk_cases_touch before update on helpdesk_cases for each row execute function touch_updated_at();

-- A closed case is final: nothing about it changes, and it cannot be deleted.
create or replace function helpdesk_cases_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'helpdesk cases cannot be deleted' using errcode = 'P0001';
  end if;
  if old.status = 'closed' then
    raise exception 'closed helpdesk cases cannot be changed' using errcode = 'P0001';
  end if;
  if new.number <> old.number or new.employee_id <> old.employee_id or new.raised_by_membership_id <> old.raised_by_membership_id
     or new.description <> old.description or new.created_at <> old.created_at then
    raise exception 'the original request of a helpdesk case cannot be changed' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger helpdesk_cases_guard before update or delete on helpdesk_cases for each row execute function helpdesk_cases_guard();

-- Insert-only conversation. Internal notes are visible to handlers only.
create table helpdesk_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null,
  author_membership_id uuid not null,
  body text not null check (length(body) between 1 and 5000),
  internal boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, case_id) references helpdesk_cases (tenant_id, id) on delete cascade,
  foreign key (tenant_id, author_membership_id) references memberships (tenant_id, id)
);
create index helpdesk_messages_case on helpdesk_messages (tenant_id, case_id, created_at);

-- Insert-only history of status, assignment, priority and category changes.
create table helpdesk_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null,
  -- Null for changes made by CREW itself, such as closing a resolved case after 7 days.
  by_membership_id uuid,
  action text not null check (action in ('created', 'status', 'assigned', 'priority', 'category', 'rated')),
  from_value text,
  to_value text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, case_id) references helpdesk_cases (tenant_id, id) on delete cascade,
  foreign key (tenant_id, by_membership_id) references memberships (tenant_id, id)
);
create index helpdesk_events_case on helpdesk_events (tenant_id, case_id, created_at);

-------------------------------------------------------------------------------
-- Announcements
-------------------------------------------------------------------------------

create table announcements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null check (length(title) between 3 and 200),
  body text not null check (length(body) between 1 and 10000),
  -- Audience; all empty means everyone in the workspace. A department includes its sub-departments.
  legal_entity_id uuid,
  department_id uuid,
  location_id uuid,
  requires_ack boolean not null default false,
  pinned boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_at timestamptz,
  published_by_membership_id uuid,
  expires_on date,
  created_by_membership_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id),
  foreign key (tenant_id, department_id) references departments (tenant_id, id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id),
  foreign key (tenant_id, published_by_membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id)
);
create index announcements_feed on announcements (tenant_id, status, published_at desc);
create trigger announcements_touch before update on announcements for each row execute function touch_updated_at();

-- What people acknowledged must not change under them: once published, the wording and audience are fixed.
create or replace function announcements_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' or pg_trigger_depth() > 1 then return old; end if;
    raise exception 'published announcements cannot be deleted; archive them instead' using errcode = 'P0001';
  end if;
  if old.status <> 'draft' and (new.title <> old.title or new.body <> old.body or new.requires_ack <> old.requires_ack
     or new.legal_entity_id is distinct from old.legal_entity_id or new.department_id is distinct from old.department_id
     or new.location_id is distinct from old.location_id or new.published_at is distinct from old.published_at) then
    raise exception 'a published announcement cannot be reworded or readdressed' using errcode = 'P0001';
  end if;
  if old.status = 'archived' and new.status <> 'archived' then
    raise exception 'archived announcements cannot be republished' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger announcements_guard before update or delete on announcements for each row execute function announcements_guard();

create table announcement_receipts (
  tenant_id uuid not null references tenants(id) on delete cascade,
  announcement_id uuid not null,
  membership_id uuid not null,
  read_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  primary key (announcement_id, membership_id),
  foreign key (tenant_id, announcement_id) references announcements (tenant_id, id) on delete cascade,
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id) on delete cascade
);

-- An acknowledgement, once given, stays.
create or replace function announcement_receipts_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'announcement receipts cannot be deleted' using errcode = 'P0001';
  end if;
  if old.acknowledged_at is not null and new.acknowledged_at is distinct from old.acknowledged_at then
    raise exception 'an acknowledgement cannot be changed' using errcode = 'P0001';
  end if;
  if new.read_at <> old.read_at then
    raise exception 'the first read time cannot be changed' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger announcement_receipts_guard before update or delete on announcement_receipts for each row execute function announcement_receipts_guard();

-------------------------------------------------------------------------------
-- Mobile devices, push and offline punches
-------------------------------------------------------------------------------

create table mobile_devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  membership_id uuid not null,
  installation_id text not null check (length(installation_id) between 16 and 80),
  platform text not null check (platform in ('ios', 'android', 'web')),
  app_version text not null default '' check (length(app_version) <= 20),
  model text not null default '' check (length(model) <= 80),
  os_version text not null default '' check (length(os_version) <= 40),
  -- The sign-in that registered the device; signing the device out revokes this whole session family.
  session_family_id uuid,
  push_token text check (length(push_token) <= 250),
  push_token_updated_at timestamptz,
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_sync_at timestamptz,
  revoked_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, membership_id, installation_id),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id) on delete cascade
);
create index mobile_devices_push on mobile_devices (tenant_id, membership_id) where push_token is not null and revoked_at is null;

-- Push copies of in-app notifications. They carry no personal data: the phone shows a generic text and opens
-- the notification inside the app. Delivered by the API's push dispatcher with the platform role.
create table push_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  mobile_device_id uuid not null,
  notification_id uuid not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  attempts smallint not null default 0,
  ticket_id text,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, mobile_device_id) references mobile_devices (tenant_id, id) on delete cascade
);
create index push_messages_queue on push_messages (next_attempt_at) where status = 'queued';

alter table attendance_events add column mobile_device_id uuid;
alter table attendance_events add column risk_flags text[] not null default '{}'
  check (risk_flags <@ array['offline', 'clock_changed', 'clock_unverified', 'mock_location']::text[]);
alter table attendance_events add constraint attendance_events_mobile_device
  foreign key (tenant_id, mobile_device_id) references mobile_devices (tenant_id, id);
create index attendance_events_flagged on attendance_events (tenant_id, captured_at desc) where risk_flags <> '{}';

-------------------------------------------------------------------------------
-- Seed data for existing workspaces and permissions
-------------------------------------------------------------------------------

insert into helpdesk_categories (tenant_id, name, description, confidential, first_response_hours, resolution_hours)
select t.id, c.name, c.description, false, c.fr, c.res
from tenants t
cross join (values
  ('Pay and payslips', 'Questions about salary, deductions, payslips and reimbursements.', 24, 72),
  ('Leave and attendance', 'Balances, holidays, punches and corrections.', 24, 72),
  ('Documents and letters', 'Employment letters, address proofs and other documents.', 24, 120),
  ('IT and access', 'Accounts, devices and access to systems.', 8, 48),
  ('Something else', 'Anything that does not fit the other categories.', 48, 168)
) as c(name, description, fr, res);

insert into role_permissions (tenant_id, role_id, permission, scope)
select r.tenant_id, r.id, g.permission, g.scope
from roles r
join (values
  ('tenant_owner', 'helpdesk:configure', 'tenant'), ('tenant_owner', 'announcements:manage', 'tenant'),
  ('hr_admin', 'helpdesk:configure', 'tenant'), ('hr_admin', 'announcements:manage', 'tenant'),
  ('hr_manager', 'helpdesk:manage', 'entity'),
  ('tenant_owner', 'announcements:read', 'own'), ('hr_admin', 'announcements:read', 'own'), ('hr_manager', 'announcements:read', 'own'),
  ('recruiter', 'announcements:read', 'own'), ('hiring_manager', 'announcements:read', 'own'), ('payroll_admin', 'announcements:read', 'own'),
  ('finance_manager', 'announcements:read', 'own'), ('attendance_admin', 'announcements:read', 'own'),
  ('department_manager', 'announcements:read', 'own'), ('employee', 'announcements:read', 'own')
) as g(role_key, permission, scope) on g.role_key = r.key
where r.is_system
on conflict (role_id, permission) do nothing;

-------------------------------------------------------------------------------
-- Row-Level Security and grants
-------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'helpdesk_categories', 'helpdesk_category_handlers', 'helpdesk_articles', 'helpdesk_counters', 'helpdesk_cases',
    'helpdesk_messages', 'helpdesk_events', 'announcements', 'announcement_receipts', 'mobile_devices'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

alter table push_messages enable row level security;
alter table push_messages force row level security;
create policy push_insert on push_messages for insert with check (tenant_id = app_tenant_id());

grant select, insert, update, delete on helpdesk_categories, helpdesk_category_handlers, helpdesk_articles, announcements to crew_app;
grant select, insert, update on helpdesk_counters, helpdesk_cases, announcement_receipts, mobile_devices to crew_app;
-- History: rows are added, never edited or removed by the API.
grant select, insert on helpdesk_messages, helpdesk_events to crew_app;
grant insert on push_messages to crew_app;
grant select, insert, update, delete on all tables in schema public to crew_platform;
grant usage on all sequences in schema public to crew_app, crew_platform;
