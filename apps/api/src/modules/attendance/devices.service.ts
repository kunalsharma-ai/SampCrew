import { BlockList, isIP } from 'node:net';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import { createHash } from 'node:crypto';
import { DEVICE_INTEGRATIONS, deviceProtocolFor, zonedTime, type DeviceApiPunches, type DeviceInput, type deviceMappingInput, type simulateInput } from '@crew/contracts';
import { randomToken, sha256 } from '../../platform/auth/crypto';
import { AuditService } from '../../platform/audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { AttendanceDaysService, EVENT_EMPLOYEE } from './attendance-days.service';
import { attlogLines, handshakeResponse, parseAttlog, parseInfo, type ParseResult } from './zk-push';

/** Machine tokens for the device API start with this, so they are easy to recognise (and to find in leaked text). */
export const DEVICE_TOKEN_PREFIX = 'crewdev_';

const { addDays, localToday, hhmm, toLocal } = zonedTime;

interface DeviceRow {
  id: string;
  tenant_id: string;
  name: string;
  vendor: string;
  protocol: string;
  paused_at: Date | null;
  vendor_off: boolean;
  serial_number: string;
  time_zone: string;
  direction_from_device: boolean;
  allowed_ips: string[];
  simulated: boolean;
  expected_interval_seconds: number;
  last_seen_at: Date | null;
  last_error_at: Date | null;
}

export type DeviceStatus = 'online' | 'delayed' | 'offline' | 'waiting' | 'error' | 'simulated' | 'paused';

/** Honest status: online only if we heard from the device within its expected interval. */
export function deviceStatus(d: { simulated: boolean; last_seen_at: Date | string | null; last_error_at: Date | string | null; expected_interval_seconds: number }, now = Date.now()): DeviceStatus {
  if (d.simulated) return 'simulated';
  if (!d.last_seen_at) return 'waiting';
  const seen = new Date(d.last_seen_at).getTime();
  if (d.last_error_at && new Date(d.last_error_at).getTime() > seen) return 'error';
  const age = (now - seen) / 1000;
  if (age <= d.expected_interval_seconds * 2) return 'online';
  if (age <= d.expected_interval_seconds * 6) return 'delayed';
  return 'offline';
}

function ipAllowed(list: string[], ip: string | null): boolean {
  if (!list.length) return true;
  if (!ip) return false;
  const addr = ip.replace(/^::ffff:/, '');
  const family = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
  const block = new BlockList();
  for (const entry of list) {
    const [net, bits] = entry.split('/');
    const f = isIP(net!) === 6 ? 'ipv6' : 'ipv4';
    if (bits) block.addSubnet(net!, Number(bits), f);
    else block.addAddress(net!, f);
  }
  return block.check(addr, family);
}

const DEVICE_COLUMNS = `d.id, d.name, d.vendor, d.model, d.serial_number as "serialNumber", d.protocol, d.location_id as "locationId", l.name as "locationName",
  d.time_zone as "timeZone", d.direction_from_device as "directionFromDevice", d.allowed_ips as "allowedIps", d.simulated, d.expected_interval_seconds as "expectedIntervalSeconds",
  d.firmware, d.reported_user_count as "reportedUserCount", d.reported_punch_count as "reportedPunchCount", d.last_seen_at as "lastSeenAt", d.last_punch_at as "lastPunchAt",
  d.last_error as "lastError", d.last_error_at as "lastErrorAt", d.records_accepted::int as "recordsAccepted", d.records_duplicate::int as "recordsDuplicate",
  d.records_rejected::int as "recordsRejected", d.archived_at as "archivedAt", d.created_at as "createdAt", d.last_error_at as last_error_at, d.last_seen_at as last_seen_at,
  d.paused_at as "pausedAt", d.paused_reason as "pausedReason", d.api_token_hint as "tokenHint",
  d.vendor = any(coalesce((select c.device_vendors_disabled from tenant_access_controls c), '{}')) as "integrationOff"`;

/**
 * Attendance devices: registration, health, enrolment-number mappings, and the ZKTeco/eSSL push endpoint.
 */
@Injectable()
export class DevicesService {
  private readonly logger = new Logger('Devices');

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly days: AttendanceDaysService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private shape<T extends { simulated: boolean; last_seen_at: Date | null; last_error_at: Date | null; expectedIntervalSeconds: number; pausedAt?: Date | null; integrationOff?: boolean }>(row: T) {
    const { last_seen_at, last_error_at, ...rest } = row;
    // Paused by SAMPLEDGE (one machine, or its whole integration): pushes are refused until it is resumed.
    const status: DeviceStatus = row.pausedAt || row.integrationOff ? 'paused' : deviceStatus({ simulated: row.simulated, last_seen_at, last_error_at, expected_interval_seconds: row.expectedIntervalSeconds });
    return { ...rest, status };
  }

  /** The machine integrations this workspace may use (SAMPLEDGE chooses them in the Console). */
  async integrations() {
    return this.db.tenant(async (tx) => {
      const c = await one<{ off: string[] }>(tx, 'select device_vendors_disabled as off from tenant_access_controls');
      const off = new Set(c?.off ?? []);
      return DEVICE_INTEGRATIONS.map((i) => ({ ...i, enabled: !off.has(i.key) }));
    });
  }

  async list() {
    return this.db.tenant(async (tx) => {
      const rows = await many<{ id: string; simulated: boolean; last_seen_at: Date | null; last_error_at: Date | null; expectedIntervalSeconds: number }>(
        tx,
        `select ${DEVICE_COLUMNS},
                (select count(distinct ev.device_user_id)::int from attendance_events ev where ev.device_id = d.id and ${EVENT_EMPLOYEE} is null) as "unmappedUsers"
           from attendance_devices d join locations l on l.id = d.location_id
          where d.archived_at is null order by d.name`,
      );
      return rows.map((r) => this.shape(r));
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const row = await one<{ id: string; simulated: boolean; serialNumber: string; last_seen_at: Date | null; last_error_at: Date | null; expectedIntervalSeconds: number }>(
        tx, `select ${DEVICE_COLUMNS} from attendance_devices d join locations l on l.id = d.location_id where d.id = $1`, [id],
      );
      if (!row) throw Errors.notFound('Device');
      const seenUsers = await many<{ deviceUserId: string; punches: number; lastPunchAt: string; employeeId: string | null; employeeName: string | null }>(
        tx,
        `select ev.device_user_id as "deviceUserId", count(*)::int as punches, max(ev.captured_at) as "lastPunchAt", x.employee_id as "employeeId",
                trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as "employeeName"
           from attendance_events ev
           left join lateral (select ${EVENT_EMPLOYEE} as employee_id) x on true
           left join employees e on e.id = x.employee_id
          where ev.device_id = $1 group by ev.device_user_id, x.employee_id, e.preferred_name, e.first_name, e.last_name order by ev.device_user_id`,
        [id],
      );
      const log = await many(tx, `select id, kind, records, accepted, duplicates, rejected, detail, remote_ip as "remoteIp", created_at as "createdAt" from device_ingest_log where device_id = $1 order by created_at desc limit 50`, [id]);
      const base = this.config.API_PUBLIC_URL.replace(/\/$/, '');
      const url = new URL(base);
      return {
        ...this.shape(row),
        users: seenUsers,
        coverage: { seen: seenUsers.length, mapped: seenUsers.filter((u) => u.employeeId).length },
        log,
        setup: (row as unknown as { protocol: string }).protocol === 'device_api'
          ? {
              // What the machine's bridge or middleware calls, with the machine token as a Bearer token.
              protocol: 'device_api' as const,
              punchesUrl: `${base}/api/v1/device-api/punches`,
              heartbeatUrl: `${base}/api/v1/device-api/heartbeat`,
              tokenHint: (row as unknown as { tokenHint: string | null }).tokenHint,
              serialNumber: row.serialNumber,
            }
          : {
              // What to enter in the device's cloud / ADMS server settings.
              protocol: 'push_http' as const,
              serverAddress: url.hostname,
              serverPort: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
              https: url.protocol === 'https:',
              path: '/iclock/cdata',
              serialNumber: row.serialNumber,
            },
      };
    });
  }

  async create(input: DeviceInput) {
    return this.db.tenant(async (tx) => {
      const integration = DEVICE_INTEGRATIONS.find((i) => i.key === input.vendor)!;
      const protocol = deviceProtocolFor(input.vendor, input.protocol);
      if (!integration.protocols.includes(protocol)) throw Errors.badRequest('protocol_not_supported', `${integration.name} machines connect through the device API, not the ZKTeco push protocol.`);
      const off = (await one<{ off: string[] }>(tx, 'select device_vendors_disabled as off from tenant_access_controls'))?.off ?? [];
      if (off.includes(input.vendor)) throw Errors.forbidden(`The ${integration.name} integration is switched off for this workspace by SAMPLEDGE.`);
      const loc = await one<{ timezone: string }>(tx, 'select timezone from locations where id = $1 and archived_at is null', [input.locationId]);
      if (!loc) throw Errors.badRequest('invalid_location', 'Location not found');
      const token = protocol === 'device_api' && !input.simulated ? `${DEVICE_TOKEN_PREFIX}${randomToken(32)}` : protocol === 'device_api' ? `${DEVICE_TOKEN_PREFIX}sim_${randomToken(16)}` : null;
      const row = (await one<{ id: string }>(
        tx,
        `insert into attendance_devices (tenant_id, name, vendor, model, serial_number, location_id, time_zone, direction_from_device, allowed_ips, simulated, expected_interval_seconds, protocol, api_token_hash, api_token_hint)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [input.name, input.vendor, input.model ?? null, input.serialNumber, input.locationId, input.timeZone ?? loc.timezone, input.directionFromDevice, input.allowedIps, input.simulated, input.expectedIntervalSeconds,
          protocol, token ? sha256(token) : null, token ? token.slice(-4) : null],
      ).catch((err: { code?: string }) => {
        if (err.code === '23505') throw Errors.conflict('serial_registered', 'A device with this serial number is already registered. Archive it there first.');
        throw err;
      }))!;
      await this.audit.record(tx, { action: 'device.registered', resourceType: 'attendance_device', resourceId: row.id, changes: { ...input, protocol } });
      // The token is shown once; only its hash is kept.
      return { id: row.id, protocol, token: token ?? undefined };
    });
  }

  /** Issues a new device API token; the old one stops working at once. */
  async rotateToken(id: string) {
    return this.db.tenant(async (tx) => {
      const d = await one<{ protocol: string }>(tx, 'select protocol from attendance_devices where id = $1 and archived_at is null', [id]);
      if (!d) throw Errors.notFound('Device');
      if (d.protocol !== 'device_api') throw Errors.badRequest('no_token', 'This machine uses the ZKTeco push protocol, which identifies it by serial number. It has no token.');
      const token = `${DEVICE_TOKEN_PREFIX}${randomToken(32)}`;
      await tx.query('update attendance_devices set api_token_hash = $2, api_token_hint = $3 where id = $1', [id, sha256(token), token.slice(-4)]);
      await this.audit.record(tx, { action: 'device.token_rotated', resourceType: 'attendance_device', resourceId: id });
      return { id, token };
    });
  }

  async update(id: string, input: Partial<DeviceInput>) {
    return this.db.tenant(async (tx) => {
      const cols: Record<string, string> = { name: 'name', model: 'model', locationId: 'location_id', timeZone: 'time_zone', directionFromDevice: 'direction_from_device', allowedIps: 'allowed_ips', expectedIntervalSeconds: 'expected_interval_seconds' };
      const entries = Object.entries(input).filter(([k, v]) => cols[k] && v !== undefined);
      if (!entries.length) throw Errors.badRequest('nothing_to_change', 'Send at least one field to change');
      if (input.locationId && !(await one(tx, 'select 1 from locations where id = $1', [input.locationId]))) throw Errors.badRequest('invalid_location', 'Location not found');
      const r = await tx.query(`update attendance_devices set ${entries.map(([k], i) => `${cols[k]} = $${i + 2}`).join(', ')} where id = $1 and archived_at is null`, [id, ...entries.map(([, v]) => v)]);
      if (!r.rowCount) throw Errors.notFound('Device');
      await this.audit.record(tx, { action: 'device.updated', resourceType: 'attendance_device', resourceId: id, changes: Object.fromEntries(entries) });
      return { id };
    });
  }

  async archive(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.query('update attendance_devices set archived_at = now() where id = $1 and archived_at is null', [id]);
      if (!r.rowCount) throw Errors.notFound('Device');
      await this.audit.record(tx, { action: 'device.archived', resourceType: 'attendance_device', resourceId: id });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Mappings
  // ---------------------------------------------------------------------------------------------------------

  listMappings() {
    return this.db.tenant((tx) =>
      many(tx, `select m.id, m.device_id as "deviceId", d.name as "deviceName", m.device_user_id as "deviceUserId", m.employee_id as "employeeId",
                       trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as "employeeName", e.employee_code as "employeeCode", m.created_at as "createdAt"
                  from device_user_mappings m join employees e on e.id = m.employee_id left join attendance_devices d on d.id = m.device_id
                 order by m.device_user_id`),
    );
  }

  async map(input: z.infer<typeof deviceMappingInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      if (!(await one(tx, 'select 1 from employees where id = $1', [input.employeeId]))) throw Errors.badRequest('invalid_employee', 'Employee not found');
      if (input.deviceId && !(await one(tx, 'select 1 from attendance_devices where id = $1', [input.deviceId]))) throw Errors.badRequest('invalid_device', 'Device not found');
      const row = (await one<{ id: string }>(
        tx, `insert into device_user_mappings (tenant_id, device_id, device_user_id, employee_id, created_by) values (app_tenant_id(), $1, $2, $3, $4) returning id`,
        [input.deviceId, input.deviceUserId, input.employeeId, actor.userId],
      ).catch((err: { code?: string }) => {
        if (err.code === '23505') throw Errors.conflict('already_mapped', `Enrolment number ${input.deviceUserId} is already mapped${input.deviceId ? ' on this device' : ''}.`);
        throw err;
      }))!;
      await this.audit.record(tx, { action: 'device_mapping.created', resourceType: 'employee', resourceId: input.employeeId, changes: input });
      // Punches already received from this enrolment number now count for the employee.
      await this.recomputeMapped(tx, input.employeeId, input.deviceUserId, input.deviceId);
      return { id: row.id };
    });
  }

  private async recomputeMapped(tx: Tx, employeeId: string, deviceUserId: string, deviceId: string | null) {
    const span = await one<{ first: Date | null; last: Date | null }>(
      tx, `select min(captured_at) as first, max(captured_at) as last from attendance_events where device_user_id = $1 and ($2::uuid is null or device_id = $2) and captured_at > now() - interval '62 days'`,
      [deviceUserId, deviceId],
    );
    if (!span?.first || !span.last) return;
    const e = await this.days.employee(tx, employeeId);
    if (!e) return;
    const from = addDays(toLocal(span.first.getTime(), e.tz).date, -1);
    const to = toLocal(span.last.getTime(), e.tz).date;
    const today = localToday(e.tz);
    const start = from < e.date_of_joining ? e.date_of_joining : from;
    const end = to > today ? today : to;
    if (start <= end) await this.days.recompute(tx, e.id, start, end);
  }

  async unmap(id: string) {
    return this.db.tenant(async (tx) => {
      const m = await one<{ employee_id: string; device_user_id: string; device_id: string | null }>(tx, 'delete from device_user_mappings where id = $1 returning employee_id, device_user_id, device_id', [id]);
      if (!m) throw Errors.notFound('Mapping');
      await this.audit.record(tx, { action: 'device_mapping.removed', resourceType: 'employee', resourceId: m.employee_id, metadata: { deviceUserId: m.device_user_id } });
      await this.recomputeMapped(tx, m.employee_id, m.device_user_id, m.device_id);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Push protocol ingest (no user session: the device is identified by its registered serial number)
  // ---------------------------------------------------------------------------------------------------------

  private async findDevice(by: { serial: string } | { tokenHash: string }): Promise<DeviceRow | undefined> {
    const bySerial = 'serial' in by;
    return this.db.platform((tx) =>
      one<DeviceRow>(
        tx,
        `select d.id, d.tenant_id, d.name, d.vendor, d.protocol, d.serial_number, d.time_zone, d.direction_from_device, d.allowed_ips, d.simulated, d.expected_interval_seconds,
                d.last_seen_at, d.last_error_at, d.paused_at, d.vendor = any(coalesce(c.device_vendors_disabled, '{}')) as vendor_off
           from attendance_devices d join tenants t on t.id = d.tenant_id left join tenant_access_controls c on c.tenant_id = d.tenant_id
          where ${bySerial ? `upper(d.serial_number) = upper($1) and d.protocol = 'push_http'` : 'd.api_token_hash = $1'} and d.archived_at is null and t.status = 'active'`,
        [bySerial ? by.serial : by.tokenHash],
      ),
    );
  }

  private async authorise(serial: string | undefined, ip: string | null): Promise<DeviceRow> {
    const d = serial && /^[A-Za-z0-9_-]{4,40}$/.test(serial) ? await this.findDevice({ serial }) : undefined;
    if (!d) {
      this.logger.warn(`Push from unregistered serial ${String(serial).slice(0, 40)} (${ip ?? 'unknown ip'})`);
      throw Errors.unauthorized('Unknown device');
    }
    return this.admit(d, ip);
  }

  /** Checks shared by both protocols: simulated, allowed addresses, and SAMPLEDGE's pause or integration switch. */
  private async admit(d: DeviceRow, ip: string | null): Promise<DeviceRow> {
    if (d.simulated) throw Errors.forbidden('This device is registered as simulated');
    const refuse = async (detail: string, error: string) => {
      await this.db.tenant(async (tx) => {
        await tx.query(`insert into device_ingest_log (tenant_id, device_id, kind, detail, remote_ip) values ($1, $2, 'rejected', $3, $4)`, [d.tenant_id, d.id, detail, ip]);
        await tx.query(`update attendance_devices set last_error = $2, last_error_at = now() where id = $1`, [d.id, error]);
      }, { tenantId: d.tenant_id });
    };
    if (!ipAllowed(d.allowed_ips, ip)) {
      await refuse('address not on the allowed list', 'Connection from an address not on the allowed list');
      throw Errors.forbidden('Address not allowed for this device');
    }
    if (d.paused_at || d.vendor_off) {
      const why = d.paused_at ? 'machine paused by SAMPLEDGE' : 'machine integration switched off by SAMPLEDGE';
      await refuse(why, `Refused: ${why}`);
      throw Errors.forbidden(`This machine is not accepted: ${why}.`);
    }
    return d;
  }

  // ---------------------------------------------------------------------------------------------------------
  // CREW device API (any machine, bridge or middleware; identified by its machine token)
  // ---------------------------------------------------------------------------------------------------------

  private async byToken(authorization: string | undefined, ip: string | null): Promise<DeviceRow> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!token.startsWith(DEVICE_TOKEN_PREFIX) || token.length > 120) throw Errors.unauthorized('Send the machine token as a Bearer token');
    const d = await this.findDevice({ tokenHash: sha256(token) });
    if (!d) {
      this.logger.warn(`Device API call with an unknown token (${ip ?? 'unknown ip'})`);
      throw Errors.unauthorized('Unknown machine token');
    }
    return this.admit(d, ip);
  }

  async apiHeartbeat(authorization: string | undefined, body: { firmware?: string; users?: number; records?: number }, ip: string | null) {
    const d = await this.byToken(authorization, ip);
    await this.db.tenant(async (tx) => {
      await tx.query(
        `update attendance_devices set last_seen_at = now(), firmware = coalesce($2, firmware), reported_user_count = coalesce($3, reported_user_count), reported_punch_count = coalesce($4, reported_punch_count) where id = $1`,
        [d.id, body.firmware ?? null, body.users ?? null, body.records ?? null],
      );
      await tx.query(`insert into device_ingest_log (tenant_id, device_id, kind, remote_ip) values ($1, $2, 'heartbeat', $3)`, [d.tenant_id, d.id, ip]);
    }, { tenantId: d.tenant_id });
    return { ok: true, device: d.name, serverTime: new Date().toISOString() };
  }

  async apiPunches(authorization: string | undefined, body: DeviceApiPunches, ip: string | null) {
    const d = await this.byToken(authorization, ip);
    const parsed = parseDeviceApi(body, d.id, d.time_zone, d.direction_from_device);
    const r = await this.db.tenant(async (tx) => {
      if (body.device) {
        await tx.query(`update attendance_devices set firmware = coalesce($2, firmware), reported_user_count = coalesce($3, reported_user_count), reported_punch_count = coalesce($4, reported_punch_count) where id = $1`,
          [d.id, body.device.firmware ?? null, body.device.users ?? null, body.device.records ?? null]);
      }
      return this.storeParsed(tx, d, parsed, ip, 'device_api');
    }, { tenantId: d.tenant_id });
    return { ...r, received: body.punches.length };
  }

  async handshake(serial: string | undefined, query: Record<string, string>, ip: string | null) {
    const d = await this.authorise(serial, ip);
    await this.db.tenant(async (tx) => {
      await tx.query(`update attendance_devices set last_seen_at = now(), firmware = coalesce($2, firmware) where id = $1`, [d.id, query.pushver ? `push ${query.pushver}`.slice(0, 80) : null]);
      await tx.query(`insert into device_ingest_log (tenant_id, device_id, kind, detail, remote_ip) values ($1, $2, 'handshake', $3, $4)`, [d.tenant_id, d.id, query.pushver ? `push version ${query.pushver}` : null, ip]);
    }, { tenantId: d.tenant_id });
    return handshakeResponse(d.serial_number);
  }

  async heartbeat(serial: string | undefined, query: Record<string, string>, ip: string | null) {
    const d = await this.authorise(serial, ip);
    const info = parseInfo(query.INFO);
    await this.db.tenant((tx) =>
      tx.query(
        `update attendance_devices set last_seen_at = now(), firmware = coalesce($2, firmware), reported_user_count = coalesce($3, reported_user_count), reported_punch_count = coalesce($4, reported_punch_count) where id = $1`,
        [d.id, info.firmware, info.users, info.records],
      ), { tenantId: d.tenant_id });
    // No commands are sent to devices in this version.
    return 'OK';
  }

  async commandResult(serial: string | undefined, ip: string | null) {
    const d = await this.authorise(serial, ip);
    await this.db.tenant((tx) => tx.query(`insert into device_ingest_log (tenant_id, device_id, kind, remote_ip) values ($1, $2, 'command_result', $3)`, [d.tenant_id, d.id, ip]), { tenantId: d.tenant_id });
    return 'OK';
  }

  async upload(serial: string | undefined, query: Record<string, string>, body: string, ip: string | null) {
    const d = await this.authorise(serial, ip);
    const table = (query.table ?? '').toUpperCase();
    if (table !== 'ATTLOG') {
      // Operation logs, photos and user records are acknowledged so the device does not resend them, and not stored.
      const lines = body.split(/\r?\n/).filter(Boolean).length;
      await this.db.tenant(async (tx) => {
        await tx.query(`update attendance_devices set last_seen_at = now() where id = $1`, [d.id]);
        await tx.query(`insert into device_ingest_log (tenant_id, device_id, kind, records, detail, remote_ip) values ($1, $2, 'operlog', $3, $4, $5)`, [d.tenant_id, d.id, lines, `table ${table || 'unknown'} acknowledged, not stored`, ip]);
      }, { tenantId: d.tenant_id });
      return `OK: ${lines}`;
    }
    const r = await this.db.tenant((tx) => this.store(tx, d, body, ip, 'attlog'), { tenantId: d.tenant_id });
    return `OK: ${r.accepted + r.duplicates}`;
  }

  /** Parses and stores an ATTLOG body, then recomputes the days it touches. Shared by the push endpoint and the simulator. */
  private async store(tx: Tx, d: Pick<DeviceRow, 'id' | 'tenant_id' | 'serial_number' | 'time_zone' | 'direction_from_device'>, body: string, ip: string | null, kind: 'attlog' | 'simulated') {
    return this.storeParsed(tx, d, parseAttlog(body, d.serial_number, d.time_zone, d.direction_from_device), ip, kind);
  }

  private async storeParsed(tx: Tx, d: Pick<DeviceRow, 'id' | 'tenant_id'>, parsed: ParseResult, ip: string | null, kind: 'attlog' | 'simulated' | 'device_api') {
    let accepted = 0;
    let duplicates = 0;
    const touched = new Map<string, number[]>();
    for (const p of parsed.punches) {
      const mapped = await one<{ employee_id: string }>(
        tx, `select employee_id from device_user_mappings where device_user_id = $1 and (device_id = $2 or device_id is null) order by device_id nulls last limit 1`,
        [p.deviceUserId, d.id],
      );
      let locked = false;
      if (mapped) {
        const e = await this.days.employee(tx, mapped.employee_id);
        if (e) locked = (await one<{ locked: boolean }>(tx, 'select attendance_is_locked($1, $2) as locked', [e.id, toLocal(p.capturedAt, e.tz).date]))!.locked;
      }
      const ins = await tx.query(
        `insert into attendance_events (tenant_id, device_id, device_user_id, source, source_event_id, captured_at, device_local_time, direction, verify_method, geofence_result, raw, payload_sha256, remote_ip, arrived_after_lock)
         values ($1, $2, $3, 'device', $4, $5, $6, $7, $8, 'not_required', $9, $4, $10, $11) on conflict (tenant_id, source, source_event_id) do nothing`,
        [d.tenant_id, d.id, p.deviceUserId, p.sourceEventId, new Date(p.capturedAt), p.localTime, p.direction, p.verifyMethod, JSON.stringify({ line: p.raw }), ip, locked],
      );
      if (ins.rowCount) {
        accepted++;
        if (mapped && !locked) touched.set(mapped.employee_id, [...(touched.get(mapped.employee_id) ?? []), p.capturedAt]);
      } else duplicates++;
    }
    for (const [employeeId, times] of touched) {
      const e = (await this.days.employee(tx, employeeId))!;
      const dates = times.flatMap((t) => this.days.datesFor(e, t)).sort();
      const today = localToday(e.tz);
      const from = dates[0]! < e.date_of_joining ? e.date_of_joining : dates[0]!;
      const to = dates[dates.length - 1]! > today ? today : dates[dates.length - 1]!;
      if (from <= to) await this.days.recompute(tx, employeeId, from, to);
    }
    const last = parsed.punches.reduce((m, p) => Math.max(m, p.capturedAt), 0);
    await tx.query(
      `update attendance_devices set last_seen_at = case when $6 then last_seen_at else now() end, last_punch_at = greatest(last_punch_at, $2),
              records_accepted = records_accepted + $3, records_duplicate = records_duplicate + $4, records_rejected = records_rejected + $5,
              last_error = case when $5 > 0 then $7 else last_error end, last_error_at = case when $5 > 0 then now() else last_error_at end
        where id = $1`,
      [d.id, last ? new Date(last) : null, accepted, duplicates, parsed.rejected.length, kind === 'simulated', parsed.rejected[0] ? `${parsed.rejected.length} record(s) could not be read: ${parsed.rejected[0].reason}` : null],
    );
    await tx.query(
      `insert into device_ingest_log (tenant_id, device_id, kind, records, accepted, duplicates, rejected, detail, remote_ip) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [d.tenant_id, d.id, kind, parsed.punches.length + parsed.rejected.length, accepted, duplicates, parsed.rejected.length, parsed.rejected.map((r) => `${r.reason}: ${r.line}`).join('\n').slice(0, 2000) || null, ip],
    );
    return { accepted, duplicates, rejected: parsed.rejected.length };
  }

  /**
   * Simulator for devices registered as simulated: builds device-shaped ATTLOG records for the people mapped
   * to the device and runs them through the same parser and storage as a real push. Clearly labelled in the UI.
   */
  async simulate(id: string, input: z.infer<typeof simulateInput>) {
    return this.db.tenant(async (tx) => {
      const d = await one<DeviceRow & { tenant_id: string }>(tx, 'select * from attendance_devices where id = $1 and archived_at is null', [id]);
      if (!d) throw Errors.notFound('Device');
      if (!d.simulated) throw Errors.badRequest('not_simulated', 'Only devices registered as simulated can generate test punches. Real devices send their own.');
      const date = input.date ?? localToday(d.time_zone);
      const pins = (await many<{ device_user_id: string }>(tx, `select device_user_id from device_user_mappings where device_id = $1 or device_id is null order by device_user_id limit 20`, [id])).map((m) => m.device_user_id);
      if (!pins.length && input.scenario !== 'unknown_user') throw Errors.badRequest('no_mappings', 'Map at least one enrolment number to an employee first, or use the "unknown user" scenario.');
      const at = (h: string) => `${date} ${h}:00`;
      const rows: Parameters<typeof attlogLines>[0] = [];
      const nowLocal = toLocal(Date.now(), d.time_zone);
      const notFuture = (h: string) => date < nowLocal.date || hhmm(h) <= nowLocal.minutes;
      if (input.scenario === 'unknown_user') {
        rows.push({ pin: `9${String(Date.now()).slice(-4)}`, local: at(notFuture('09:02') ? '09:02' : fmt(nowLocal.minutes)), status: 0 });
      } else {
        for (const [i, pin] of pins.entries()) {
          const inAt = input.scenario === 'late_and_missing_out' && i === 0 ? '09:47' : `08:${String(50 + (i % 9)).padStart(2, '0')}`;
          if (notFuture(inAt)) rows.push({ pin, local: at(inAt), status: 0 });
          if (input.scenario === 'duplicates' && notFuture(inAt)) rows.push({ pin, local: at(inAt), status: 0 });
          const outAt = `18:${String(5 + (i % 20)).padStart(2, '0')}`;
          if (!(input.scenario === 'late_and_missing_out' && i === 0) && notFuture(outAt)) rows.push({ pin, local: at(outAt), status: 1 });
        }
      }
      if (!rows.length) throw Errors.badRequest('nothing_to_send', 'It is too early in the day at the device location to simulate punches. Pick an earlier date.');
      const body = attlogLines(rows);
      const result = await this.store(tx, d, body, null, 'simulated');
      await this.audit.record(tx, { action: 'device.simulated', resourceType: 'attendance_device', resourceId: id, metadata: { scenario: input.scenario, date, ...result } });
      return { ...result, records: rows.length, date, scenario: input.scenario, sample: body.split('\n').slice(0, 3) };
    });
  }

  /** Alerts device managers once when a real device stops reporting. Called by the hourly job. */
  async alertOffline(tenantId: string) {
    return this.db.tenant(async (tx) => {
      const devices = await many<DeviceRow & { name: string; offline_alerted_at: Date | null }>(
        tx, `select * from attendance_devices where archived_at is null and not simulated and last_seen_at is not null and (offline_alerted_at is null or offline_alerted_at < last_seen_at)`,
      );
      let alerted = 0;
      for (const d of devices) {
        if (deviceStatus(d) !== 'offline') continue;
        const holders = await many<{ membership_id: string }>(
          tx, `select distinct ra.membership_id from role_assignments ra join role_permissions rp on rp.role_id = ra.role_id join memberships m on m.id = ra.membership_id
                where rp.permission = 'devices:manage' and m.status = 'active'`,
        );
        await this.notifications.notify(tx, {
          membershipIds: holders.map((h) => h.membership_id), kind: 'device.offline', title: `Attendance device offline: ${d.name}`,
          body: `Last heard from at ${d.last_seen_at!.toISOString()}. Punches made on it are kept on the device and arrive when it reconnects.`,
          link: `/settings/devices/${d.id}`, email: true,
        });
        await tx.query('update attendance_devices set offline_alerted_at = now() where id = $1', [d.id]);
        alerted++;
      }
      return alerted;
    }, { tenantId });
  }
}

/**
 * Device API punches into the same shape as ATTLOG records. Times without an offset are the machine's local time;
 * with Z or an offset they are exact instants. A punch's identity is the machine's own record id when sent,
 * otherwise the machine, person, time and direction, so a retried upload never counts twice.
 */
export function parseDeviceApi(body: DeviceApiPunches, deviceId: string, timeZone: string, directionFromDevice: boolean): ParseResult {
  const out: ParseResult = { punches: [], rejected: [] };
  const now = Date.now();
  for (const p of body.punches) {
    const raw = JSON.stringify(p).slice(0, 500);
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/.exec(p.time)!;
    const [, date, hh, mm, ss = '00', offset] = m as unknown as string[];
    if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59 || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      out.rejected.push({ line: raw, reason: 'invalid date or time' });
      continue;
    }
    const capturedAt = offset ? Date.parse(`${date}T${hh}:${mm}:${ss}${offset}`) : zonedTime.fromLocal(date!, Number(hh) * 60 + Number(mm), timeZone) + Number(ss) * 1000;
    if (capturedAt > now + 10 * 60_000) {
      out.rejected.push({ line: raw, reason: 'time is in the future' });
      continue;
    }
    const local = toLocal(capturedAt, timeZone);
    const localTime = `${local.date} ${zonedTime.fmtHhmm(local.minutes)}:${String(new Date(capturedAt).getUTCSeconds()).padStart(2, '0')}`;
    const identity = p.id ? `api|${deviceId}|id|${p.id}` : `api|${deviceId}|${p.userId}|${localTime}|${p.direction}`;
    out.punches.push({
      sourceEventId: createHash('sha256').update(identity).digest('hex'),
      deviceUserId: p.userId,
      localTime,
      capturedAt,
      direction: directionFromDevice ? p.direction : 'unknown',
      verifyMethod: p.verify,
      raw,
    });
  }
  return out;
}

function fmt(minutes: number) {
  return zonedTime.fmtHhmm(minutes);
}

