-- Phase 15: installation-wide integrations set up in the Super Admin Console instead of the environment file.
--
-- One row per integration (ai, email, push, scanning, mobile_sso). A row means the Console setting is in effect,
-- switched on or off; no row means the server's environment variables are used (bootstrap fallback).
--   settings     non-secret values (model, SMTP host, scanner address...)
--   secrets_enc  the secret values (API key, SMTP password, Expo token) as one encryptField() payload, rotated
--                with every other encrypted column by the key-rotation CLI
--   config_hash  sha256 of settings + secrets, so a connection test is only shown as current for the values saved
--
-- Only the platform role can read or change it: workspaces never see these values.

create table platform_integrations (
  key text primary key check (key in ('ai', 'email', 'push', 'scanning', 'mobile_sso')),
  enabled boolean not null default false,
  settings jsonb not null default '{}',
  secrets_enc text not null default '',
  secret_hints jsonb not null default '{}',
  config_hash text not null,
  last_test_ok boolean,
  last_test_detail text,
  last_test_at timestamptz,
  last_test_hash text,
  updated_by_admin_id uuid references platform_admins(id) on delete set null,
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on platform_integrations to crew_platform;
