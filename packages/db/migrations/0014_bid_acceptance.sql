-- Online acceptance of staffing proposals. Each recipient of a proposal email gets their own private link (only
-- its SHA-256 is stored), so views and the decision are tied to one address. The client reviews the proposal and accepts it with a typed signature, or declines it with a reason.
-- The evidence (who, when, from where, which PDF) is kept with a signed copy of the PDF.

create table bid_acceptance_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  bid_id uuid not null,
  version_id uuid not null references bid_versions(id) on delete cascade,
  bid_email_id uuid not null references bid_emails(id) on delete cascade,
  sent_to citext not null,
  token_hash text not null unique check (length(token_hash) = 64),
  active_from timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  first_viewed_at timestamptz,
  view_count integer not null default 0,
  decision text check (decision in ('accepted', 'declined')),
  decided_at timestamptz,
  signer_name text check (length(signer_name) <= 120),
  signer_title text check (length(signer_title) <= 120),
  signer_email citext,
  signature text check (length(signature) <= 120),
  decline_reason text check (length(decline_reason) <= 1000),
  decided_ip text,
  decided_user_agent text,
  pdf_sha256 text,
  signed_pdf_storage_key text,
  created_at timestamptz not null default now(),
  check ((decision is null) = (decided_at is null)),
  foreign key (tenant_id, bid_id) references staffing_bids (tenant_id, id) on delete cascade
);
create index bid_acceptance_links_bid on bid_acceptance_links (tenant_id, bid_id, created_at desc);
-- At most one decision per bid.
create unique index bid_acceptance_one_decision on bid_acceptance_links (bid_id) where decision is not null;

alter table bid_acceptance_links enable row level security;
alter table bid_acceptance_links force row level security;
create policy tenant_isolation on bid_acceptance_links using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update on bid_acceptance_links to crew_app;
grant select, insert, update, delete on bid_acceptance_links to crew_platform;
