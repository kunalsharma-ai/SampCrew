-- Plan builder: SAMPLEDGE decides in the Super Admin Console which modules and limits each plan includes,
-- and a workspace's subscription decides what it can use.
--
-- 1. New modules that used to be available to every workspace now have their own switch:
--    onboarding (onboarding checklists) and email_signatures (signatures, Outlook sync, festival wishes).
--    Every existing plan gets them, so no workspace loses something it had.
-- 2. 'talent' is split into performance, learning and engagement, so a plan can include one without the others.
--    Every place that stored 'talent' (plan contents, workspace switches, member blocks, app switches) is
--    rewritten to the three new keys.
-- 3. plans.customised_at marks a plan whose contents SAMPLEDGE changed in the Console. The catalogue sync that
--    runs on deploy leaves those plans alone (it only adds modules that are new to the catalogue).
--    plans.archived_at hides a plan from new sales; workspaces on it keep it.
-- 4. plan_requests: a workspace admin asks SAMPLEDGE for a plan they cannot switch to themselves
--    (quote-only or hidden). SAMPLEDGE approves (the plan is applied) or declines in the Console.

insert into features (key, name, module, kind) values
  ('onboarding', 'Onboarding checklists for new joiners', 'People', 'boolean'),
  ('email_signatures', 'Email signatures, Outlook sync and festival wishes', 'Communication', 'boolean'),
  ('performance', 'Goals, performance reviews and feedback', 'Performance', 'boolean'),
  ('learning', 'Learning, courses and learning paths', 'Learning', 'boolean'),
  ('engagement', 'Recognition wall, company values and surveys', 'Engagement', 'boolean')
on conflict (key) do nothing;

insert into plan_features (plan_id, feature_key)
select p.id, k from plans p cross join unnest(array['onboarding', 'email_signatures']) as k
on conflict do nothing;

insert into plan_features (plan_id, feature_key)
select pf.plan_id, k from plan_features pf cross join unnest(array['performance', 'learning', 'engagement']) as k
 where pf.feature_key = 'talent'
on conflict do nothing;
delete from plan_features where feature_key = 'talent';

update subscriptions
   set feature_overrides = (feature_overrides - 'talent')
       || jsonb_build_object('performance', feature_overrides->'talent', 'learning', feature_overrides->'talent', 'engagement', feature_overrides->'talent')
 where feature_overrides ? 'talent';

create or replace function pg_temp.split_talent(a text[]) returns text[] language sql immutable as $$
  select case when 'talent' = any(a)
    then array(select distinct x from unnest(array_remove(a, 'talent') || array['performance', 'learning', 'engagement']) as x order by x)
    else a end
$$;
update member_feature_access set blocked_features = pg_temp.split_talent(blocked_features) where 'talent' = any(blocked_features);
update tenant_access_controls
   set web_off_features = pg_temp.split_talent(web_off_features), mobile_off_features = pg_temp.split_talent(mobile_off_features)
 where 'talent' = any(web_off_features) or 'talent' = any(mobile_off_features);

delete from features where key = 'talent';

alter table plans
  add column customised_at timestamptz,
  add column customised_by_admin_id uuid references platform_admins(id) on delete set null,
  add column archived_at timestamptz;

create table plan_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  plan_id uuid not null references plans(id),
  seats int not null check (seats >= 1),
  billing_cycle text not null check (billing_cycle in ('monthly', 'annual')),
  message text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  requested_by_membership_id uuid references memberships(id) on delete set null,
  requested_by_label text not null,
  decided_by_admin_id uuid references platform_admins(id) on delete set null,
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index plan_requests_tenant on plan_requests (tenant_id, created_at desc);
create unique index plan_requests_one_pending on plan_requests (tenant_id) where status = 'pending';

alter table plan_requests enable row level security;
alter table plan_requests force row level security;
create policy tenant_isolation on plan_requests using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());

grant select, insert, update on plan_requests to crew_app;
grant select, insert, update, delete on plan_requests to crew_platform;
