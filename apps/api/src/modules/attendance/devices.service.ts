import { BlockList, isIP } from 'node:net';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import { createHash } from 'node:crypto';
import { DEVICE_INTEGRATIONS, deviceProtocolFor, zonedTime, type DeviceApiPunches, type DeviceInput, type deviceMappingInput, type simulateInput } from '@crew/contracts';
import { randomToken, sha256 } from '../../platform/auth/crypto';
import { AuditService } from '../../platform/audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { employeeNames, fieldById } from '../employees/employee-view';
import { AttendanceDaysService, eventEmployees, isLocked } from './attendance-days.service';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** Devices as the API shows them (the PostgreSQL DEVICE_COLUMNS view), before shape() adds the status. */
async function deviceViews(tx: TenantTx, devices: Doc[]) {
  const locations = await fieldById(tx, 'locations', devices.map((d) => d.location_id));
  const off = new Set(((await tx.collection('tenant_access_controls').findOne({}))?.device_vendors_disabled as string[] | undefined) ?? []);
  return devices
    .filter((d) => locations.has(d.location_id))
    .map((d) => ({
      id: d.id as string,
      name: d.name as string,
      vendor: d.vendor as string,
      model: d.model ?? null,
      serialNumber: d.serial_number as string,
      protocol: d.protocol as string,
      locationId: d.location_id as string,
      locationName: locations.get(d.location_id)!,
      timeZone: d.time_zone as string,
      directionFromDevice: d.direction_from_device as boolean,
      allowedIps: d.allowed_ips as string[],
      simulated: d.simulated as boolean,
      expectedIntervalSeconds: d.expected_interval_seconds as number,
      firmware: d.firmware ?? null,
      reportedUserCount: d.reported_user_count ?? null,
      reportedPunchCount: d.reported_punch_count ?? null,
      lastSeenAt: (d.last_seen_at as Date | null) ?? null,
      lastPunchAt: (d.last_punch_at as Date | null) ?? null,
      lastError: d.last_error ?? null,
      lastErrorAt: (d.last_error_at as Date | null) ?? null,
      recordsAccepted: Number(d.records_accepted ?? 0),
      recordsDuplicate: Number(d.records_duplicate ?? 0),
      recordsRejected: Number(d.records_rejected ?? 0),
      archivedAt: d.archived_at ?? null,
      createdAt: d.created_at,
      last_error_at: (d.last_error_at as Date | null) ?? null,
      last_seen_at: (d.last_seen_at as Date | null) ?? null,
      pausedAt: (d.paused_at as Date | null) ?? null,
      pausedReason: d.paused_reason ?? null,
      tokenHint: (d.api_token_hint as string | null) ?? null,
      integrationOff: off.has(d.vendor),
    }));
}

/** Only the given fields that have a value: the PostgreSQL coalesce($n, column) update. */
const present = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined));

const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
      const c = await tx.collection('tenant_access_controls').findOne({});
      const off = new Set((c?.device_vendors_disabled as string[] | undefined) ?? []);
      return DEVICE_INTEGRATIONS.map((i) => ({ ...i, enabled: !off.has(i.key) }));
    });
  }

  async list() {
    return this.db.tenant(async (tx) => {
      const rows = await deviceViews(tx, await tx.collection('attendance_devices').find({ archived_at: null }, { sort: { name: 1 } }));
      // Enrolment numbers seen on each machine that nobody is mapped to yet.
      const events = await tx.collection('attendance_events').find({ device_id: { $in: rows.map((d) => d.id) }, employee_id: null }, { projection: { device_id: 1, device_user_id: 1, employee_id: 1 } });
      const owner = await eventEmployees(tx, events);
      const unmapped = new Map<string, Set<string>>();
      for (const ev of events) {
        if (owner.has(ev.id) || !ev.device_user_id) continue;
        unmapped.set(ev.device_id, (unmapped.get(ev.device_id) ?? new Set()).add(ev.device_user_id));
      }
      return rows.map((r) => this.shape({ ...r, unmappedUsers: unmapped.get(r.id)?.size ?? 0 }));
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const found = await tx.collection('attendance_devices').findOne({ id });
      const row = found && (await deviceViews(tx, [found]))[0];
      if (!row) throw Errors.notFound('Device');
      const events = await tx.collection('attendance_events').find({ device_id: id }, { projection: { device_user_id: 1, device_id: 1, employee_id: 1, captured_at: 1 } });
      const owner = await eventEmployees(tx, events);
      const groups = new Map<string, { deviceUserId: string; punches: number; lastPunchAt: Date; employeeId: string | null }>();
      for (const ev of events) {
        const employeeId = owner.get(ev.id) ?? null;
        const key = `${ev.device_user_id}|${employeeId}`;
        const g = groups.get(key) ?? { deviceUserId: ev.device_user_id, punches: 0, lastPunchAt: ev.captured_at, employeeId };
        g.punches++;
        if (ev.captured_at > g.lastPunchAt) g.lastPunchAt = ev.captured_at;
        groups.set(key, g);
      }
      const names = await employeeNames(tx, [...groups.values()].map((g) => g.employeeId));
      const seenUsers = [...groups.values()]
        .sort((a, b) => (a.deviceUserId < b.deviceUserId ? -1 : a.deviceUserId > b.deviceUserId ? 1 : 0))
        .map((g) => ({ ...g, employeeName: g.employeeId ? (names.get(g.employeeId)?.name ?? null) : null }));
      const log = (await tx.collection('device_ingest_log').find({ device_id: id }, { sort: { created_at: -1 }, limit: 50 })).map((l) => ({
        id: l.id,
        kind: l.kind,
        records: l.records ?? null,
        accepted: l.accepted ?? null,
        duplicates: l.duplicates ?? null,
        rejected: l.rejected ?? null,
        detail: l.detail ?? null,
        remoteIp: l.remote_ip ?? null,
        createdAt: l.created_at,
      }));
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
      const off = ((await tx.collection('tenant_access_controls').findOne({}))?.device_vendors_disabled as string[] | undefined) ?? [];
      if (off.includes(input.vendor)) throw Errors.forbidden(`The ${integration.name} integration is switched off for this workspace by SAMPLEDGE.`);
      const loc = await tx.collection('locations').findOne({ id: input.locationId, archived_at: null });
      if (!loc) throw Errors.badRequest('invalid_location', 'Location not found');
      const token = protocol === 'device_api' && !input.simulated ? `${DEVICE_TOKEN_PREFIX}${randomToken(32)}` : protocol === 'device_api' ? `${DEVICE_TOKEN_PREFIX}sim_${randomToken(16)}` : null;
      const row = (await tx.collection('attendance_devices').insert({
        name: input.name,
        vendor: input.vendor,
        model: input.model ?? null,
        serial_number: input.serialNumber,
        location_id: input.locationId,
        time_zone: input.timeZone ?? loc.timezone,
        direction_from_device: input.directionFromDevice,
        allowed_ips: input.allowedIps,
        simulated: input.simulated,
        expected_interval_seconds: input.expectedIntervalSeconds,
        protocol,
        api_token_hash: token ? sha256(token) : null,
        api_token_hint: token ? token.slice(-4) : null,
      }).catch((err: { code?: string }) => {
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
      const d = await tx.collection('attendance_devices').findOne({ id, archived_at: null });
      if (!d) throw Errors.notFound('Device');
      if (d.protocol !== 'device_api') throw Errors.badRequest('no_token', 'This machine uses the ZKTeco push protocol, which identifies it by serial number. It has no token.');
      const token = `${DEVICE_TOKEN_PREFIX}${randomToken(32)}`;
      await tx.collection('attendance_devices').updateOne({ id }, { $set: { api_token_hash: sha256(token), api_token_hint: token.slice(-4) } });
      await this.audit.record(tx, { action: 'device.token_rotated', resourceType: 'attendance_device', resourceId: id });
      return { id, token };
    });
  }

  async update(id: string, input: Partial<DeviceInput>) {
    return this.db.tenant(async (tx) => {
      const cols: Record<string, string> = { name: 'name', model: 'model', locationId: 'location_id', timeZone: 'time_zone', directionFromDevice: 'direction_from_device', allowedIps: 'allowed_ips', expectedIntervalSeconds: 'expected_interval_seconds' };
      const entries = Object.entries(input).filter(([k, v]) => cols[k] && v !== undefined);
      if (!entries.length) throw Errors.badRequest('nothing_to_change', 'Send at least one field to change');
      if (input.locationId && !(await tx.collection('locations').exists({ id: input.locationId }))) throw Errors.badRequest('invalid_location', 'Location not found');
      const n = await tx.collection('attendance_devices').updateOne({ id, archived_at: null }, { $set: Object.fromEntries(entries.map(([k, v]) => [cols[k]!, v])) });
      if (!n) throw Errors.notFound('Device');
      await this.audit.record(tx, { action: 'device.updated', resourceType: 'attendance_device', resourceId: id, changes: Object.fromEntries(entries) });
      return { id };
    });
  }

  async archive(id: string) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('attendance_devices').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date() } }))) throw Errors.notFound('Device');
      await this.audit.record(tx, { action: 'device.archived', resourceType: 'attendance_device', resourceId: id });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Mappings
  // ---------------------------------------------------------------------------------------------------------

  listMappings() {
    return this.db.tenant(async (tx) => {
      const mappings = await tx.collection('device_user_mappings').find({}, { sort: { device_user_id: 1 } });
      const people = await employeeNames(tx, mappings.map((m) => m.employee_id));
      const devices = await fieldById(tx, 'attendance_devices', mappings.map((m) => m.device_id));
      return mappings
        .filter((m) => people.has(m.employee_id))
        .map((m) => ({
          id: m.id,
          deviceId: m.device_id ?? null,
          deviceName: devices.get(m.device_id) ?? null,
          deviceUserId: m.device_user_id,
          employeeId: m.employee_id,
          employeeName: people.get(m.employee_id)!.name,
          employeeCode: people.get(m.employee_id)!.doc.employee_code,
          createdAt: m.created_at,
        }));
    });
  }

  async map(input: z.infer<typeof deviceMappingInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('employees').exists({ id: input.employeeId }))) throw Errors.badRequest('invalid_employee', 'Employee not found');
      if (input.deviceId && !(await tx.collection('attendance_devices').exists({ id: input.deviceId }))) throw Errors.badRequest('invalid_device', 'Device not found');
      const row = (await tx.collection('device_user_mappings').insert({ device_id: input.deviceId ?? null, device_user_id: input.deviceUserId, employee_id: input.employeeId, created_by: actor.userId }).catch((err: { code?: string }) => {
        if (err.code === '23505') throw Errors.conflict('already_mapped', `Enrolment number ${input.deviceUserId} is already mapped${input.deviceId ? ' on this device' : ''}.`);
        throw err;
      }))!;
      await this.audit.record(tx, { action: 'device_mapping.created', resourceType: 'employee', resourceId: input.employeeId, changes: input });
      // Punches already received from this enrolment number now count for the employee.
      await this.recomputeMapped(tx, input.employeeId, input.deviceUserId, input.deviceId ?? null);
      return { id: row.id };
    });
  }

  async recomputeMapped(tx: TenantTx, employeeId: string, deviceUserId: string, deviceId: string | null) {
    const recent = { device_user_id: deviceUserId, ...(deviceId ? { device_id: deviceId } : {}), captured_at: { $gt: new Date(Date.now() - 62 * 86_400_000) } };
    const firstEv = await tx.collection('attendance_events').findOne(recent, { sort: { captured_at: 1 }, projection: { captured_at: 1 } });
    const lastEv = await tx.collection('attendance_events').findOne(recent, { sort: { captured_at: -1 }, projection: { captured_at: 1 } });
    const span = { first: (firstEv?.captured_at as Date | undefined) ?? null, last: (lastEv?.captured_at as Date | undefined) ?? null };
    if (!span.first || !span.last) return;
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
      const m = await tx.collection('device_user_mappings').findOne({ id });
      if (!m || !(await tx.collection('device_user_mappings').deleteOne({ id }))) throw Errors.notFound('Mapping');
      await this.audit.record(tx, { action: 'device_mapping.removed', resourceType: 'employee', resourceId: m.employee_id, metadata: { deviceUserId: m.device_user_id } });
      await this.recomputeMapped(tx, m.employee_id, m.device_user_id, m.device_id);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Push protocol ingest (no user session: the device is identified by its registered serial number)
  // ---------------------------------------------------------------------------------------------------------

  private async findDevice(by: { serial: string } | { tokenHash: string }): Promise<DeviceRow | undefined> {
    const bySerial = 'serial' in by;
    return this.db.platform(async (tx) => {
      const d = await tx.collection('attendance_devices').findOne(
        bySerial ? { serial_number: { $regex: `^${escapeRegex(by.serial)}$`, $options: 'i' }, protocol: 'push_http', archived_at: null } : { api_token_hash: by.tokenHash, archived_at: null },
      );
      if (!d || !(await tx.collection('tenants').exists({ id: d.tenant_id, status: 'active' }))) return undefined;
      const c = await tx.collection('tenant_access_controls').findOne({ tenant_id: d.tenant_id });
      return { ...(d as DeviceRow), allowed_ips: (d.allowed_ips as string[]) ?? [], vendor_off: ((c?.device_vendors_disabled as string[] | undefined) ?? []).includes(d.vendor) };
    });
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
        await tx.collection('device_ingest_log').insert({ device_id: d.id, kind: 'rejected', detail, remote_ip: ip });
        await tx.collection('attendance_devices').updateOne({ id: d.id }, { $set: { last_error: error, last_error_at: new Date() } });
      }, { tenantId: d.tenant_id });
    };
    if (!ipAllowed(d.allowed_ips, ip)) {
      await refuse('address not on the allowed list', 'Connection from an address not on the allowed list');
      throw Errors.forbidden('Address not allowed for this device');
    }
    // Biometric and machine integrations are a plan module (attendance_advanced).
    if (!(await this.db.tenant((tx) => loadEntitlements(tx), { tenantId: d.tenant_id })).features.has('attendance_advanced')) {
      await refuse('attendance devices are not in the workspace plan', 'Refused: attendance devices are not included in the workspace plan');
      throw Errors.featureNotInPlan('Geofencing, kiosks, biometric devices');
    }
    if (d.paused_at || d.vendor_off) {
      const why = d.paused_at ? 'machine paused by SAMPLEDGE' : 'machine integration switched off by SAMPLEDGE';
      await refuse(why, `Refused: ${why}`);
      throw Errors.forbidden(`This machine is not accepted: ${why}.`);
    }
    return d;
  }

  // ---------------------------------------------------------------------------------------------------------
  // SampCrew device API (any machine, bridge or middleware; identified by its machine token)
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
      await tx.collection('attendance_devices').updateOne(
        { id: d.id },
        { $set: { last_seen_at: new Date(), ...present({ firmware: body.firmware, reported_user_count: body.users, reported_punch_count: body.records }) } },
      );
      await tx.collection('device_ingest_log').insert({ device_id: d.id, kind: 'heartbeat', remote_ip: ip });
    }, { tenantId: d.tenant_id });
    return { ok: true, device: d.name, serverTime: new Date().toISOString() };
  }

  async apiPunches(authorization: string | undefined, body: DeviceApiPunches, ip: string | null) {
    const d = await this.byToken(authorization, ip);
    const parsed = parseDeviceApi(body, d.id, d.time_zone, d.direction_from_device);
    const r = await this.db.tenant(async (tx) => {
      if (body.device) {
        const values = present({ firmware: body.device.firmware, reported_user_count: body.device.users, reported_punch_count: body.device.records });
        if (Object.keys(values).length) await tx.collection('attendance_devices').updateOne({ id: d.id }, { $set: values });
      }
      return this.storeParsed(tx, d, parsed, ip, 'device_api');
    }, { tenantId: d.tenant_id });
    return { ...r, received: body.punches.length };
  }

  async handshake(serial: string | undefined, query: Record<string, string>, ip: string | null) {
    const d = await this.authorise(serial, ip);
    await this.db.tenant(async (tx) => {
      await tx.collection('attendance_devices').updateOne({ id: d.id }, { $set: { last_seen_at: new Date(), ...present({ firmware: query.pushver ? `push ${query.pushver}`.slice(0, 80) : null }) } });
      await tx.collection('device_ingest_log').insert({ device_id: d.id, kind: 'handshake', detail: query.pushver ? `push version ${query.pushver}` : null, remote_ip: ip });
    }, { tenantId: d.tenant_id });
    return handshakeResponse(d.serial_number);
  }

  async heartbeat(serial: string | undefined, query: Record<string, string>, ip: string | null) {
    const d = await this.authorise(serial, ip);
    const info = parseInfo(query.INFO);
    await this.db.tenant(
      (tx) =>
        tx.collection('attendance_devices').updateOne(
          { id: d.id },
          { $set: { last_seen_at: new Date(), ...present({ firmware: info.firmware, reported_user_count: info.users, reported_punch_count: info.records }) } },
        ),
      { tenantId: d.tenant_id },
    );
    // No commands are sent to devices in this version.
    return 'OK';
  }

  async commandResult(serial: string | undefined, ip: string | null) {
    const d = await this.authorise(serial, ip);
    await this.db.tenant((tx) => tx.collection('device_ingest_log').insert({ device_id: d.id, kind: 'command_result', remote_ip: ip }), { tenantId: d.tenant_id });
    return 'OK';
  }

  async upload(serial: string | undefined, query: Record<string, string>, body: string, ip: string | null) {
    const d = await this.authorise(serial, ip);
    const table = (query.table ?? '').toUpperCase();
    if (table !== 'ATTLOG') {
      // Operation logs, photos and user records are acknowledged so the device does not resend them, and not stored.
      const lines = body.split(/\r?\n/).filter(Boolean).length;
      await this.db.tenant(async (tx) => {
        await tx.collection('attendance_devices').updateOne({ id: d.id }, { $set: { last_seen_at: new Date() } });
        await tx.collection('device_ingest_log').insert({ device_id: d.id, kind: 'operlog', records: lines, detail: `table ${table || 'unknown'} acknowledged, not stored`, remote_ip: ip });
      }, { tenantId: d.tenant_id });
      return `OK: ${lines}`;
    }
    const r = await this.db.tenant((tx) => this.store(tx, d, body, ip, 'attlog'), { tenantId: d.tenant_id });
    return `OK: ${r.accepted + r.duplicates}`;
  }

  /** Parses and stores an ATTLOG body, then recomputes the days it touches. Shared by the push endpoint and the simulator. */
  private async store(tx: TenantTx, d: Pick<DeviceRow, 'id' | 'tenant_id' | 'serial_number' | 'time_zone' | 'direction_from_device'>, body: string, ip: string | null, kind: 'attlog' | 'simulated') {
    return this.storeParsed(tx, d, parseAttlog(body, d.serial_number, d.time_zone, d.direction_from_device), ip, kind);
  }

  private async storeParsed(tx: TenantTx, d: Pick<DeviceRow, 'id' | 'tenant_id'>, parsed: ParseResult, ip: string | null, kind: 'attlog' | 'simulated' | 'device_api') {
    let accepted = 0;
    let duplicates = 0;
    const touched = new Map<string, number[]>();
    const events = tx.collection('attendance_events');
    for (const p of parsed.punches) {
      // A mapping for this machine wins over one for every machine.
      const candidates = await tx.collection('device_user_mappings').find({ device_user_id: p.deviceUserId, device_id: { $in: [d.id, null] } });
      const mapped = candidates.find((m) => m.device_id === d.id) ?? candidates.find((m) => !m.device_id);
      let locked = false;
      if (mapped) {
        const e = await this.days.employee(tx, mapped.employee_id);
        if (e) locked = await isLocked(tx, e.id, toLocal(p.capturedAt, e.tz).date);
      }
      // A record already received (the machine resends after a lost reply) counts as a duplicate.
      const duplicate = await events.exists({ source: 'device', source_event_id: p.sourceEventId });
      if (!duplicate) {
        await events.insert({
          device_id: d.id,
          device_user_id: p.deviceUserId,
          source: 'device',
          source_event_id: p.sourceEventId,
          captured_at: new Date(p.capturedAt),
          device_local_time: p.localTime,
          direction: p.direction,
          verify_method: p.verifyMethod ?? null,
          geofence_result: 'not_required',
          raw: { line: p.raw },
          payload_sha256: p.sourceEventId,
          remote_ip: ip,
          arrived_after_lock: locked,
        });
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
    const rejected = parsed.rejected.length;
    await tx.collection('attendance_devices').updateOne(
      { id: d.id },
      {
        $inc: { records_accepted: accepted, records_duplicate: duplicates, records_rejected: rejected },
        ...(last ? { $max: { last_punch_at: new Date(last) } } : {}),
        $set: {
          ...(kind === 'simulated' ? {} : { last_seen_at: new Date() }),
          ...(rejected > 0 ? { last_error: `${rejected} record(s) could not be read: ${parsed.rejected[0]!.reason}`, last_error_at: new Date() } : {}),
        },
      },
    );
    await tx.collection('device_ingest_log').insert({
      device_id: d.id,
      kind,
      records: parsed.punches.length + rejected,
      accepted,
      duplicates,
      rejected,
      detail: parsed.rejected.map((x) => `${x.reason}: ${x.line}`).join('\n').slice(0, 2000) || null,
      remote_ip: ip,
    });
    return { accepted, duplicates, rejected: parsed.rejected.length };
  }

  /**
   * Simulator for devices registered as simulated: builds device-shaped ATTLOG records for the people mapped
   * to the device and runs them through the same parser and storage as a real push. Clearly labelled in the UI.
   */
  async simulate(id: string, input: z.infer<typeof simulateInput>) {
    return this.db.tenant(async (tx) => {
      const d = await tx.collection<DeviceRow & { tenant_id: string }>('attendance_devices').findOne({ id, archived_at: null });
      if (!d) throw Errors.notFound('Device');
      if (!d.simulated) throw Errors.badRequest('not_simulated', 'Only devices registered as simulated can generate test punches. Real devices send their own.');
      const date = input.date ?? localToday(d.time_zone);
      const pins = (await tx.collection('device_user_mappings').find({ device_id: { $in: [id, null] } }, { sort: { device_user_id: 1 }, limit: 20 })).map((m) => m.device_user_id as string);
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
      const devices = (await tx.collection<DeviceRow & { name: string; offline_alerted_at: Date | null }>('attendance_devices').find({ archived_at: null, simulated: false, last_seen_at: { $ne: null } })).filter(
        (d) => !d.offline_alerted_at || d.offline_alerted_at < d.last_seen_at!,
      );
      let alerted = 0;
      for (const d of devices) {
        if (deviceStatus(d) !== 'offline') continue;
        const roles = await tx.collection('role_permissions').distinct<string>('role_id', { permission: 'devices:manage' });
        const assigned = await tx.collection('role_assignments').distinct<string>('membership_id', { role_id: { $in: roles } });
        const holders = (await tx.collection('memberships').find({ id: { $in: assigned }, status: 'active' }, { projection: { _id: 1 } })).map((m) => ({ membership_id: m.id as string }));
        await this.notifications.notify(tx, {
          membershipIds: holders.map((h) => h.membership_id), kind: 'device.offline', title: `Attendance device offline: ${d.name}`,
          body: `Last heard from at ${d.last_seen_at!.toISOString()}. Punches made on it are kept on the device and arrive when it reconnects.`,
          link: `/settings/devices/${d.id}`, email: true,
        });
        await tx.collection('attendance_devices').updateOne({ id: d.id }, { $set: { offline_alerted_at: new Date() } });
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

