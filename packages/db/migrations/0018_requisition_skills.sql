-- Skills a job asks for (with the lowest level that counts), used to find people inside the workspace who fit.
create table requisition_skills (
  tenant_id uuid not null references tenants(id) on delete cascade,
  requisition_id uuid not null,
  skill_id uuid not null,
  min_level smallint not null check (min_level between 1 and 4),
  primary key (tenant_id, requisition_id, skill_id),
  foreign key (tenant_id, requisition_id) references job_requisitions (tenant_id, id) on delete cascade,
  foreign key (tenant_id, skill_id) references skills (tenant_id, id) on delete cascade
);
create index requisition_skills_skill on requisition_skills (tenant_id, skill_id);

alter table requisition_skills enable row level security;
alter table requisition_skills force row level security;
create policy tenant_isolation on requisition_skills using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update, delete on requisition_skills to crew_app;
grant select, insert, update, delete on requisition_skills to crew_platform;
