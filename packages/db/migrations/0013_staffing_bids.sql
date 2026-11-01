-- Staffing bids: clients, proposal templates, priced bids with one line per role, an immutable version per
-- submission and per proposal sent (proposal history), and scheduled proposal emails with the PDF attached.
-- Also lets queued emails carry stored attachments and be cancelled before they go.

create table clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 2 and 120),
  legal_name text,
  industry text,
  contact_name text,
  contact_email citext,
  contact_phone text,
  address text,
  currency char(3) not null default 'INR',
  notes text,
  archived_at timestamptz,
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index clients_name on clients (tenant_id, lower(name));
create trigger clients_touch before update on clients for each row execute function touch_updated_at();

create table bid_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 2 and 80),
  cover_note text not null default '',
  terms text not null default '',
  validity_days smallint not null default 30 check (validity_days between 1 and 180),
  on_cost_pct numeric(5,2) not null default 13 check (on_cost_pct between 0 and 999.99),
  overhead_pct numeric(5,2) not null default 5 check (overhead_pct between 0 and 999.99),
  target_margin_pct numeric(5,2) not null default 18 check (target_margin_pct >= 0 and target_margin_pct < 100),
  is_default boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index bid_templates_name on bid_templates (tenant_id, lower(name)) where archived_at is null;
create unique index bid_templates_one_default on bid_templates (tenant_id) where is_default and archived_at is null;
create trigger bid_templates_touch before update on bid_templates for each row execute function touch_updated_at();

create table staffing_bids (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null,
  client_id uuid not null,
  legal_entity_id uuid not null,
  title text not null check (length(title) between 3 and 160),
  mode text not null default 'advanced' check (mode in ('quick', 'advanced')),
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved', 'rejected', 'sent', 'won', 'lost', 'withdrawn')),
  currency char(3) not null default 'INR',
  start_date date not null,
  duration_months smallint not null check (duration_months between 1 and 120),
  on_cost_pct numeric(5,2) not null,
  overhead_pct numeric(5,2) not null,
  target_margin_pct numeric(5,2) not null check (target_margin_pct >= 0 and target_margin_pct < 100),
  template_id uuid,
  cover_note text not null default '',
  terms text not null default '',
  valid_until date,
  -- Totals at the last save, for lists and reports (the lines are the source of truth).
  headcount integer not null default 0,
  monthly_revenue numeric(14,2) not null default 0,
  contract_revenue numeric(16,2) not null default 0,
  margin_pct numeric(7,2) not null default 0,
  version integer not null default 1,
  approval_request_id uuid,
  owner_membership_id uuid not null,
  submitted_at timestamptz,
  approved_at timestamptz,
  sent_at timestamptz,
  decided_at timestamptz,
  outcome_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  foreign key (tenant_id, client_id) references clients (tenant_id, id),
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id),
  foreign key (tenant_id, template_id) references bid_templates (tenant_id, id),
  foreign key (tenant_id, approval_request_id) references approval_requests (tenant_id, id),
  foreign key (tenant_id, owner_membership_id) references memberships (tenant_id, id)
);
create index staffing_bids_list on staffing_bids (tenant_id, status, updated_at desc);
create index staffing_bids_client on staffing_bids (tenant_id, client_id);
create trigger staffing_bids_touch before update on staffing_bids for each row execute function touch_updated_at();

create table bid_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  bid_id uuid not null,
  seq smallint not null,
  role_title text not null check (length(role_title) between 2 and 120),
  designation_id uuid,
  headcount integer not null check (headcount between 1 and 10000),
  location text,
  pay_monthly numeric(14,2) not null check (pay_monthly > 0),
  bill_monthly numeric(14,2) check (bill_monthly > 0),
  notes text,
  unique (bid_id, seq),
  foreign key (tenant_id, bid_id) references staffing_bids (tenant_id, id) on delete cascade,
  foreign key (tenant_id, designation_id) references designations (tenant_id, id)
);

-- One row per submission for approval and per proposal sent: the bid exactly as it was, with its pricing and
-- (for sent proposals) the PDF the client received.
create table bid_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  bid_id uuid not null,
  version integer not null,
  event text not null check (event in ('submitted', 'sent')),
  snapshot jsonb not null,
  pricing jsonb not null,
  pdf_storage_key text,
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, bid_id) references staffing_bids (tenant_id, id) on delete cascade
);
create index bid_versions_bid on bid_versions (tenant_id, bid_id, created_at desc);

create table bid_emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  bid_id uuid not null,
  version_id uuid not null references bid_versions(id) on delete cascade,
  to_email citext not null,
  cc text[] not null default '{}',
  subject text not null,
  message text not null,
  send_at timestamptz not null,
  email_message_ids uuid[] not null default '{}',
  cancelled_at timestamptz,
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, bid_id) references staffing_bids (tenant_id, id) on delete cascade
);
create index bid_emails_bid on bid_emails (tenant_id, bid_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['clients', 'bid_templates', 'staffing_bids', 'bid_lines', 'bid_versions', 'bid_emails'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select, insert, update, delete on clients, bid_templates, staffing_bids, bid_lines, bid_versions, bid_emails to crew_app;
grant select, insert, update, delete on clients, bid_templates, staffing_bids, bid_lines, bid_versions, bid_emails to crew_platform;

-- Queued emails can carry stored files (the proposal PDF) and be cancelled before they are sent.
alter table email_messages add column attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array');
alter table email_messages drop constraint email_messages_status_check;
alter table email_messages add constraint email_messages_status_check check (status in ('queued', 'sent', 'failed', 'skipped', 'cancelled'));

-- New permissions for existing workspaces' system roles (new workspaces get them from the role catalogue).
insert into role_permissions (tenant_id, role_id, permission, scope)
select r.tenant_id, r.id, g.permission, g.scope
from roles r
join (values
  ('tenant_owner', 'bids:read', 'tenant'), ('tenant_owner', 'bids:manage', 'tenant'), ('tenant_owner', 'bids:approve', 'tenant'),
  ('hr_admin', 'bids:read', 'tenant'), ('hr_admin', 'bids:approve', 'tenant'),
  ('recruiter', 'bids:read', 'tenant'), ('recruiter', 'bids:manage', 'tenant'),
  ('finance_manager', 'bids:read', 'tenant'), ('finance_manager', 'bids:approve', 'tenant'))
  as g(role_key, permission, scope) on g.role_key = r.key
where r.is_system
on conflict (role_id, permission) do nothing;
