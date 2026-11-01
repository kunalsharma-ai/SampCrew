-- Phase 6: performance (goals, review cycles, 360 feedback, calibration), learning and engagement
-- (anonymous surveys, recognition). Submitted reviews, released results, check-ins, calibration history and
-- survey responses are history and cannot be edited.

-------------------------------------------------------------------------------
-- Goals
-------------------------------------------------------------------------------

create table goals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  parent_goal_id uuid,
  title text not null check (length(title) between 3 and 200),
  description text not null default '' check (length(description) <= 2000),
  period_start date not null,
  period_end date not null,
  weight smallint not null default 0 check (weight between 0 and 100),
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  -- Cached from key results or check-ins by the API (see packages/contracts/src/talent-math.ts).
  progress numeric(5, 1) not null default 0 check (progress between 0 and 100),
  reported_progress numeric(5, 1) not null default 0 check (reported_progress between 0 and 100),
  confidence text check (confidence in ('on_track', 'at_risk', 'off_track')),
  last_checkin_at timestamptz,
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (period_end >= period_start),
  check (parent_goal_id is null or parent_goal_id <> id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, parent_goal_id) references goals (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id)
);
create index goals_employee on goals (tenant_id, employee_id, period_end desc);
create index goals_parent on goals (tenant_id, parent_goal_id) where parent_goal_id is not null;
create trigger goals_touch before update on goals for each row execute function touch_updated_at();

create table goal_key_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  goal_id uuid not null,
  position smallint not null,
  title text not null check (length(title) between 3 and 200),
  start_value numeric(14, 2) not null default 0,
  target_value numeric(14, 2) not null,
  current_value numeric(14, 2) not null default 0,
  unit text not null default '' check (length(unit) <= 20),
  unique (tenant_id, id),
  check (target_value <> start_value),
  foreign key (tenant_id, goal_id) references goals (tenant_id, id) on delete cascade
);
create index goal_key_results_goal on goal_key_results (tenant_id, goal_id, position);

-- Insert-only history of progress updates.
create table goal_checkins (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  goal_id uuid not null,
  progress numeric(5, 1) not null check (progress between 0 and 100),
  confidence text not null check (confidence in ('on_track', 'at_risk', 'off_track')),
  note text not null default '' check (length(note) <= 1000),
  -- [{ keyResultId, title, from, to }]
  values jsonb not null default '[]',
  by_membership_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, goal_id) references goals (tenant_id, id) on delete cascade,
  foreign key (tenant_id, by_membership_id) references memberships (tenant_id, id)
);
create index goal_checkins_goal on goal_checkins (tenant_id, goal_id, created_at desc);

-------------------------------------------------------------------------------
-- Review cycles, reviews, 360 feedback and calibration
-------------------------------------------------------------------------------

create table review_cycles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 3 and 120),
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'calibration', 'released')),
  self_review boolean not null default true,
  peer_feedback boolean not null default false,
  questions jsonb not null,
  rating_scale jsonb not null,
  legal_entity_id uuid,
  department_id uuid,
  self_due date,
  manager_due date,
  launched_at timestamptz,
  calibration_started_at timestamptz,
  released_at timestamptz,
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (period_end >= period_start),
  check (jsonb_typeof(questions) = 'array' and jsonb_typeof(rating_scale) = 'array'),
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id),
  foreign key (tenant_id, department_id) references departments (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id)
);
create trigger review_cycles_touch before update on review_cycles for each row execute function touch_updated_at();

create table reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  cycle_id uuid not null,
  employee_id uuid not null,
  -- The manager when the cycle was launched; HR can reassign while the cycle is active.
  manager_employee_id uuid,
  self_status text not null default 'pending' check (self_status in ('not_required', 'pending', 'submitted')),
  self_answers jsonb not null default '{}',
  self_rating smallint,
  self_submitted_at timestamptz,
  manager_status text not null default 'pending' check (manager_status in ('pending', 'submitted')),
  manager_answers jsonb not null default '{}',
  manager_rating smallint,
  manager_submitted_at timestamptz,
  manager_submitted_by uuid,
  final_rating smallint,
  calibrated_at timestamptz,
  excluded boolean not null default false,
  excluded_reason text,
  released_at timestamptz,
  acknowledged_at timestamptz,
  employee_comment text check (length(employee_comment) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, cycle_id, employee_id),
  check (manager_employee_id is null or manager_employee_id <> employee_id),
  check (not excluded or excluded_reason is not null),
  foreign key (tenant_id, cycle_id) references review_cycles (tenant_id, id) on delete cascade,
  foreign key (tenant_id, employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, manager_employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, manager_submitted_by) references memberships (tenant_id, id)
);
create index reviews_manager on reviews (tenant_id, manager_employee_id);
create index reviews_employee on reviews (tenant_id, employee_id);
create trigger reviews_touch before update on reviews for each row execute function touch_updated_at();

-- Submitted parts and released results cannot be changed. After release the employee can only acknowledge once.
create function reviews_guard() returns trigger language plpgsql as $$
declare
  frozen text[] := array['acknowledged_at', 'employee_comment', 'updated_at'];
begin
  -- Deleting a whole workspace cascades from inside another trigger; that is allowed.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
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
create trigger reviews_guard before update or delete on reviews for each row execute function reviews_guard();

create table review_feedback (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  review_id uuid not null,
  reviewer_employee_id uuid not null,
  requested_by_membership_id uuid not null,
  status text not null default 'requested' check (status in ('requested', 'submitted', 'declined', 'withdrawn')),
  answers jsonb not null default '{}',
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, review_id, reviewer_employee_id),
  foreign key (tenant_id, review_id) references reviews (tenant_id, id) on delete cascade,
  foreign key (tenant_id, reviewer_employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, requested_by_membership_id) references memberships (tenant_id, id)
);
create index review_feedback_reviewer on review_feedback (tenant_id, reviewer_employee_id, status);

create function review_feedback_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  if old.status in ('submitted', 'declined') then
    raise exception 'Feedback that was submitted or declined cannot be changed' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger review_feedback_guard before update or delete on review_feedback for each row execute function review_feedback_guard();

-- Insert-only history of every rating change made in calibration.
create table review_calibrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  review_id uuid not null,
  from_rating smallint,
  to_rating smallint not null,
  reason text not null check (length(reason) between 5 and 1000),
  by_membership_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, review_id) references reviews (tenant_id, id) on delete cascade,
  foreign key (tenant_id, by_membership_id) references memberships (tenant_id, id)
);
create index review_calibrations_review on review_calibrations (tenant_id, review_id, created_at);

-------------------------------------------------------------------------------
-- Learning
-------------------------------------------------------------------------------

create table courses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null check (length(title) between 3 and 160),
  description text not null default '' check (length(description) <= 4000),
  format text not null check (format in ('online', 'video', 'document', 'classroom')),
  content_url text check (content_url ~ '^https://' and length(content_url) <= 500),
  duration_minutes integer check (duration_minutes between 1 and 10000),
  validity_months smallint check (validity_months between 1 and 120),
  category text not null default '' check (length(category) <= 60),
  self_enrol boolean not null default true,
  archived_at timestamptz,
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id)
);
create unique index courses_title on courses (tenant_id, lower(title)) where archived_at is null;
create trigger courses_touch before update on courses for each row execute function touch_updated_at();

create table learning_paths (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null check (length(title) between 3 and 160),
  description text not null default '' check (length(description) <= 2000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index learning_paths_title on learning_paths (tenant_id, lower(title)) where archived_at is null;
create trigger learning_paths_touch before update on learning_paths for each row execute function touch_updated_at();

create table learning_path_courses (
  tenant_id uuid not null references tenants(id) on delete cascade,
  path_id uuid not null,
  course_id uuid not null,
  position smallint not null,
  primary key (tenant_id, path_id, course_id),
  foreign key (tenant_id, path_id) references learning_paths (tenant_id, id) on delete cascade,
  foreign key (tenant_id, course_id) references courses (tenant_id, id)
);

create table course_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  course_id uuid not null,
  path_id uuid,
  source text not null check (source in ('assigned', 'self_enrolled')),
  assigned_by_membership_id uuid,
  due_on date,
  status text not null default 'assigned' check (status in ('assigned', 'in_progress', 'completed', 'cancelled')),
  started_at timestamptz,
  completed_on date,
  completion_note text check (length(completion_note) <= 1000),
  completed_by_membership_id uuid,
  expires_on date,
  cancelled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (status <> 'completed' or completed_on is not null),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, course_id) references courses (tenant_id, id),
  foreign key (tenant_id, path_id) references learning_paths (tenant_id, id),
  foreign key (tenant_id, assigned_by_membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, completed_by_membership_id) references memberships (tenant_id, id)
);
create unique index course_assignments_open on course_assignments (tenant_id, employee_id, course_id) where status in ('assigned', 'in_progress');
create index course_assignments_employee on course_assignments (tenant_id, employee_id, status);
create trigger course_assignments_touch before update on course_assignments for each row execute function touch_updated_at();

-- A completion is a record of fact: it cannot be edited or removed afterwards.
create function course_assignments_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  if old.status = 'completed' then raise exception 'A completed course cannot be changed' using errcode = 'P0001'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger course_assignments_guard before update or delete on course_assignments for each row execute function course_assignments_guard();

-------------------------------------------------------------------------------
-- Engagement: surveys and recognition
-------------------------------------------------------------------------------

create table surveys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null check (length(title) between 3 and 160),
  description text not null default '' check (length(description) <= 2000),
  anonymous boolean not null default true,
  min_responses smallint not null default 5 check (min_responses between 3 and 50),
  questions jsonb not null check (jsonb_typeof(questions) = 'array'),
  status text not null default 'draft' check (status in ('draft', 'open', 'closed')),
  legal_entity_id uuid,
  department_id uuid,
  closes_on date,
  opened_at timestamptz,
  closed_at timestamptz,
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id),
  foreign key (tenant_id, department_id) references departments (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id)
);
create trigger surveys_touch before update on surveys for each row execute function touch_updated_at();

-- Who was invited and whether they answered. Deliberately no timestamp, so a response cannot be matched to a
-- person by time.
create table survey_invitations (
  tenant_id uuid not null references tenants(id) on delete cascade,
  survey_id uuid not null,
  employee_id uuid not null,
  responded boolean not null default false,
  primary key (tenant_id, survey_id, employee_id),
  foreign key (tenant_id, survey_id) references surveys (tenant_id, id) on delete cascade,
  foreign key (tenant_id, employee_id) references employees (tenant_id, id)
);

-- Responses. For anonymous surveys there is no link to a person: only the department and legal entity at the time,
-- for breakdowns that respect the anonymity threshold, and the date (not the time).
create table survey_responses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  survey_id uuid not null,
  employee_id uuid,
  department_id uuid,
  legal_entity_id uuid,
  answers jsonb not null check (jsonb_typeof(answers) = 'object'),
  submitted_on date not null default current_date,
  foreign key (tenant_id, survey_id) references surveys (tenant_id, id) on delete cascade,
  foreign key (tenant_id, employee_id) references employees (tenant_id, id)
);
create index survey_responses_survey on survey_responses (tenant_id, survey_id);

create function survey_responses_anonymous() returns trigger language plpgsql as $$
begin
  if new.employee_id is not null and (select anonymous from surveys where id = new.survey_id) then
    raise exception 'Responses to an anonymous survey cannot name the respondent' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger survey_responses_anonymous before insert on survey_responses for each row execute function survey_responses_anonymous();

create table company_values (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 2 and 60),
  description text not null default '' check (length(description) <= 300),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index company_values_name on company_values (tenant_id, lower(name)) where archived_at is null;

create table recognitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  from_employee_id uuid not null,
  to_employee_id uuid not null,
  value_id uuid,
  message text not null check (length(message) between 3 and 500),
  hidden_at timestamptz,
  hidden_by_membership_id uuid,
  hidden_reason text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (from_employee_id <> to_employee_id),
  check (hidden_at is null or hidden_reason is not null),
  foreign key (tenant_id, from_employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, to_employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, value_id) references company_values (tenant_id, id),
  foreign key (tenant_id, hidden_by_membership_id) references memberships (tenant_id, id)
);
create index recognitions_feed on recognitions (tenant_id, created_at desc);
create index recognitions_to on recognitions (tenant_id, to_employee_id, created_at desc);

-------------------------------------------------------------------------------
-- Defaults for existing workspaces, and system role grants added since they were created
-------------------------------------------------------------------------------

insert into company_values (tenant_id, name, description)
select t.id, v.name, v.description
from tenants t
cross join (values
  ('Customer first', 'We start from what the customer needs.'),
  ('Ownership', 'We take responsibility and follow through.'),
  ('Teamwork', 'We help each other succeed.'),
  ('Safety', 'Nobody gets hurt doing their job.')
) as v(name, description);

insert into role_permissions (tenant_id, role_id, permission, scope)
select r.tenant_id, r.id, g.permission, g.scope
from roles r
join (values
  ('tenant_owner', 'performance:configure', 'tenant'), ('tenant_owner', 'learning:configure', 'tenant'), ('tenant_owner', 'recognition:give', 'own'),
  ('hr_admin', 'performance:configure', 'tenant'), ('hr_admin', 'learning:configure', 'tenant'),
  ('hr_admin', 'recognition:give', 'own'), ('hr_manager', 'recognition:give', 'own'), ('recruiter', 'recognition:give', 'own'),
  ('hiring_manager', 'recognition:give', 'own'), ('payroll_admin', 'recognition:give', 'own'), ('finance_manager', 'recognition:give', 'own'),
  ('attendance_admin', 'recognition:give', 'own'), ('department_manager', 'recognition:give', 'own'), ('employee', 'recognition:give', 'own'),
  ('tenant_owner', 'surveys:respond', 'own'),
  ('hr_admin', 'surveys:respond', 'own'),
  ('hr_manager', 'surveys:respond', 'own'),
  ('recruiter', 'surveys:respond', 'own'),
  ('hiring_manager', 'surveys:respond', 'own'),
  ('payroll_admin', 'surveys:respond', 'own'),
  ('finance_manager', 'surveys:respond', 'own'),
  ('attendance_admin', 'surveys:respond', 'own'),
  ('department_manager', 'surveys:respond', 'own'),
  ('employee', 'surveys:respond', 'own')
) as g(role_key, permission, scope) on g.role_key = r.key
where r.is_system
on conflict (role_id, permission) do nothing;

-------------------------------------------------------------------------------
-- Row-Level Security and grants
-------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'goals', 'goal_key_results', 'goal_checkins', 'review_cycles', 'reviews', 'review_feedback', 'review_calibrations',
    'courses', 'learning_paths', 'learning_path_courses', 'course_assignments',
    'surveys', 'survey_invitations', 'survey_responses', 'company_values', 'recognitions'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select, insert, update, delete on goals, goal_key_results, review_cycles, reviews, review_feedback, courses, learning_paths,
  learning_path_courses, course_assignments, surveys, survey_invitations, company_values to crew_app;
grant select, insert, update on recognitions to crew_app;
-- History: rows are added, never edited or removed by the API.
grant select, insert on goal_checkins, review_calibrations, survey_responses to crew_app;
grant select, insert, update, delete on all tables in schema public to crew_platform;
grant usage on all sequences in schema public to crew_app, crew_platform;
