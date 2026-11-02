-- Staffing bids: standard rates per role (for every client or for one), and one-off fees on a bid.
create table bid_rate_cards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 2 and 80),
  client_id uuid,
  currency char(3) not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  notes text not null default '' check (length(notes) <= 1000),
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 100),
  archived_at timestamptz,
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references clients (tenant_id, id)
);
create unique index bid_rate_cards_name on bid_rate_cards (tenant_id, lower(name)) where archived_at is null;
create trigger bid_rate_cards_touch before update on bid_rate_cards for each row execute function touch_updated_at();

alter table bid_rate_cards enable row level security;
alter table bid_rate_cards force row level security;
create policy tenant_isolation on bid_rate_cards using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update, delete on bid_rate_cards to crew_app;
grant select, insert, update, delete on bid_rate_cards to crew_platform;

alter table staffing_bids add column rate_card_id uuid;
alter table staffing_bids add constraint staffing_bids_rate_card foreign key (tenant_id, rate_card_id) references bid_rate_cards (tenant_id, id);
alter table staffing_bids add column fees jsonb not null default '[]'::jsonb check (jsonb_typeof(fees) = 'array');
