-- Phase 8: AI copilots (settings per workspace, a log of every model call with its evidence and usage),
-- the Automation Studio (versioned workflows, durable runs with a step-by-step log) and explainable insights
-- (attrition risk with the factors behind each score, and HR's reviews of them).

-------------------------------------------------------------------------------
-- AI
-------------------------------------------------------------------------------

-- Every AI feature starts switched off; an administrator turns each one on.
create table ai_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  features jsonb not null default '{}',
  prompt_log_days smallint not null default 90 check (prompt_log_days between 7 and 730),
  updated_by_membership_id uuid,
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, updated_by_membership_id) references memberships (tenant_id, id)
);

-- One row per model call (or per refused attempt): who asked, for which feature, what was sent (after
-- redaction), what came back, the sources it was given, and the tokens, credits and time it used. Prompt and
-- answer text are removed after the workspace's retention period; the usage numbers stay.
create table ai_interactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  membership_id uuid,
  feature text not null check (feature in ('assistant', 'helpdesk_draft', 'workflow_draft')),
  status text not null check (status in ('ok', 'no_sources', 'refused', 'error', 'over_limit')),
  provider text not null,
  model text not null,
  prompt_version text not null,
  subject_type text,
  subject_id uuid,
  request jsonb,
  response text,
  evidence jsonb not null default '[]',
  redactions jsonb not null default '{}',
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  credits integer not null default 0 check (credits >= 0),
  latency_ms integer not null default 0 check (latency_ms >= 0),
  error text,
  helpful boolean,
  feedback text check (length(feedback) <= 500),
  feedback_at timestamptz,
  purged_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id)
);
create index ai_interactions_month on ai_interactions (tenant_id, created_at desc);
create index ai_interactions_subject on ai_interactions (tenant_id, subject_type, subject_id);

-- What was asked and answered cannot be rewritten: only feedback can be added, and the text removed at retention.
create function ai_interactions_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'AI interactions are kept for audit and cannot be deleted' using errcode = 'P0001';
  end if;
  if (new.id, new.tenant_id, new.membership_id, new.feature, new.status, new.provider, new.model, new.prompt_version, new.subject_type, new.subject_id,
      new.evidence, new.redactions, new.input_tokens, new.output_tokens, new.credits, new.latency_ms, new.error, new.created_at)
     is distinct from
     (old.id, old.tenant_id, old.membership_id, old.feature, old.status, old.provider, old.model, old.prompt_version, old.subject_type, old.subject_id,
      old.evidence, old.redactions, old.input_tokens, old.output_tokens, old.credits, old.latency_ms, old.error, old.created_at) then
    raise exception 'an AI interaction cannot be changed' using errcode = 'P0001';
  end if;
  if (new.request is distinct from old.request and new.request is not null) or (new.response is distinct from old.response and new.response is not null) then
    raise exception 'an AI interaction''s prompt and answer can only be removed' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger ai_interactions_guard before update or delete on ai_interactions for each row execute function ai_interactions_guard();

-- A helpdesk reply that started from an AI draft records which draft; the person who sent it is the author.
alter table helpdesk_messages add column ai_interaction_id uuid;
alter table helpdesk_messages add foreign key (tenant_id, ai_interaction_id) references ai_interactions (tenant_id, id);

-------------------------------------------------------------------------------
-- Automation Studio
-------------------------------------------------------------------------------

create table workflows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 3 and 120),
  description text not null default '' check (length(description) <= 1000),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  trigger_event text not null,
  -- The workflow acts with this person's permissions, checked again at every step.
  owner_membership_id uuid not null,
  active_version_id uuid,
  status_reason text check (length(status_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, owner_membership_id) references memberships (tenant_id, id)
);
create index workflows_trigger on workflows (tenant_id, trigger_event) where status = 'active';
create trigger workflows_touch before update on workflows for each row execute function touch_updated_at();

-- Each save is a new version; versions are never edited, so a run always shows exactly what it ran.
create table workflow_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  workflow_id uuid not null,
  version integer not null check (version > 0),
  definition jsonb not null,
  created_by_membership_id uuid not null,
  ai_interaction_id uuid,
  -- Set by a successful test run of this version; activation needs it.
  tested_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (workflow_id, version),
  foreign key (tenant_id, workflow_id) references workflows (tenant_id, id) on delete cascade,
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, ai_interaction_id) references ai_interactions (tenant_id, id)
);
alter table workflows add foreign key (tenant_id, active_version_id) references workflow_versions (tenant_id, id);

create function workflow_versions_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.definition is distinct from old.definition or new.version <> old.version or new.workflow_id <> old.workflow_id) then
    raise exception 'a saved workflow version cannot be changed; save a new version' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger workflow_versions_guard before update on workflow_versions for each row execute function workflow_versions_guard();

create table workflow_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  workflow_id uuid not null,
  version_id uuid not null,
  mode text not null check (mode in ('live', 'test')),
  -- The domain event that started a live run; one run per workflow and event, however often it is delivered.
  event_id uuid,
  subject_employee_id uuid,
  context jsonb not null default '{}',
  status text not null default 'running' check (status in ('running', 'waiting', 'succeeded', 'stopped', 'failed', 'cancelled')),
  step_index integer not null default 0,
  attempt integer not null default 0,
  wake_at timestamptz,
  approval_request_id uuid,
  outcome text check (length(outcome) <= 500),
  error text check (length(error) <= 2000),
  started_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, id),
  unique (workflow_id, event_id),
  foreign key (tenant_id, workflow_id) references workflows (tenant_id, id) on delete cascade,
  foreign key (tenant_id, version_id) references workflow_versions (tenant_id, id),
  foreign key (tenant_id, subject_employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, approval_request_id) references approval_requests (tenant_id, id),
  foreign key (tenant_id, started_by_membership_id) references memberships (tenant_id, id)
);
create index workflow_runs_due on workflow_runs (wake_at) where status in ('running', 'waiting');
create index workflow_runs_workflow on workflow_runs (tenant_id, workflow_id, created_at desc);
create trigger workflow_runs_touch before update on workflow_runs for each row execute function touch_updated_at();

-- Insert-only trace: one row per attempt of each step.
create table workflow_step_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  run_id uuid not null,
  step_index integer not null,
  step_id text not null,
  type text not null,
  attempt integer not null default 1,
  status text not null check (status in ('succeeded', 'stopped', 'failed', 'waiting', 'simulated')),
  detail text not null default '' check (length(detail) <= 2000),
  error text check (length(error) <= 2000),
  created_at timestamptz not null default now(),
  unique (run_id, step_index, attempt, status),
  foreign key (tenant_id, run_id) references workflow_runs (tenant_id, id) on delete cascade
);
create index workflow_step_runs_run on workflow_step_runs (tenant_id, run_id, created_at);

-------------------------------------------------------------------------------
-- Insights
-------------------------------------------------------------------------------

-- One score per person per day it is calculated, with the inputs and factors that produced it.
create table attrition_scores (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  computed_on date not null,
  score smallint not null check (score between 0 and 100),
  band text not null check (band in ('low', 'medium', 'high')),
  factors jsonb not null default '[]',
  inputs jsonb not null default '{}',
  rules_version text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (employee_id, computed_on),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade
);
create index attrition_scores_latest on attrition_scores (tenant_id, computed_on desc, score desc);

create table attrition_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  score_id uuid not null,
  outcome text not null check (outcome in ('action_planned', 'no_action', 'not_accurate')),
  note text not null default '' check (length(note) <= 1000),
  by_membership_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, score_id) references attrition_scores (tenant_id, id) on delete cascade,
  foreign key (tenant_id, by_membership_id) references memberships (tenant_id, id)
);
create index attrition_reviews_employee on attrition_reviews (tenant_id, employee_id, created_at desc);

-------------------------------------------------------------------------------
-- Permissions for existing workspaces (new workspaces get them from the role templates)
-------------------------------------------------------------------------------

insert into role_permissions (tenant_id, role_id, permission, scope)
select r.tenant_id, r.id, g.permission, g.scope
from roles r
join (values ('tenant_owner', 'insights:attrition', 'tenant'), ('hr_admin', 'insights:attrition', 'tenant')) as g(role_key, permission, scope) on g.role_key = r.key
where r.is_system
on conflict (role_id, permission) do nothing;

-------------------------------------------------------------------------------
-- Row-Level Security and grants
-------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'ai_settings', 'ai_interactions', 'workflows', 'workflow_versions', 'workflow_runs', 'workflow_step_runs', 'attrition_scores', 'attrition_reviews'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select, insert, update on ai_settings, ai_interactions, workflows, workflow_versions, workflow_runs, attrition_scores to crew_app;
grant delete on attrition_scores to crew_app;
-- History: rows are added, never edited or removed by the API.
grant select, insert on workflow_step_runs, attrition_reviews to crew_app;
grant select, insert, update, delete on all tables in schema public to crew_platform;
grant usage on all sequences in schema public to crew_app, crew_platform;
