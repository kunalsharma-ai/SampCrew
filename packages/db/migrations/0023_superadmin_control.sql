-- Phase 16: SAMPLEDGE Super Admin control of every workspace.
--
-- 1. Apps: SAMPLEDGE can switch the Web Portal or the mobile app off for a whole workspace, and switch single
--    modules off in one app only (for example Payroll on the web but not on phones). Stored next to the other
--    workspace switches in tenant_access_controls; customers can read them (so the apps can explain) but not write.
-- 2. Attendance machine integrations: SAMPLEDGE chooses which machine integrations a workspace may use, and can
--    pause a single machine. A paused machine, or one whose integration is switched off, has its pushes refused
--    and logged; nothing it sent before is touched.
-- 3. More attendance machines: besides the ZKTeco / eSSL push protocol, any machine or middleware that can make an
--    HTTPS call can send punches to CREW's device API with a per-machine token (stored as a hash).

alter table tenant_access_controls
  add column web_portal_enabled boolean not null default true,
  add column mobile_app_enabled boolean not null default true,
  add column web_off_features text[] not null default '{}',
  add column mobile_off_features text[] not null default '{}',
  add column device_vendors_disabled text[] not null default '{}';

alter table attendance_devices drop constraint if exists attendance_devices_vendor_check;
alter table attendance_devices add constraint attendance_devices_vendor_check
  check (vendor in ('zkteco', 'essl', 'hikvision', 'matrix', 'realtime', 'suprema', 'generic'));
alter table attendance_devices drop constraint if exists attendance_devices_protocol_check;
alter table attendance_devices add constraint attendance_devices_protocol_check check (protocol in ('push_http', 'device_api'));
-- The ZKTeco / eSSL push protocol only exists on those machines.
alter table attendance_devices add constraint attendance_devices_protocol_vendor
  check (protocol <> 'push_http' or vendor in ('zkteco', 'essl'));

alter table attendance_devices
  add column api_token_hash text unique,
  add column api_token_hint text,
  add column paused_at timestamptz,
  add column paused_reason text check (paused_reason is null or length(paused_reason) between 5 and 300),
  add column paused_by_admin_id uuid references platform_admins(id) on delete set null;

-- A device_api machine always has a token; a push_http machine never has one.
alter table attendance_devices add constraint attendance_devices_token_protocol
  check ((protocol = 'device_api') = (api_token_hash is not null));

alter table device_ingest_log drop constraint if exists device_ingest_log_kind_check;
alter table device_ingest_log add constraint device_ingest_log_kind_check
  check (kind in ('handshake', 'attlog', 'operlog', 'command_result', 'rejected', 'simulated', 'device_api', 'heartbeat'));
