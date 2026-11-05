-- Phase 11: closing the known gaps.
--   * SAML 2.0 single sign-on next to OpenID Connect, and single sign-on in the mobile app (one-time hand-off codes).
--   * SCIM Groups, which an owner can map to CREW roles.
--   * Retention schedules, and erasure that also reaches free text (reviews, goals, expenses, recognition and so on).

-------------------------------------------------------------------------------
-- SAML connections
-------------------------------------------------------------------------------

alter table sso_connections drop constraint sso_connections_protocol_check;
alter table sso_connections add constraint sso_connections_protocol_check check (protocol in ('oidc', 'saml'));
-- For SAML the issuer is the identity provider's entity ID, which may be a URN rather than a URL.
alter table sso_connections drop constraint sso_connections_issuer_check;
alter table sso_connections add constraint sso_connections_issuer_check check (length(issuer) between 1 and 500 and (protocol = 'saml' or issuer ~ '^https?://'));
alter table sso_connections alter column client_id drop not null;
alter table sso_connections alter column client_secret_enc drop not null;
alter table sso_connections
  -- Where the browser is sent with the sign-in request (HTTP-Redirect binding).
  add column saml_sso_url text check (length(saml_sso_url) <= 1000 and saml_sso_url ~ '^https?://'),
  -- The identity provider's signing certificate (PEM). Public, so stored as is.
  add column saml_idp_cert text check (length(saml_idp_cert) <= 20000),
  add column saml_cert_expires_at timestamptz,
  add column saml_cert_fingerprint text check (saml_cert_fingerprint ~ '^[0-9A-F:]{95}$'),
  add constraint sso_connections_protocol_fields check (
    (protocol = 'oidc' and client_id is not null and client_secret_enc is not null)
    or (protocol = 'saml' and saml_sso_url is not null and saml_idp_cert is not null and saml_cert_fingerprint is not null)
  );

-- SAML keeps its request ID in nonce and has no PKCE verifier. A mobile sign-in also records where to send the app
-- back to and the app's own PKCE challenge, so only the app that started it can collect the session.
alter table sso_login_states alter column code_verifier_enc drop not null;
alter table sso_login_states
  add column protocol text not null default 'oidc' check (protocol in ('oidc', 'saml')),
  add column return_to text check (length(return_to) <= 300),
  add column app_challenge text check (app_challenge ~ '^[A-Za-z0-9_-]{43}$');

-- A finished mobile sign-in: the browser hands the app a one-time code, and the app exchanges it (with the verifier
-- behind its challenge) for a session. Codes are stored hashed, live two minutes and work once.
create table sso_handoffs (
  code_hash text primary key check (length(code_hash) = 64),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  membership_id uuid not null,
  mfa boolean not null,
  app_challenge text not null check (app_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id) on delete cascade
);

-------------------------------------------------------------------------------
-- SCIM Groups
-------------------------------------------------------------------------------

create table scim_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 200),
  external_id text check (length(external_id) <= 200),
  -- Members of the group get this role while they are in it. Set by an owner in CREW, never by the provider.
  role_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, display_name),
  unique (tenant_id, external_id),
  foreign key (tenant_id, role_id) references roles (tenant_id, id) on delete set null (role_id)
);

create table scim_group_members (
  tenant_id uuid not null references tenants(id) on delete cascade,
  group_id uuid not null,
  membership_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (group_id, membership_id),
  foreign key (tenant_id, group_id) references scim_groups (tenant_id, id) on delete cascade,
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id) on delete cascade
);
create index scim_group_members_membership on scim_group_members (tenant_id, membership_id);

-- Which role assignments came from a group, so removing someone from the group removes only those.
alter table role_assignments add column source text not null default 'manual' check (source in ('manual', 'scim'));

-------------------------------------------------------------------------------
-- Retention schedules
-------------------------------------------------------------------------------

create table retention_policies (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  -- Erase people automatically this many years after their last working day (null: never, HR erases on request).
  exited_erasure_years integer check (exited_erasure_years between 1 and 30),
  -- Delete prepared access exports this many days after they were made.
  export_days integer not null default 30 check (export_days between 1 and 365),
  -- Delete single sign-on and provisioning logs (sign-in states, SCIM calls) after this many days.
  sign_in_log_days integer not null default 90 check (sign_in_log_days between 7 and 3650),
  updated_by_membership_id uuid,
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, updated_by_membership_id) references memberships (tenant_id, id)
);

create table retention_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  ran_at timestamptz not null default now(),
  result jsonb not null check (jsonb_typeof(result) = 'object')
);
create index retention_runs_tenant on retention_runs (tenant_id, ran_at desc);

-- An access export's file is deleted when the retention period ends (or the person is erased). The request stays
-- closed and frozen; the only change allowed afterwards is recording that its file is gone.
alter table privacy_requests add column export_deleted_at timestamptz;
create or replace function privacy_requests_guard() returns trigger language plpgsql as $$
begin
  if old.status <> 'open' then
    if old.export_storage_key is not null and new.export_storage_key is null and new.export_deleted_at is not null and old.export_deleted_at is null
       and (to_jsonb(new) - array['export_storage_key', 'export_deleted_at', 'updated_at']) = (to_jsonb(old) - array['export_storage_key', 'export_deleted_at', 'updated_at']) then
      return new;
    end if;
    raise exception 'privacy request is closed';
  end if;
  return new;
end $$;

-------------------------------------------------------------------------------
-- Erasure reaches the free text in records that are otherwise frozen
-------------------------------------------------------------------------------
-- In each case the erasure transaction sets crew.erasure = 'on' and may only replace text with the erased marker;
-- ratings, dates, statuses and links stay exactly as they were.

create or replace function reviews_guard() returns trigger language plpgsql as $$
declare
  frozen text[] := array['acknowledged_at', 'employee_comment', 'updated_at'];
  text_cols text[] := array['self_answers', 'manager_answers', 'employee_comment', 'excluded_reason', 'updated_at'];
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  if tg_op = 'UPDATE' and current_setting('crew.erasure', true) = 'on' then
    if (to_jsonb(new) - text_cols) is distinct from (to_jsonb(old) - text_cols)
       or new.self_answers is distinct from '{"erased": true}'::jsonb or new.manager_answers is distinct from '{"erased": true}'::jsonb
       or new.employee_comment is not null or new.excluded_reason is not null then
      raise exception 'erasure may only blank the text of a review' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.released_at is not null then raise exception 'A released review cannot be deleted' using errcode = 'P0001'; end if;
    return old;
  end if;
  if old.released_at is not null then
    if (to_jsonb(new) - frozen) is distinct from (to_jsonb(old) - frozen) or old.acknowledged_at is not null then
      raise exception 'A released review cannot be changed' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.self_status = 'submitted' and (new.self_answers is distinct from old.self_answers or new.self_rating is distinct from old.self_rating
       or new.self_status is distinct from old.self_status or new.self_submitted_at is distinct from old.self_submitted_at) then
    raise exception 'A submitted self review cannot be changed' using errcode = 'P0001';
  end if;
  if old.manager_status = 'submitted' and (new.manager_answers is distinct from old.manager_answers or new.manager_rating is distinct from old.manager_rating
       or new.manager_status is distinct from old.manager_status or new.manager_submitted_at is distinct from old.manager_submitted_at) then
    raise exception 'A submitted manager review cannot be changed' using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function review_feedback_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  if tg_op = 'UPDATE' and current_setting('crew.erasure', true) = 'on' then
    if (to_jsonb(new) - 'answers') is distinct from (to_jsonb(old) - 'answers') or new.answers is distinct from '{"erased": true}'::jsonb then
      raise exception 'erasure may only blank the text of feedback' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status in ('submitted', 'declined') then
    raise exception 'Feedback that was submitted or declined cannot be changed' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create or replace function course_assignments_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  if tg_op = 'UPDATE' and current_setting('crew.erasure', true) = 'on' then
    if (to_jsonb(new) - array['completion_note', 'cancelled_reason', 'updated_at']) is distinct from (to_jsonb(old) - array['completion_note', 'cancelled_reason', 'updated_at'])
       or new.completion_note is not null or new.cancelled_reason is not null then
      raise exception 'erasure may only blank the notes of a course assignment' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status = 'completed' then raise exception 'A completed course cannot be changed' using errcode = 'P0001'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-------------------------------------------------------------------------------
-- Row-Level Security and grants
-------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['sso_handoffs', 'scim_groups', 'scim_group_members', 'retention_policies', 'retention_runs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select, insert, update, delete on scim_groups to crew_app;
grant select, insert, delete on scim_group_members to crew_app;
grant select, insert, update on retention_policies to crew_app;
grant select, insert on retention_runs to crew_app;
grant select, insert, update, delete on all tables in schema public to crew_platform;
