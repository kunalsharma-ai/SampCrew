-- Workforce Universe lenses: skills people hold (for the skills network) and saved what-if headcount scenarios.

create table skills (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name citext not null check (length(name) between 2 and 60),
  category text check (length(category) <= 60),
  created_at timestamptz not null default now(),
  unique (tenant_id, name),
  unique (tenant_id, id)
);

create table employee_skills (
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  skill_id uuid not null,
  level smallint not null check (level between 1 and 4),
  updated_by_membership_id uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, employee_id, skill_id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, skill_id) references skills (tenant_id, id) on delete cascade
);
create index employee_skills_skill on employee_skills (tenant_id, skill_id);

create table workforce_scenarios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 2 and 80),
  notes text not null default '' check (length(notes) <= 2000),
  changes jsonb not null check (jsonb_typeof(changes) = 'array'),
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workforce_scenarios_tenant on workforce_scenarios (tenant_id, updated_at desc);

do $$
declare t text;
begin
  foreach t in array array['skills', 'employee_skills', 'workforce_scenarios'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
    execute format('grant select, insert, update, delete on %I to crew_app', t);
    execute format('grant select, insert, update, delete on %I to crew_platform', t);
  end loop;
end $$;
