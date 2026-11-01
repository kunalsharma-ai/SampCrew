-- Saved table views (filters, sort, columns and density a member names and returns to) and add-employee drafts
-- (a hire in progress that can be resumed later). Both belong to one member; RLS keeps them inside the workspace.

create table saved_views (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  membership_id uuid not null,
  page text not null check (page in ('employees', 'candidates')),
  name text not null check (length(name) between 1 and 60),
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, membership_id, page, name),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id) on delete cascade
);
create unique index saved_views_one_default on saved_views (tenant_id, membership_id, page) where is_default;
create trigger saved_views_touch before update on saved_views for each row execute function touch_updated_at();

create table employee_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  membership_id uuid not null,
  step smallint not null default 0 check (step between 0 and 10),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id) on delete cascade
);
create index employee_drafts_owner on employee_drafts (tenant_id, membership_id, updated_at desc);
create trigger employee_drafts_touch before update on employee_drafts for each row execute function touch_updated_at();

do $$
declare t text;
begin
  foreach t in array array['saved_views', 'employee_drafts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select, insert, update, delete on saved_views, employee_drafts to crew_app;
grant select, insert, update, delete on saved_views, employee_drafts to crew_platform;
