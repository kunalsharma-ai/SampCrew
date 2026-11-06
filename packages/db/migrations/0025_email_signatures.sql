-- Outlook email signatures (SAMPLEDGE feedback, 2026-11-06).
--
-- 1. signature_settings: one row per workspace with the company details every signature shares (name, website,
--    phone, address, logo, colours, disclaimer, social links), the default design and how computers keep the
--    signature up to date (automatically on a schedule, or only when the person clicks "Sync now").
-- 2. employee_signatures: each person's chosen design (one of the 20 built-in designs) and their own changes.
-- 3. signature_agents: each Windows computer that installs the signature into Outlook. It authenticates with its own
--    token (stored as a SHA-256 hash), fetches the rendered signature and reports what it wrote.

create table signature_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  company_name text check (company_name is null or length(company_name) <= 160),
  website text check (website is null or website ~ '^https?://' and length(website) <= 300),
  phone text check (phone is null or length(phone) <= 40),
  address text check (address is null or length(address) <= 300),
  brand_color text not null default '#1F3A93' check (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  accent_color text not null default '#E8833A' check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  default_template text not null default 'classic',
  disclaimer text check (disclaimer is null or length(disclaimer) <= 1000),
  social jsonb not null default '{}'::jsonb,
  sync_mode text not null default 'auto' check (sync_mode in ('auto', 'manual')),
  allow_employee_sync_choice boolean not null default true,
  lock_template boolean not null default false,
  logo_key text,
  logo_content_type text check (logo_content_type in ('image/png', 'image/jpeg')),
  logo_width integer check (logo_width between 1 and 10000),
  logo_height integer check (logo_height between 1 and 10000),
  logo_updated_at timestamptz,
  updated_by uuid references memberships(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint signature_logo_complete check ((logo_key is null) = (logo_content_type is null))
);

create table employee_signatures (
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  template text not null,
  options jsonb not null default '{}'::jsonb,
  sync_mode text check (sync_mode in ('auto', 'manual')),
  sync_requested_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, employee_id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade
);

create table signature_agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  name text not null check (length(name) between 1 and 80),
  token_hash text not null unique,
  token_hint text not null,
  computer_name text,
  outlook_versions text[] not null default '{}',
  agent_version text,
  created_at timestamptz not null default now(),
  created_by uuid references memberships(id) on delete set null,
  last_seen_at timestamptz,
  last_trigger text check (last_trigger in ('install', 'scheduled', 'manual')),
  last_applied_version text,
  last_applied_at timestamptz,
  last_error text,
  last_ip inet,
  revoked_at timestamptz,
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade
);
create index signature_agents_employee on signature_agents (tenant_id, employee_id) where revoked_at is null;

do $$
declare t text;
begin
  foreach t in array array['signature_settings', 'employee_signatures', 'signature_agents'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select, insert, update, delete on signature_settings, employee_signatures, signature_agents to crew_app;
grant select, insert, update, delete on signature_settings, employee_signatures, signature_agents to crew_platform;
