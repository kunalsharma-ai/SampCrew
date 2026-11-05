-- Phase 3: Attendance and workforce
-- Shift templates, rosters and assignments; attendance policies; raw punches (append-only, deduplicated);
-- computed attendance days; corrections, overtime claims and shift swaps through the approvals engine;
-- period locks; QR kiosks; attendance devices with enrolment-number mappings and an ingest log.

-------------------------------------------------------------------------------
-- Shifts and rosters
-------------------------------------------------------------------------------

create table shift_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_-]{1,12}$'),
  name text not null check (length(name) between 1 and 80),
  start_time time not null,
  end_time time not null,
  break_minutes smallint not null default 0 check (break_minutes between 0 and 240),
  grace_late_minutes smallint not null default 10 check (grace_late_minutes between 0 and 240),
  grace_early_minutes smallint not null default 10 check (grace_early_minutes between 0 and 240),
  half_day_minutes smallint not null default 240 check (half_day_minutes between 0 and 1440),
  full_day_minutes smallint not null default 480 check (full_day_minutes between 0 and 1440),
  overtime_enabled boolean not null default false,
  overtime_min_minutes smallint not null default 30 check (overtime_min_minutes between 0 and 600),
  color text not null default '#0f766e' check (color ~ '^#[0-9a-fA-F]{6}$'),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  check (start_time <> end_time),
  check (half_day_minutes <= full_day_minutes)
);
create trigger shift_templates_touch before update on shift_templates for each row execute function touch_updated_at();

create table rosters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  start_date date not null,
  end_date date not null,
  department_id uuid,
  location_id uuid,
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  published_by uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, department_id) references departments (tenant_id, id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id),
  check (end_date >= start_date and end_date - start_date <= 62)
);
create trigger rosters_touch before update on rosters for each row execute function touch_updated_at();

-- The shift someone works on a date. shift_template_id null means a planned day off.
-- Rows in a draft roster are a plan only; they apply once the roster is published.
create table shift_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  work_date date not null,
  shift_template_id uuid,
  roster_id uuid,
  source text not null default 'manual' check (source in ('manual', 'roster', 'swap')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, employee_id, work_date),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, shift_template_id) references shift_templates (tenant_id, id),
  foreign key (tenant_id, roster_id) references rosters (tenant_id, id) on delete cascade
);
create index shift_assignments_date on shift_assignments (tenant_id, work_date);
create trigger shift_assignments_touch before update on shift_assignments for each row execute function touch_updated_at();

-------------------------------------------------------------------------------
-- Policies
-------------------------------------------------------------------------------

-- One workspace default (location_id null) plus optional per-location overrides.
create table attendance_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid,
  web_punch boolean not null default true,
  mobile_punch boolean not null default true,
  qr_punch boolean not null default true,
  geofence_mode text not null default 'warn' check (geofence_mode in ('off', 'warn', 'enforce')),
  default_shift_id uuid,
  overtime_requires_approval boolean not null default true,
  early_window_minutes smallint not null default 240 check (early_window_minutes between 30 and 720),
  correction_window_days smallint not null default 30 check (correction_window_days between 0 and 366),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id),
  foreign key (tenant_id, default_shift_id) references shift_templates (tenant_id, id)
);
create unique index attendance_policies_one on attendance_policies (tenant_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid));
create trigger attendance_policies_touch before update on attendance_policies for each row execute function touch_updated_at();

-------------------------------------------------------------------------------
-- Devices and kiosks
-------------------------------------------------------------------------------

create table attendance_devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  vendor text not null check (vendor in ('zkteco', 'essl')),
  model text,
  serial_number text not null check (serial_number ~ '^[A-Za-z0-9_-]{4,40}$'),
  protocol text not null default 'push_http' check (protocol in ('push_http')),
  location_id uuid not null,
  time_zone text not null,
  direction_from_device boolean not null default true,
  allowed_ips text[] not null default '{}',
  simulated boolean not null default false,
  expected_interval_seconds integer not null default 300 check (expected_interval_seconds between 30 and 86400),
  -- What the device last told us about itself.
  firmware text,
  reported_user_count integer,
  reported_punch_count integer,
  last_seen_at timestamptz,
  last_punch_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  offline_alerted_at timestamptz,
  records_accepted bigint not null default 0,
  records_duplicate bigint not null default 0,
  records_rejected bigint not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id)
);
-- A push device identifies itself only by serial number, so a serial maps to exactly one live device anywhere.
create unique index attendance_devices_serial on attendance_devices (vendor, upper(serial_number)) where archived_at is null;
create trigger attendance_devices_touch before update on attendance_devices for each row execute function touch_updated_at();

-- Enrolment numbers on devices ("PIN" / user ID) mapped to employees. device_id null applies on every device.
create table device_user_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  device_id uuid,
  device_user_id text not null check (device_user_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  employee_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, device_id) references attendance_devices (tenant_id, id) on delete cascade,
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade
);
create unique index device_user_mappings_one on device_user_mappings (tenant_id, coalesce(device_id, '00000000-0000-0000-0000-000000000000'::uuid), device_user_id);

create table device_ingest_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  device_id uuid not null,
  kind text not null check (kind in ('handshake', 'attlog', 'operlog', 'heartbeat', 'command_result', 'rejected', 'simulated')),
  records integer not null default 0,
  accepted integer not null default 0,
  duplicates integer not null default 0,
  rejected integer not null default 0,
  detail text,
  remote_ip text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, device_id) references attendance_devices (tenant_id, id) on delete cascade
);
create index device_ingest_log_device on device_ingest_log (tenant_id, device_id, created_at desc);

-- A screen at a site that shows a rotating QR code; people scan it with their own phone to punch.
create table attendance_kiosks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  location_id uuid not null,
  token_hash text not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (token_hash),
  foreign key (tenant_id, location_id) references locations (tenant_id, id)
);

-------------------------------------------------------------------------------
-- Raw punches and computed days
-------------------------------------------------------------------------------

-- Every punch from every source, exactly as received. Never updated or deleted; a correction adds new rows.
-- Device punches carry the enrolment number; the employee is resolved through device_user_mappings, so a
-- punch from someone not yet mapped is kept and counted once they are.
create table attendance_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid,
  device_id uuid,
  device_user_id text,
  kiosk_id uuid,
  source text not null check (source in ('web', 'mobile', 'qr', 'device', 'import', 'correction')),
  source_event_id text not null check (length(source_event_id) between 1 and 200),
  captured_at timestamptz not null,
  device_local_time text,
  direction text not null default 'unknown' check (direction in ('in', 'out', 'unknown')),
  verify_method text check (verify_method in ('fingerprint', 'face', 'card', 'pin', 'palm', 'qr', 'unknown')),
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  accuracy_m numeric(8, 1),
  geofence_result text check (geofence_result in ('inside', 'outside', 'unknown', 'not_configured', 'not_required', 'kiosk')),
  distance_m integer,
  correction_id uuid,
  recorded_by_membership_id uuid,
  note text,
  raw jsonb,
  payload_sha256 text,
  remote_ip text,
  -- True when the punch arrived for a date inside a locked period; it is kept but does not change locked days.
  arrived_after_lock boolean not null default false,
  received_at timestamptz not null default now(),
  unique (tenant_id, source, source_event_id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id),
  foreign key (tenant_id, device_id) references attendance_devices (tenant_id, id),
  foreign key (tenant_id, kiosk_id) references attendance_kiosks (tenant_id, id),
  check (employee_id is not null or (device_id is not null and device_user_id is not null))
);
create index attendance_events_employee on attendance_events (tenant_id, employee_id, captured_at);
create index attendance_events_device_user on attendance_events (tenant_id, device_id, device_user_id, captured_at);
create trigger attendance_events_immutable before update or delete on attendance_events for each row execute function reject_mutation();

-- One row per employee and date, written only by the attendance engine from punches, shift, calendar and leave.
create table attendance_days (
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  work_date date not null,
  shift_template_id uuid,
  day_type text not null check (day_type in ('working', 'weekly_off', 'holiday')),
  leave_part text check (leave_part in ('full', 'first_half', 'second_half')),
  status text not null check (status in ('present', 'half_day', 'absent', 'missing_punch', 'on_leave', 'half_day_leave', 'holiday', 'weekly_off', 'in_progress', 'not_joined')),
  first_in timestamptz,
  last_out timestamptz,
  worked_minutes integer not null default 0,
  break_minutes integer not null default 0,
  late_minutes integer not null default 0,
  early_leave_minutes integer not null default 0,
  overtime_minutes integer not null default 0,
  approved_overtime_minutes integer not null default 0,
  flags text[] not null default '{}',
  explanation jsonb not null default '[]',
  punch_count integer not null default 0,
  engine_version smallint not null,
  computed_at timestamptz not null default now(),
  primary key (tenant_id, employee_id, work_date),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, shift_template_id) references shift_templates (tenant_id, id)
);
create index attendance_days_date on attendance_days (tenant_id, work_date, status);

-- Locked periods: days inside are frozen for payroll. Unlocking is recorded, never deleted.
create table attendance_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  legal_entity_id uuid,
  period_start date not null,
  period_end date not null,
  note text,
  locked_at timestamptz not null default now(),
  locked_by uuid,
  unlocked_at timestamptz,
  unlocked_by uuid,
  unlock_reason text,
  unique (tenant_id, id),
  foreign key (tenant_id, legal_entity_id) references legal_entities (tenant_id, id),
  check (period_end >= period_start),
  exclude using gist (tenant_id with =, coalesce(legal_entity_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
                      daterange(period_start, period_end, '[]') with &&) where (unlocked_at is null)
);

-- True when the employee's day falls inside a live lock for their legal entity or the whole workspace.
create or replace function attendance_is_locked(p_employee uuid, p_date date) returns boolean language sql stable as $$
  select exists (
    select 1 from attendance_periods p join employees e on e.id = p_employee and e.tenant_id = p.tenant_id
     where p.tenant_id = app_tenant_id() and p.unlocked_at is null and p_date between p.period_start and p.period_end
       and (p.legal_entity_id is null or p.legal_entity_id = e.current_legal_entity_id)
  )
$$;

-------------------------------------------------------------------------------
-- Requests that go through approvals
-------------------------------------------------------------------------------

create table attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  work_date date not null,
  -- [{"time": "09:05", "direction": "in", "nextDay": false}]
  punches jsonb not null check (jsonb_typeof(punches) = 'array' and jsonb_array_length(punches) between 1 and 6),
  reason text not null check (length(reason) between 3 and 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  approval_request_id uuid,
  requested_by_membership_id uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, approval_request_id) references approval_requests (tenant_id, id)
);
create unique index attendance_corrections_one_pending on attendance_corrections (tenant_id, employee_id, work_date) where status = 'pending';

alter table attendance_events
  add constraint attendance_events_correction_fk foreign key (tenant_id, correction_id) references attendance_corrections (tenant_id, id);

create table overtime_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null,
  work_date date not null,
  minutes integer not null check (minutes between 1 and 1440),
  computed_minutes integer not null,
  reason text check (length(reason) <= 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  approval_request_id uuid,
  requested_by_membership_id uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, approval_request_id) references approval_requests (tenant_id, id)
);
create unique index overtime_claims_one_live on overtime_claims (tenant_id, employee_id, work_date) where status in ('pending', 'approved');

create table shift_swap_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  requester_employee_id uuid not null,
  counterpart_employee_id uuid not null,
  work_date date not null,
  counterpart_date date not null,
  requester_shift_id uuid,
  counterpart_shift_id uuid,
  reason text check (length(reason) <= 500),
  status text not null default 'awaiting_colleague' check (status in ('awaiting_colleague', 'pending', 'approved', 'rejected', 'declined', 'cancelled')),
  approval_request_id uuid,
  requested_by_membership_id uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, requester_employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, counterpart_employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, approval_request_id) references approval_requests (tenant_id, id),
  check (requester_employee_id <> counterpart_employee_id)
);

-------------------------------------------------------------------------------
-- Row-Level Security and grants
-------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'shift_templates', 'rosters', 'shift_assignments', 'attendance_policies', 'attendance_devices', 'device_user_mappings',
    'device_ingest_log', 'attendance_kiosks', 'attendance_events', 'attendance_days', 'attendance_periods',
    'attendance_corrections', 'overtime_claims', 'shift_swap_requests'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select, insert, update, delete on shift_templates, rosters, shift_assignments, attendance_policies, attendance_devices,
  device_user_mappings, attendance_kiosks, attendance_days, attendance_corrections, overtime_claims, shift_swap_requests to crew_app;
grant select, insert, update on attendance_periods to crew_app;
grant select, insert on attendance_events, device_ingest_log to crew_app;
grant execute on function attendance_is_locked(uuid, date) to crew_app;
grant select, insert, update, delete on all tables in schema public to crew_platform;
grant usage on all sequences in schema public to crew_app, crew_platform;
