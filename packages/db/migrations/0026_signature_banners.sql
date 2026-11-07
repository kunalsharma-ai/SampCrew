-- Festival, celebration and company banners in email signatures (Kunal, 2026-11-06).
--
-- signature_banners: a company banner is either a festival from the built-in library (contracts
-- signature-occasions.ts) in the company's own words, following the festival's dates unless it has its own, or a
-- custom banner with its own dates. Either can carry an image (PNG, JPEG or GIF) and a link. Each person's own festival
-- picks and message live in employee_signatures.options.wishes, so they need no table.

create table signature_banners (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  occasion_key text check (occasion_key is null or occasion_key ~ '^[a-z0-9-]{1,40}$'),
  title text not null check (length(title) between 1 and 80),
  message text not null check (length(message) between 1 and 200),
  icon text check (icon is null or length(icon) <= 16),
  bg_color text not null default '#1F3A93' check (bg_color ~ '^#[0-9a-fA-F]{6}$'),
  fg_color text not null default '#FFFFFF' check (fg_color ~ '^#[0-9a-fA-F]{6}$'),
  link_url text check (link_url is null or link_url ~ '^https?://' and length(link_url) <= 300),
  starts_on date,
  ends_on date,
  position text not null default 'below' check (position in ('above', 'below')),
  enabled boolean not null default true,
  image_key text,
  image_content_type text check (image_content_type in ('image/png', 'image/jpeg', 'image/gif')),
  image_width integer check (image_width between 1 and 10000),
  image_height integer check (image_height between 1 and 10000),
  image_updated_at timestamptz,
  created_by uuid references memberships(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint signature_banner_dates check ((starts_on is null) = (ends_on is null) and (ends_on is null or ends_on >= starts_on)),
  constraint signature_banner_when check (occasion_key is not null or starts_on is not null),
  constraint signature_banner_image check ((image_key is null) = (image_content_type is null))
);
create unique index signature_banners_occasion on signature_banners (tenant_id, occasion_key) where occasion_key is not null;

alter table signature_banners enable row level security;
alter table signature_banners force row level security;
create policy tenant_isolation on signature_banners using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update, delete on signature_banners to crew_app;
grant select, insert, update, delete on signature_banners to crew_platform;
