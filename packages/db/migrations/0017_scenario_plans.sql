-- Scenarios that unfold over time: assumptions (horizon, attrition, pay rise) per scenario, and draft requisitions
-- raised from a scenario keep a link back to it so they are not raised twice.
alter table workforce_scenarios add column assumptions jsonb not null default '{}'::jsonb check (jsonb_typeof(assumptions) = 'object');
alter table job_requisitions add column source_scenario_id uuid references workforce_scenarios (id) on delete set null;
create index job_requisitions_source_scenario on job_requisitions (tenant_id, source_scenario_id) where source_scenario_id is not null;
