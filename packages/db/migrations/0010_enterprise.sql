-- Phase 10: enterprise readiness. Single sign-on with OpenID Connect, user provisioning with SCIM 2.0, and
-- privacy requests (a person's data export and erasure). Secrets are stored encrypted (the identity provider's
-- client secret) or hashed (SCIM tokens).

-------------------------------------------------------------------------------
-- Single sign-on (OpenID Connect)
-------------------------------------------------------------------------------

create table sso_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references tenants(id) on delete cascade,
  protocol text not null default 'oidc' check (protocol in ('oidc')),
  issuer text not null check (length(issuer) <= 500 and issuer ~ '^https?://'),
  client_id text not null check (length(client_id) between 1 and 300),
  client_secret_enc text not null,
  -- Sign-ins are accepted only for email addresses at these domains (lower case, no @).
  domains text[] not null check (cardinality(domains) between 1 and 20),
  -- 'draft' until a test sign-in succeeds; 'active' lets people use it; 'disabled' keeps the settings.
  status text not null default 'draft' check (status in ('draft', 'active', 'disabled')),
  -- When on, members other than owners must sign in through the identity provider (owners keep a password as a way in).
  enforced boolean not null default false,
  -- Create a membership on first sign-in for someone at an allowed domain who is not a member yet.
  jit_provisioning boolean not null default false,
  verified_at timestamptz,
  verified_email citext,
  created_by_membership_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id),
  check (not enforced or status = 'active'),
  check (status = 'draft' or verified_at is not null)
);
-- An email domain can point to one workspace's identity provider only.
create table sso_domains (
  domain citext primary key check (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  tenant_id uuid not null references tenants(id) on delete cascade
);

-- One row per sign-in attempt: the state, nonce and PKCE verifier sent to the identity provider. Single use.
create table sso_login_states (
  state_hash text primary key check (length(state_hash) = 64),
  tenant_id uuid not null references tenants(id) on delete cascade,
  nonce text not null,
  code_verifier_enc text not null,
  purpose text not null check (purpose in ('login', 'test')),
  client text not null default 'web' check (client in ('web', 'mobile')),
  started_by_membership_id uuid,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index sso_login_states_expiry on sso_login_states (expires_at);

-------------------------------------------------------------------------------
-- SCIM 2.0 provisioning
-------------------------------------------------------------------------------

create table scim_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  prefix text not null unique check (prefix ~ '^[a-z0-9]{10}$'),
  secret_hash text not null check (length(secret_hash) = 64),
  created_by_membership_id uuid not null,
  last_used_at timestamptz,
  use_count bigint not null default 0,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id)
);
-- At most one working token per workspace.
create unique index scim_tokens_one_active on scim_tokens (tenant_id) where revoked_at is null;

-- The identity provider's own id for a member (SCIM externalId), and who manages the membership.
alter table memberships add column scim_external_id text check (length(scim_external_id) <= 300);
alter table memberships add column provisioned_by text check (provisioned_by in ('scim', 'sso'));
create unique index memberships_scim_external on memberships (tenant_id, scim_external_id) where scim_external_id is not null;

-- Every SCIM call, for the provisioning log.
create table scim_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  method text not null check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  path text not null check (length(path) <= 300),
  status integer not null,
  membership_id uuid,
  detail text check (length(detail) <= 500),
  created_at timestamptz not null default now()
);
create index scim_events_tenant on scim_events (tenant_id, created_at desc);

-------------------------------------------------------------------------------
-- Privacy requests
-------------------------------------------------------------------------------

create table privacy_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  -- access: a copy of the person's data; erasure: remove what is not needed to meet legal duties.
  kind text not null check (kind in ('access', 'erasure')),
  status text not null default 'open' check (status in ('open', 'completed', 'rejected')),
  -- Where the request came from (e.g. "Email to hr@ on 3 Nov"); kept short.
  source text not null check (length(source) between 3 and 300),
  due_on date not null,
  requested_by_membership_id uuid not null,
  decided_by_membership_id uuid,
  decision_note text check (length(decision_note) <= 2000),
  -- access: the export file; erasure: what was removed and what was kept, and why.
  result jsonb,
  export_storage_key text unique,
  export_sha256 text check (export_sha256 ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, requested_by_membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, decided_by_membership_id) references memberships (tenant_id, id),
  check ((status = 'open') = (completed_at is null))
);
create index privacy_requests_tenant on privacy_requests (tenant_id, status, due_on);
-- One open request of each kind per person.
create unique index privacy_requests_one_open on privacy_requests (tenant_id, employee_id, kind) where status = 'open';

-- A finished request does not change.
create function privacy_requests_guard() returns trigger language plpgsql as $$
begin
  if old.status <> 'open' then raise exception 'privacy request is closed'; end if;
  return new;
end $$;
create trigger privacy_requests_guard before update on privacy_requests for each row execute function privacy_requests_guard();

-- Marks an employee whose personal details were erased.
alter table employees add column erased_at timestamptz;

-- Erasure is the one change allowed to a helpdesk case's original request: when the erasure transaction sets
-- crew.erasure = 'on', the subject and description may be replaced with "[erased]" and nothing else changes.
create or replace function helpdesk_cases_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'helpdesk cases cannot be deleted' using errcode = 'P0001';
  end if;
  if current_setting('crew.erasure', true) = 'on' then
    if new.subject <> '[erased]' or new.description <> '[erased] (personal details removed on request)'
       or new.number <> old.number or new.employee_id <> old.employee_id or new.status <> old.status then
      raise exception 'erasure may only blank the text of a helpdesk case' using errcode = 'P0001';
    end if;
    return new;
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

-------------------------------------------------------------------------------
-- Permissions for existing workspaces (new workspaces get them from the role templates)
-------------------------------------------------------------------------------

insert into role_permissions (tenant_id, role_id, permission, scope)
select r.tenant_id, r.id, g.permission, g.scope
from roles r
join (values ('tenant_owner', 'security:manage', 'tenant'), ('tenant_owner', 'privacy:manage', 'tenant'), ('hr_admin', 'privacy:manage', 'tenant'))
  as g(role_key, permission, scope) on g.role_key = r.key
where r.is_system
on conflict (role_id, permission) do nothing;

-------------------------------------------------------------------------------
-- Row-Level Security and grants
-------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['sso_connections', 'sso_domains', 'sso_login_states', 'scim_tokens', 'scim_events', 'privacy_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select, insert, update on sso_connections, scim_tokens, privacy_requests to crew_app;
grant select, insert, delete on sso_domains to crew_app;
grant select, insert, update on sso_login_states to crew_app;
grant select, insert on scim_events to crew_app;
-- Sign-in and SCIM calls start before the workspace is known, so they look up with the platform role.
grant select, insert, update, delete on all tables in schema public to crew_platform;
grant usage on all sequences in schema public to crew_app, crew_platform;
