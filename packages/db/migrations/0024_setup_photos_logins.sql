-- SAMPLEDGE feedback on CREW (2026-11-06):
-- 1. Employee photos: one current photo per employee, stored by the storage driver like documents.
-- 2. Attendance registration at hire: a person's own default shift (used before the location policy's shift),
--    alongside the device enrolment numbers that already live in device_user_mappings.
-- 3. Login credentials at hire: HR can create the login with a temporary password; the person must choose
--    their own password at first sign-in.
-- 4. First-login company setup: company profile fields and setup progress on the workspace.

alter table employees
  add column photo_key text,
  add column photo_content_type text check (photo_content_type in ('image/png', 'image/jpeg', 'image/webp')),
  add column photo_updated_at timestamptz,
  add column default_shift_id uuid,
  add constraint employees_photo_complete check ((photo_key is null) = (photo_content_type is null)),
  add constraint employees_default_shift_fk foreign key (tenant_id, default_shift_id) references shift_templates (tenant_id, id);

alter table users add column must_change_password boolean not null default false;

alter table tenants
  add column industry text check (industry in ('it_services', 'manufacturing', 'retail', 'healthcare', 'staffing', 'financial_services', 'education', 'logistics', 'hospitality', 'construction', 'other')),
  add column company_size text check (company_size in ('1-10', '11-50', '51-200', '201-500', '501-1000', '1000+')),
  add column website text check (website is null or website ~ '^https?://' and length(website) <= 200),
  add column contact_email citext check (contact_email is null or position('@' in contact_email) > 1),
  add column contact_phone text check (contact_phone is null or length(contact_phone) <= 30),
  add column setup_step smallint not null default 0 check (setup_step between 0 and 10),
  add column setup_completed_at timestamptz;

-- Workspaces that already have people were set up before this existed; only new and empty ones get the tour.
update tenants t set setup_completed_at = now() where exists (select 1 from employees e where e.tenant_id = t.id);

grant select (industry, company_size, website, contact_email, contact_phone, setup_step, setup_completed_at) on tenants to crew_app;
grant update (industry, company_size, website, contact_email, contact_phone, setup_step, setup_completed_at) on tenants to crew_app;
