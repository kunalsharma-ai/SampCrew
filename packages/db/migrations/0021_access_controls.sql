-- Phase 14: workspace access controls set by SAMPLEDGE in the Super Admin Console.
--
-- 1. Module switches stay in subscriptions.feature_overrides (true = on, false = off, missing = plan default).
-- 2. tenant_access_controls.disabled_permissions turns individual permissions off for the whole workspace. A
--    disabled permission is removed from every member's effective grants, whatever their roles say, so the
--    owner cannot grant it back from Settings > Roles.
-- 3. member_feature_access.blocked_features takes modules away from one member only.
--
-- Customers can read both tables (so the web and mobile apps can explain why something is unavailable) but
-- only the platform role can change them.

create table tenant_access_controls (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  disabled_permissions text[] not null default '{}',
  updated_by_admin_id uuid references platform_admins(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table member_feature_access (
  tenant_id uuid not null references tenants(id) on delete cascade,
  membership_id uuid not null references memberships(id) on delete cascade,
  blocked_features text[] not null default '{}',
  updated_by_admin_id uuid references platform_admins(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, membership_id)
);
create index member_feature_access_membership on member_feature_access (membership_id);

do $$
declare t text;
begin
  foreach t in array array['tenant_access_controls', 'member_feature_access'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select on tenant_access_controls, member_feature_access to crew_app;
grant select, insert, update, delete on tenant_access_controls, member_feature_access to crew_platform;
