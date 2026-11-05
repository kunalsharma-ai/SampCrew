-- Workspace experience: each member's appearance (theme preset, colours, density, motion, focus mode), favourite
-- pages, recently visited pages, Home dashboard layout and personal notes. One row per membership, readable and
-- writable only by that member through the API; RLS keeps it inside the workspace.

create table member_preferences (
  tenant_id uuid not null references tenants(id) on delete cascade,
  membership_id uuid not null,
  appearance jsonb not null default '{}'::jsonb check (jsonb_typeof(appearance) = 'object'),
  favourites text[] not null default '{}' check (cardinality(favourites) <= 12),
  recents jsonb not null default '[]'::jsonb check (jsonb_typeof(recents) = 'array' and jsonb_array_length(recents) <= 8),
  dashboard jsonb not null default '{}'::jsonb check (jsonb_typeof(dashboard) = 'object'),
  notes text not null default '' check (length(notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, membership_id),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id) on delete cascade
);
create trigger member_preferences_touch before update on member_preferences for each row execute function touch_updated_at();

alter table member_preferences enable row level security;
alter table member_preferences force row level security;
create policy tenant_isolation on member_preferences using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());

grant select, insert, update on member_preferences to crew_app;
grant select, insert, update, delete on member_preferences to crew_platform;
