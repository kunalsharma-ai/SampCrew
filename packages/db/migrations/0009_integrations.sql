-- Phase 9: integrations. Workspace API keys for partners' systems, outgoing webhooks (signed, retried, logged),
-- and connections to outside services (Slack in this release). Secrets are stored hashed (API keys) or
-- encrypted with the field encryption key (webhook signing secrets, connection credentials), never in plain text.

-------------------------------------------------------------------------------
-- API keys
-------------------------------------------------------------------------------

-- A key acts as the person who created it, limited to the scopes chosen (read-only permissions in this release).
-- If that person leaves or loses a permission, the key loses it too.
create table api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 3 and 80),
  -- Shown in lists so people can recognise a key; the rest is only ever stored as a SHA-256 hash.
  prefix text not null unique check (prefix ~ '^[a-z0-9]{10}$'),
  secret_hash text not null check (length(secret_hash) = 64),
  scopes text[] not null check (cardinality(scopes) between 1 and 30),
  created_by_membership_id uuid not null,
  expires_at timestamptz,
  last_used_at timestamptz,
  last_used_ip inet,
  use_count bigint not null default 0,
  revoked_at timestamptz,
  revoked_by_membership_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, revoked_by_membership_id) references memberships (tenant_id, id)
);
create index api_keys_tenant on api_keys (tenant_id, created_at desc);

-- A revoked key stays revoked, and its scopes and owner never change.
create function api_keys_guard() returns trigger language plpgsql as $$
begin
  if old.revoked_at is not null then raise exception 'api key is revoked'; end if;
  if new.scopes is distinct from old.scopes or new.created_by_membership_id is distinct from old.created_by_membership_id
     or new.secret_hash is distinct from old.secret_hash or new.prefix is distinct from old.prefix then
    raise exception 'api key scopes, owner and secret cannot change';
  end if;
  return new;
end $$;
create trigger api_keys_guard before update on api_keys for each row execute function api_keys_guard();

-------------------------------------------------------------------------------
-- Outgoing webhooks
-------------------------------------------------------------------------------

create table webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 3 and 80),
  url text not null check (length(url) <= 2000 and url ~ '^https?://'),
  -- Event types this endpoint receives (see the event catalogue in @crew/contracts).
  events text[] not null check (cardinality(events) between 1 and 50),
  secret_enc text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'disabled')),
  status_reason text check (length(status_reason) <= 500),
  consecutive_failures integer not null default 0,
  created_by_membership_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id)
);

create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  endpoint_id uuid not null,
  -- The outbox event (or a test ping) this delivery carries; one delivery per endpoint per event.
  event_id uuid not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'succeeded', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz default now(),
  locked_until timestamptz,
  last_status_code integer,
  last_error text check (length(last_error) <= 1000),
  last_response text check (length(last_response) <= 2000),
  last_duration_ms integer,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (endpoint_id, event_id),
  foreign key (tenant_id, endpoint_id) references webhook_endpoints (tenant_id, id) on delete cascade
);
create index webhook_deliveries_due on webhook_deliveries (next_attempt_at) where status in ('pending', 'sending');
create index webhook_deliveries_endpoint on webhook_deliveries (endpoint_id, created_at desc);

-- Every attempt, kept for the delivery log.
create table webhook_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  delivery_id uuid not null,
  attempt integer not null check (attempt > 0),
  status_code integer,
  ok boolean not null,
  error text check (length(error) <= 1000),
  response text check (length(response) <= 2000),
  duration_ms integer not null,
  created_at timestamptz not null default now(),
  unique (delivery_id, attempt),
  foreign key (tenant_id, delivery_id) references webhook_deliveries (tenant_id, id) on delete cascade
);

-------------------------------------------------------------------------------
-- Connections to outside services
-------------------------------------------------------------------------------

create table integration_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null check (provider in ('slack')),
  name text not null check (length(name) between 3 and 80),
  -- Encrypted JSON with the provider's credentials (for Slack: the incoming webhook URL).
  credentials_enc text not null,
  -- Non-secret details to show, e.g. the last characters of the webhook URL.
  display jsonb not null default '{}',
  status text not null default 'active' check (status in ('active', 'error', 'disconnected')),
  status_reason text check (length(status_reason) <= 500),
  verified_at timestamptz,
  last_used_at timestamptz,
  created_by_membership_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id)
);

create table integration_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  connection_id uuid not null,
  action text not null check (length(action) <= 60),
  ok boolean not null,
  detail text check (length(detail) <= 1000),
  duration_ms integer,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, connection_id) references integration_connections (tenant_id, id) on delete cascade
);
create index integration_logs_connection on integration_logs (connection_id, created_at desc);

-------------------------------------------------------------------------------
-- Row-Level Security and grants
-------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['api_keys', 'webhook_endpoints', 'webhook_deliveries', 'webhook_attempts', 'integration_connections', 'integration_logs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select, insert, update on api_keys, webhook_deliveries, integration_connections to crew_app;
grant select, insert, update, delete on webhook_endpoints to crew_app;
-- Logs: rows are added, never edited by the API.
grant select, insert on webhook_attempts, integration_logs to crew_app;
-- The API key check runs before the workspace is known, so it reads api_keys with the platform role.
grant select, insert, update, delete on all tables in schema public to crew_platform;
grant usage on all sequences in schema public to crew_app, crew_platform;
