-- Phase 4: Recruitment. Requisitions with approval, public job postings, candidates and applications moving
-- through a configurable pipeline, interviews with independent scorecards, offers with approval, and hiring
-- into Core HR. Every table is workspace-scoped with forced Row-Level Security.

-------------------------------------------------------------------------------
-- Pipeline stages (per workspace, ordered). Rejection and withdrawal are statuses, not stages.
-------------------------------------------------------------------------------

create table recruitment_stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 2 and 40),
  kind text not null check (kind in ('new', 'screen', 'interview', 'offer', 'hired')),
  position smallint not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index recruitment_stages_name on recruitment_stages (tenant_id, lower(name)) where archived_at is null;
-- Exactly one live "new" and one live "hired" stage: applications start and end there.
create unique index recruitment_stages_one_new on recruitment_stages (tenant_id) where kind = 'new' and archived_at is null;
create unique index recruitment_stages_one_hired on recruitment_stages (tenant_id) where kind = 'hired' and archived_at is null;

-------------------------------------------------------------------------------
-- Requisitions and postings
-------------------------------------------------------------------------------

create table requisition_number_series (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  prefix text not null default 'REQ-' check (length(prefix) <= 10),
  padding smallint not null default 4 check (padding between 1 and 8),
  next_value integer not null default 1
);

create table job_requisitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null,
  title text not null check (length(title) between 2 and 120),
  legal_entity_id uuid not null,
  department_id uuid not null,
  location_id uuid,
  designation_id uuid,
  hiring_manager_membership_id uuid not null,
  employment_type text not null check (employment_type in ('full_time', 'part_time', 'contract', 'intern', 'temporary')),
  work_mode text not null default 'onsite' check (work_mode in ('onsite', 'hybrid', 'remote')),
  headcount integer not null default 1 check (headcount between 1 and 500),
  hired_count integer not null default 0 check (hired_count >= 0),
  reason text not null default 'new_role' check (reason in ('new_role', 'replacement')),
  replacing_employee_id uuid,
  salary_min numeric(14, 2) check (salary_min >= 0),
  salary_max numeric(14, 2) check (salary_max >= 0),
  currency char(3) not null,
  target_start_date date,
  justification text not null default '' check (length(justification) <= 2000),
  description text not null default '' check (length(description) <= 20000),
  scorecard text[] not null default '{Role skills,Problem solving,Communication,Team fit}' check (cardinality(scorecard) between 1 and 12),
  status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'approved', 'open', 'on_hold', 'filled', 'closed', 'cancelled', 'rejected')),
  status_reason text check (length(status_reason) <= 500),
  approval_request_id uuid,
  created_by_membership_id uuid,
  approved_at timestamptz,
  opened_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  check (salary_min is null or salary_max is null or salary_min <= salary_max),
  check (reason <> 'replacement' or replacing_employee_id is not null),
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id),
  foreign key (tenant_id, department_id) references departments (tenant_id, id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id),
  foreign key (tenant_id, designation_id) references designations (tenant_id, id),
  foreign key (tenant_id, hiring_manager_membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, replacing_employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, approval_request_id) references approval_requests (tenant_id, id)
);
create index job_requisitions_status on job_requisitions (tenant_id, status);
create trigger job_requisitions_touch before update on job_requisitions for each row execute function touch_updated_at();

-- What the public sees. One posting per requisition; it is live only while published and the requisition is open.
create table job_postings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  requisition_id uuid not null,
  public_title text not null check (length(public_title) between 2 and 120),
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$' and length(slug) between 3 and 40),
  summary text not null default '' check (length(summary) <= 400),
  description text not null check (length(description) between 20 and 20000),
  location_text text not null default '' check (length(location_text) <= 120),
  show_salary boolean not null default false,
  published_at timestamptz,
  unpublished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, requisition_id),
  unique (tenant_id, slug),
  foreign key (tenant_id, requisition_id) references job_requisitions (tenant_id, id) on delete cascade
);
create trigger job_postings_touch before update on job_postings for each row execute function touch_updated_at();

create table career_sites (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  enabled boolean not null default false,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$' and length(slug) between 3 and 40),
  headline text not null check (length(headline) between 2 and 120),
  intro text not null default '' check (length(intro) <= 2000),
  privacy_notice text not null check (length(privacy_notice) between 40 and 4000),
  privacy_notice_version integer not null default 1,
  retention_days integer not null default 365 check (retention_days between 30 and 1825),
  updated_at timestamptz not null default now()
);
-- Career sites are found by slug from the public internet, so the slug is unique across workspaces.
create unique index career_sites_slug on career_sites (slug);
create trigger career_sites_touch before update on career_sites for each row execute function touch_updated_at();

-------------------------------------------------------------------------------
-- Candidates and applications
-------------------------------------------------------------------------------

create table candidates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  first_name text not null check (length(first_name) between 1 and 80),
  last_name text not null default '' check (length(last_name) <= 80),
  email text check (email = lower(email) and length(email) <= 254),
  phone text,
  location_text text,
  current_title text,
  current_company text,
  profile_url text,
  source text not null check (source in ('career_site', 'referral', 'agency', 'sourced', 'manual')),
  source_detail text,
  referred_by_membership_id uuid,
  tags text[] not null default '{}',
  -- How we may hold this person's data: their own consent on the career site, or a recruiter's confirmation.
  consent_basis text not null check (consent_basis in ('candidate_consent', 'recruiter_confirmed')),
  consent_at timestamptz not null default now(),
  privacy_notice_version integer,
  last_activity_at timestamptz not null default now(),
  anonymized_at timestamptz,
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (anonymized_at is not null or email is not null),
  foreign key (tenant_id, referred_by_membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id)
);
create unique index candidates_email on candidates (tenant_id, email) where anonymized_at is null;
create index candidates_name on candidates (tenant_id, lower(first_name || ' ' || last_name));
create trigger candidates_touch before update on candidates for each row execute function touch_updated_at();

create table candidate_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid not null,
  kind text not null default 'resume' check (kind in ('resume', 'other')),
  file_name text not null,
  content_type text not null,
  size_bytes integer not null check (size_bytes > 0),
  sha256 text not null,
  storage_key text not null,
  uploaded_by_membership_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, candidate_id) references candidates (tenant_id, id) on delete cascade
);

-- Free-text notes live apart from the pipeline history so they can be erased with the candidate.
create table candidate_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid not null,
  application_id uuid,
  body text not null check (length(body) between 1 and 5000),
  author_membership_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, candidate_id) references candidates (tenant_id, id) on delete cascade,
  foreign key (tenant_id, author_membership_id) references memberships (tenant_id, id)
);

create table applications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid not null,
  requisition_id uuid not null,
  stage_id uuid not null,
  status text not null default 'active' check (status in ('active', 'rejected', 'withdrawn', 'hired')),
  source text not null check (source in ('career_site', 'referral', 'agency', 'sourced', 'manual')),
  cover_note text check (length(cover_note) <= 3000),
  rejection_reason text check (rejection_reason in ('not_qualified', 'better_candidate', 'salary', 'location', 'no_show', 'withdrew', 'position_closed', 'other')),
  rejection_note text check (length(rejection_note) <= 2000),
  employee_id uuid,
  applied_at timestamptz not null default now(),
  stage_entered_at timestamptz not null default now(),
  decided_at timestamptz,
  hired_at timestamptz,
  created_by_membership_id uuid,
  unique (tenant_id, id),
  unique (tenant_id, candidate_id, requisition_id),
  check ((status = 'rejected') = (rejection_reason is not null)),
  check (status <> 'hired' or employee_id is not null),
  foreign key (tenant_id, candidate_id) references candidates (tenant_id, id) on delete cascade,
  foreign key (tenant_id, requisition_id) references job_requisitions (tenant_id, id),
  foreign key (tenant_id, stage_id) references recruitment_stages (tenant_id, id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id)
);
create index applications_requisition on applications (tenant_id, requisition_id, status);
create index applications_candidate on applications (tenant_id, candidate_id);

-- Pipeline history: what happened and when, never edited. No free text here (notes are separate) so erasing a
-- candidate does not need to rewrite history.
create table application_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  application_id uuid not null,
  kind text not null check (kind in (
    'applied', 'stage_changed', 'rejected', 'withdrawn', 'reopened', 'interview_scheduled', 'interview_cancelled',
    'feedback_submitted', 'offer_drafted', 'offer_submitted', 'offer_approved', 'offer_rejected', 'offer_sent',
    'offer_accepted', 'offer_declined', 'offer_withdrawn', 'hired', 'email_queued', 'anonymized'
  )),
  from_stage_id uuid,
  to_stage_id uuid,
  detail jsonb not null default '{}',
  actor_membership_id uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, application_id) references applications (tenant_id, id) on delete cascade
);
create index application_events_application on application_events (tenant_id, application_id, id);
create trigger application_events_immutable before update or delete on application_events for each row
  when (pg_trigger_depth() = 0) execute function reject_mutation();

-------------------------------------------------------------------------------
-- Interviews and scorecards
-------------------------------------------------------------------------------

create table interviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  application_id uuid not null,
  title text not null check (length(title) between 2 and 120),
  starts_at timestamptz not null,
  duration_minutes smallint not null check (duration_minutes between 10 and 480),
  mode text not null check (mode in ('in_person', 'video', 'phone')),
  meeting_url text check (length(meeting_url) <= 500),
  location_text text check (length(location_text) <= 200),
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  cancel_reason text check (length(cancel_reason) <= 500),
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, application_id) references applications (tenant_id, id) on delete cascade,
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id)
);
create index interviews_application on interviews (tenant_id, application_id);
create trigger interviews_touch before update on interviews for each row execute function touch_updated_at();

create table interview_panelists (
  tenant_id uuid not null references tenants(id) on delete cascade,
  interview_id uuid not null,
  membership_id uuid not null,
  primary key (interview_id, membership_id),
  unique (tenant_id, interview_id, membership_id),
  foreign key (tenant_id, interview_id) references interviews (tenant_id, id) on delete cascade,
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id)
);
create index interview_panelists_member on interview_panelists (tenant_id, membership_id);

-- One scorecard per interviewer per interview, submitted once. Interviewers cannot see each other's scorecards
-- until they have submitted their own (enforced by the API).
create table interview_feedback (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  interview_id uuid not null,
  membership_id uuid not null,
  ratings jsonb not null,
  recommendation text not null check (recommendation in ('strong_no', 'no', 'yes', 'strong_yes')),
  summary text not null check (length(summary) <= 5000),
  submitted_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (interview_id, membership_id),
  foreign key (tenant_id, interview_id, membership_id) references interview_panelists (tenant_id, interview_id, membership_id) on delete cascade
);

-------------------------------------------------------------------------------
-- Offers
-------------------------------------------------------------------------------

create table offers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  application_id uuid not null,
  job_title text not null check (length(job_title) between 2 and 120),
  designation_id uuid,
  base_salary numeric(14, 2) not null check (base_salary > 0),
  currency char(3) not null,
  pay_period text not null check (pay_period in ('annual', 'monthly', 'hourly')),
  variable_pay text check (length(variable_pay) <= 300),
  joining_date date not null,
  expires_on date not null,
  notes text check (length(notes) <= 2000),
  status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'withdrawn', 'rejected')),
  -- Over the requisition's approved range: shown to approvers so the exception is a conscious decision.
  above_range boolean not null default false,
  approval_request_id uuid,
  created_by_membership_id uuid,
  sent_at timestamptz,
  responded_at timestamptz,
  response_note text check (length(response_note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (expires_on >= joining_date - 365),
  foreign key (tenant_id, application_id) references applications (tenant_id, id) on delete cascade,
  foreign key (tenant_id, designation_id) references designations (tenant_id, id),
  foreign key (tenant_id, approval_request_id) references approval_requests (tenant_id, id),
  foreign key (tenant_id, created_by_membership_id) references memberships (tenant_id, id)
);
-- At most one offer in play per application.
create unique index offers_one_live on offers (tenant_id, application_id) where status in ('draft', 'pending_approval', 'approved', 'sent', 'accepted');
create trigger offers_touch before update on offers for each row execute function touch_updated_at();

-------------------------------------------------------------------------------
-- Defaults for existing workspaces, and system role grants added since they were created
-------------------------------------------------------------------------------

insert into recruitment_stages (tenant_id, name, kind, position)
select t.id, s.name, s.kind, s.position
from tenants t
cross join (values ('Applied', 'new', 1), ('Screening', 'screen', 2), ('Interview', 'interview', 3), ('Offer', 'offer', 4), ('Hired', 'hired', 5)) as s(name, kind, position);

-- Grants that new workspaces get from the role catalogue but existing ones did not (Phase 3 and Phase 4).
insert into role_permissions (tenant_id, role_id, permission, scope)
select r.tenant_id, r.id, g.permission, g.scope
from roles r
join (values
  ('hr_admin', 'attendance:correct', 'tenant'), ('hr_admin', 'devices:manage', 'tenant'),
  ('hr_admin', 'requisitions:read', 'tenant'), ('hr_admin', 'requisitions:approve', 'tenant'), ('hr_admin', 'candidates:read', 'tenant'),
  ('hr_admin', 'offers:approve', 'tenant'), ('hr_admin', 'recruitment:configure', 'tenant'),
  ('recruiter', 'recruitment:configure', 'tenant'), ('tenant_owner', 'recruitment:configure', 'tenant')
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
    'recruitment_stages', 'requisition_number_series', 'job_requisitions', 'job_postings', 'career_sites', 'candidates',
    'candidate_files', 'candidate_notes', 'applications', 'application_events', 'interviews', 'interview_panelists',
    'interview_feedback', 'offers'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select, insert, update, delete on recruitment_stages, requisition_number_series, job_requisitions, job_postings, career_sites,
  candidates, candidate_files, candidate_notes, applications, interviews, interview_panelists, interview_feedback, offers to crew_app;
grant select, insert on application_events to crew_app;
grant select, insert, update, delete on all tables in schema public to crew_platform;
grant usage on all sequences in schema public to crew_app, crew_platform;
