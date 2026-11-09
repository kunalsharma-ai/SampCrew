import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import {
  attendanceEngine,
  zonedTime,
  type AttendancePolicyInput,
  type CorrectionInput,
  type kioskInput,
  type overtimeClaimInput,
  type periodLockInput,
  type PunchInput,
  type PunchSyncInput,
  mobileSync,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx, usersTable } from '../../platform/database/mongo.service';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService, type ApprovalRequestRow } from '../approvals/approvals.service';
import { EMPLOYEE_FIELDS, employeeAttrs } from '../employees/employee-attrs';
import { employeeNames, fieldById } from '../employees/employee-view';
import { AttendanceDaysService, type EmployeeCtx, isLocked } from './attendance-days.service';

const { addDays, fromLocal, hhmm, localToday } = zonedTime;
const QR_WINDOW_MS = 30_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** Computed days as the API shows them, with their shift (the PostgreSQL DAY_COLUMNS view). */
async function dayViews(tx: TenantTx, days: Doc[]) {
  const shifts = new Map((await tx.collection('shift_templates').find({ id: { $in: [...new Set(days.map((d) => d.shift_template_id).filter(Boolean))] } })).map((x) => [x.id as string, x]));
  return days.map((d) => {
    const st = d.shift_template_id ? shifts.get(d.shift_template_id) : undefined;
    return {
      employeeId: d.employee_id as string,
      workDate: d.work_date as string,
      status: d.status as string,
      dayType: d.day_type,
      leavePart: d.leave_part ?? null,
      firstIn: (d.first_in as Date | null) ?? null,
      lastOut: (d.last_out as Date | null) ?? null,
      workedMinutes: d.worked_minutes as number,
      breakMinutes: d.break_minutes as number,
      lateMinutes: d.late_minutes as number,
      earlyLeaveMinutes: d.early_leave_minutes as number,
      overtimeMinutes: d.overtime_minutes as number,
      approvedOvertimeMinutes: d.approved_overtime_minutes as number,
      flags: d.flags,
      explanation: d.explanation,
      punchCount: d.punch_count,
      computedAt: d.computed_at,
      shiftCode: st?.code ?? null,
      shiftName: st?.name ?? null,
      shiftStart: st ? String(st.start_time).slice(0, 5) : null,
      shiftEnd: st ? String(st.end_time).slice(0, 5) : null,
      shiftColor: st?.color ?? null,
    };
  });
}

/** Attendance corrections as the API shows them, with the employee's name. */
async function correctionViews(tx: TenantTx, rows: Doc[]) {
  const people = await employeeNames(tx, rows.map((c) => c.employee_id));
  return rows
    .filter((c) => people.has(c.employee_id))
    .map((c) => ({
      id: c.id,
      employeeId: c.employee_id,
      workDate: c.work_date,
      punches: c.punches,
      reason: c.reason,
      status: c.status,
      createdAt: c.created_at,
      approvalId: c.approval_request_id ?? null,
      employeeName: people.get(c.employee_id)!.name,
    }));
}

const attrsOf = (e: EmployeeCtx) =>
  employeeAttrs({ id: e.id, membershipId: e.membership_id, legalEntityId: e.legal_entity_id, departmentId: e.department_id, locationId: e.location_id });

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Punching, attendance views, corrections, overtime claims, policies, period locks and QR kiosks.
 * Raw punches are append-only; everything shown as a "day" is computed by the attendance engine.
 */
/** How long a computed day for today or yesterday is reused by read views before it is refreshed. */
const TEAM_REFRESH_SECONDS = 30;

/**
 * True when a stored day can be reused by a read view: computed in the last TEAM_REFRESH_SECONDS, and no leave
 * request covering the date changed after it was computed.
 */
async function freshDays(tx: TenantTx, date: string, days: Doc[]): Promise<Set<string>> {
  const since = Date.now() - TEAM_REFRESH_SECONDS * 1000;
  const recent = days.filter((d) => d.computed_at && d.computed_at.getTime() > since);
  if (!recent.length) return new Set();
  const changed = await tx.collection('leave_requests').find(
    { employee_id: { $in: recent.map((d) => d.employee_id) }, start_date: { $lte: date }, end_date: { $gte: date } },
    { projection: { employee_id: 1, updated_at: 1 } },
  );
  return new Set(recent.filter((d) => !changed.some((l) => l.employee_id === d.employee_id && l.updated_at > d.computed_at)).map((d) => d.employee_id as string));
}

@Injectable()
export class AttendanceService implements OnModuleInit {
  private readonly qrKey: Buffer;

  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly approvals: ApprovalsService,
    private readonly days: AttendanceDaysService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.qrKey = Buffer.from(hkdfSync('sha256', config.JWT_ACCESS_SECRET, 'crew', 'crew:kiosk-qr:v1', 32));
  }

  onModuleInit() {
    const common = {
      permission: 'attendance:approve',
      configurePermission: 'attendance:configure',
      defaultSteps: [{ type: 'manager' as const }],
      fallbackRole: 'hr_admin',
    };
    this.approvals.register('attendance_correction', {
      ...common,
      label: 'Attendance correction',
      link: () => '/attendance',
      attributes: async (tx, id) => attrsOf((await this.employeeFor(tx, 'attendance_corrections', id))!),
      onApproved: (tx, req) => this.correctionApproved(tx, req),
      onRejected: async (tx, req) => {
        await tx.collection('attendance_corrections').updateOne({ id: req.resource_id, status: 'pending' }, { $set: { status: 'rejected', decided_at: new Date() } });
        await this.audit.record(tx, { action: 'attendance_correction.rejected', resourceType: 'attendance_correction', resourceId: req.resource_id });
      },
    });
    this.approvals.register('overtime_claim', {
      ...common,
      label: 'Overtime claim',
      link: () => '/attendance',
      attributes: async (tx, id) => attrsOf((await this.employeeFor(tx, 'overtime_claims', id))!),
      onApproved: async (tx, req) => {
        const c = await tx.collection('overtime_claims').updateAndGet({ id: req.resource_id, status: 'pending' }, { $set: { status: 'approved', decided_at: new Date() } });
        if (!c) return;
        await this.days.recompute(tx, c.employee_id, c.work_date, c.work_date);
        await this.audit.record(tx, { action: 'overtime_claim.approved', resourceType: 'overtime_claim', resourceId: req.resource_id, metadata: { minutes: c.minutes, workDate: c.work_date } });
      },
      onRejected: async (tx, req) => {
        await tx.collection('overtime_claims').updateOne({ id: req.resource_id, status: 'pending' }, { $set: { status: 'rejected', decided_at: new Date() } });
        await this.audit.record(tx, { action: 'overtime_claim.rejected', resourceType: 'overtime_claim', resourceId: req.resource_id });
      },
    });
  }

  private async employeeFor(tx: TenantTx, table: 'attendance_corrections' | 'overtime_claims', id: string) {
    const r = await tx.collection(table).findOne({ id });
    return r ? this.days.employee(tx, r.employee_id) : undefined;
  }

  private async me(tx: TenantTx): Promise<EmployeeCtx> {
    const s = await this.authz.subject(tx);
    if (!s.employeeId) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet. Ask HR to link it.');
    return (await this.days.employee(tx, s.employeeId))!;
  }

  /** The employee a request is about: the caller, or someone they may act for with the given permission. */
  private async target(tx: TenantTx, employeeId: string | undefined, permission: string): Promise<{ e: EmployeeCtx; onBehalf: boolean }> {
    if (!employeeId) {
      const e = await this.me(tx);
      await this.authz.require(permission, attrsOf(e), tx);
      return { e, onBehalf: false };
    }
    const e = await this.days.employee(tx, employeeId);
    if (!e) throw Errors.notFound('Employee');
    const s = await this.authz.subject(tx);
    if (s.employeeId === e.id) return this.target(tx, undefined, permission);
    await this.authz.require('attendance:read', attrsOf(e), tx); // 404 when out of scope
    await this.authz.require(permission, attrsOf(e), tx);
    return { e, onBehalf: true };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Punching
  // ---------------------------------------------------------------------------------------------------------

  async punch(input: PunchInput) {
    const actor = requestContext.tenantActor();
    const ctx = requestContext.get();
    let refused: { employeeId: string; distanceM: number } | null = null;
    return this.db.tenant(async (tx) => {
      const e = await this.me(tx);
      await this.authz.require('attendance:punch', attrsOf(e), tx);
      this.requireEmployed(e, localToday(e.tz));
      const policy = await this.days.policy(tx, e.location_id);
      if (input.source === 'web' && !policy.web_punch) throw Errors.forbidden('Punching from the web is turned off for your location. Use the mobile app or a kiosk.');
      if (input.source === 'mobile' && !policy.mobile_punch) throw Errors.forbidden('Punching from the mobile app is turned off for your location.');

      // Geofence.
      let geofence: 'inside' | 'outside' | 'unknown' | 'not_configured' | 'not_required' = 'not_required';
      let distance: number | null = null;
      if (policy.geofence_mode !== 'off') {
        if (!e.fence) geofence = 'not_configured';
        else if (input.latitude === undefined || input.longitude === undefined) {
          if (policy.geofence_mode === 'enforce') throw Errors.badRequest('location_required', 'Allow location access to punch: your workplace checks that you are on site.');
          geofence = 'unknown';
        } else {
          const g = attendanceEngine.geofenceCheck(e.fence, { lat: input.latitude, lon: input.longitude, accuracyM: input.accuracyM });
          geofence = g.result;
          distance = g.distance;
          if (g.result === 'outside' && policy.geofence_mode === 'enforce') {
            refused = { employeeId: e.id, distanceM: g.distance };
            throw Errors.forbidden(`You are about ${distance} m from your workplace, outside its ${e.fence.radiusM} m area. Move closer and try again.`);
          }
        }
      }
      return this.record(tx, e, {
        source: input.source,
        sourceEventId: `${actor.membershipId}:${input.clientEventId}`,
        direction: input.direction,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        accuracy: input.accuracyM ?? null,
        geofence,
        distance,
        note: input.note ?? null,
        ip: ctx?.ip ?? null,
      });
    }).catch(async (err: unknown) => {
      // The refusal is audited in its own transaction, since the punch transaction rolls back.
      const r = refused as { employeeId: string; distanceM: number } | null;
      if (r) await this.db.tenant((tx) => this.audit.record(tx, { action: 'attendance.punch_refused', resourceType: 'employee', resourceId: r.employeeId, metadata: { reason: 'outside_geofence', distanceM: r.distanceM } }));
      throw err;
    });
  }

  /**
   * Punches queued by the mobile app, sent in one batch when the phone is online. Each punch is idempotent on
   * device id and sequence. The punch time is worked out from the server clock and the app's monotonic clock
   * where possible (see packages/contracts/src/mobile-sync.ts); offline punches, changed phone clocks and mock
   * locations are stored with risk flags for review, never silently corrected or dropped. Punches older than
   * 72 hours, from the future, or outside an enforced geofence are refused with a reason, so the person can
   * ask for a correction instead.
   */
  async syncMobile(input: PunchSyncInput) {
    const actor = requestContext.tenantActor();
    const ctx = requestContext.get();
    const now = Date.now();
    const refusals: { employeeId: string; distanceM: number; sequence: number }[] = [];
    const out = await this.db.tenant(async (tx) => {
      const device = await tx.collection('mobile_devices').findOne({ id: input.deviceId, membership_id: actor.membershipId, revoked_at: null });
      if (!device) throw Errors.notFound('Device');
      const e = await this.me(tx);
      await this.authz.require('attendance:punch', attrsOf(e), tx);
      const policy = await this.days.policy(tx, e.location_id);
      const results: Record<string, unknown>[] = [];
      const touched: number[] = [];
      for (const p of [...input.punches].sort((a, b) => a.sequence - b.sequence)) {
        const sourceEventId = mobileSync.punchEventId(device.id, p.sequence);
        const existing = await tx.collection('attendance_events').findOne({ source: 'mobile', source_event_id: sourceEventId });
        if (existing) {
          results.push({ sequence: p.sequence, status: 'duplicate', punch: { id: existing.id, capturedAt: existing.captured_at, direction: existing.direction, flags: existing.risk_flags } });
          continue;
        }
        const refuse = (reason: string, message: string) => results.push({ sequence: p.sequence, status: 'rejected', reason, message });
        if (!policy.mobile_punch) {
          refuse('mobile_off', 'Punching from the mobile app is turned off for your location.');
          continue;
        }
        const capture = mobileSync.resolveCaptureTime({
          capturedWallMs: Date.parse(p.capturedAt), capturedElapsedMs: p.capturedElapsedMs, capturedRunId: p.capturedRunId,
          sentElapsedMs: input.sentElapsedMs, sentRunId: input.sentRunId, serverNowMs: now,
        });
        const at = Math.min(capture.capturedAtMs, now);
        const age = mobileSync.checkAge(capture.capturedAtMs, now);
        if (!age.ok) {
          refuse(age.reason, age.reason === 'too_old'
            ? `This punch is more than ${mobileSync.OFFLINE_MAX_AGE_HOURS} hours old. Ask for an attendance correction instead.`
            : 'This punch is dated in the future. Check the date and time on your phone.');
          continue;
        }
        const localDate = zonedTime.toLocal(at, e.tz).date;
        if (localDate < e.date_of_joining) {
          refuse('not_started', `Your employment starts on ${e.date_of_joining}.`);
          continue;
        }
        if (e.status === 'exited' || (e.last_working_day && localDate > e.last_working_day)) {
          refuse('employment_ended', 'Your employment had ended at the time of this punch.');
          continue;
        }
        let geofence: 'inside' | 'outside' | 'unknown' | 'not_configured' | 'not_required' = 'not_required';
        let distance: number | null = null;
        if (policy.geofence_mode !== 'off') {
          if (!e.fence) geofence = 'not_configured';
          else if (p.latitude === undefined || p.longitude === undefined) {
            if (policy.geofence_mode === 'enforce') {
              refuse('location_required', 'Allow location access to punch: your workplace checks that you are on site.');
              continue;
            }
            geofence = 'unknown';
          } else {
            const g = attendanceEngine.geofenceCheck(e.fence, { lat: p.latitude, lon: p.longitude, accuracyM: p.accuracyM });
            geofence = g.result;
            distance = g.distance;
            if (g.result === 'outside' && policy.geofence_mode === 'enforce') {
              refusals.push({ employeeId: e.id, distanceM: g.distance, sequence: p.sequence });
              refuse('outside_geofence', `You were about ${g.distance} m from your workplace, outside its ${e.fence.radiusM} m area.`);
              continue;
            }
          }
        }
        const flags = [
          ...(p.offline ? ['offline'] : []),
          ...(capture.flag ? [capture.flag] : []),
          ...(p.mockLocation ? ['mock_location'] : []),
        ];
        const workDate = await this.days.workDateAt(tx, e, at);
        const locked = await isLocked(tx, e.id, workDate);
        let direction = p.direction;
        if (!direction) {
          const win = await this.days.window(tx, e, workDate);
          const last = (await this.days.punches(tx, e.id, win.from, at)).at(-1);
          direction = last && last.direction !== 'out' ? 'out' : 'in';
        }
        const row = await tx.collection('attendance_events').insert({
          employee_id: e.id,
          source: 'mobile',
          source_event_id: sourceEventId,
          captured_at: new Date(at),
          device_local_time: p.capturedAt,
          direction,
          latitude: p.latitude ?? null,
          longitude: p.longitude ?? null,
          accuracy_m: p.accuracyM ?? null,
          geofence_result: geofence,
          distance_m: distance,
          recorded_by_membership_id: actor.membershipId,
          note: p.note ?? null,
          remote_ip: ctx?.ip ?? null,
          raw: { timeBasis: capture.basis, phoneTime: p.capturedAt, capturedElapsedMs: p.capturedElapsedMs ?? null, sentElapsedMs: input.sentElapsedMs ?? null, sameRun: p.capturedRunId !== undefined && p.capturedRunId === input.sentRunId },
          mobile_device_id: device.id,
          risk_flags: flags,
          arrived_after_lock: locked,
        });
        if (!row) {
          results.push({ sequence: p.sequence, status: 'duplicate' });
          continue;
        }
        if (!locked) touched.push(at);
        results.push({
          sequence: p.sequence,
          status: 'accepted',
          punch: { id: row.id, capturedAt: new Date(at), direction, geofence, distanceM: distance, flags, arrivedAfterLock: locked },
          ...(locked ? { message: 'Attendance for that day is locked for payroll. The punch is kept, and HR can apply it after unlocking.' } : {}),
        });
      }
      if (touched.length) {
        const dates = touched.flatMap((t) => this.days.datesFor(e, t)).sort();
        const today = localToday(e.tz);
        const from = dates[0]! < e.date_of_joining ? e.date_of_joining : dates[0]!;
        const to = dates[dates.length - 1]! > today ? today : dates[dates.length - 1]!;
        if (from <= to) await this.days.recompute(tx, e.id, from, to, now);
      }
      await tx.collection('mobile_devices').updateOne({ id: device.id }, { $set: { last_sync_at: new Date(), last_seen_at: new Date() } });
      const date = await this.days.workDateAt(tx, e, now);
      return { results, today: await this.dayRow(tx, e.id, date) };
    });
    if (refusals.length) {
      await this.db.tenant(async (tx) => {
        for (const r of refusals) await this.audit.record(tx, { action: 'attendance.punch_refused', resourceType: 'employee', resourceId: r.employeeId, metadata: { reason: 'outside_geofence', distanceM: r.distanceM, source: 'mobile', sequence: r.sequence } });
      });
    }
    return out;
  }

  private requireEmployed(e: EmployeeCtx, date: string) {
    if (date < e.date_of_joining) throw Errors.badRequest('not_started', `Your employment starts on ${e.date_of_joining}.`);
    if (e.status === 'exited' || (e.last_working_day && date > e.last_working_day)) throw Errors.forbidden('Your employment has ended.');
  }

  /** Writes one live punch (web, mobile, QR), then recomputes the affected days. Retries return the first punch. */
  private async record(
    tx: TenantTx,
    e: EmployeeCtx,
    p: { source: 'web' | 'mobile' | 'qr'; sourceEventId: string; direction?: 'in' | 'out'; latitude: number | null; longitude: number | null; accuracy: number | null; geofence: string; distance: number | null; note: string | null; ip: string | null; kioskId?: string },
  ) {
    const actor = requestContext.tenantActor();
    const now = Date.now();
    const today = await this.days.workDateAt(tx, e, now);
    if (await isLocked(tx, e.id, today)) {
      throw Errors.conflict('period_locked', 'Attendance for today is locked for payroll. Ask HR to unlock it.');
    }
    const existing = await tx.collection('attendance_events').findOne({ source: p.source, source_event_id: p.sourceEventId });
    let id = existing?.id;
    let direction = p.direction;
    if (!existing) {
      if (!direction) {
        // The next punch alternates with the last one in the current work day's window.
        const win = await this.days.window(tx, e, today);
        const last = (await this.days.punches(tx, e.id, win.from, Math.min(win.to, now + 1))).at(-1);
        direction = last && last.direction !== 'out' ? 'out' : 'in';
      }
      id = (
        await tx.collection('attendance_events').insert({
          employee_id: e.id,
          kiosk_id: p.kioskId ?? null,
          source: p.source,
          source_event_id: p.sourceEventId,
          captured_at: new Date(now),
          direction,
          verify_method: p.source === 'qr' ? 'qr' : null,
          latitude: p.latitude,
          longitude: p.longitude,
          accuracy_m: p.accuracy,
          geofence_result: p.geofence,
          distance_m: p.distance,
          recorded_by_membership_id: actor.membershipId,
          note: p.note,
          remote_ip: p.ip,
        })
      ).id as string;
      const [prev, cur] = this.days.datesFor(e, now);
      await this.days.recompute(tx, e.id, prev, cur, now);
    }
    const ev = (await tx.collection('attendance_events').findOne({ id }))!;
    const punch = { id: ev.id, capturedAt: ev.captured_at, direction: ev.direction, source: ev.source, geofence: ev.geofence_result ?? null, distanceM: ev.distance_m ?? null };
    return { punch, duplicate: Boolean(existing), today: await this.dayRow(tx, e.id, today) };
  }

  /** Signed, short-lived QR payload shown on a kiosk screen. */
  private qrCode(kioskId: string, window: number) {
    const mac = createHmac('sha256', this.qrKey).update(`${kioskId}.${window}`).digest('base64url').slice(0, 22);
    return `${kioskId}.${window}.${mac}`;
  }

  async qrPunch(code: string, direction?: 'in' | 'out') {
    const ctx = requestContext.get();
    return this.db.tenant(async (tx) => {
      const [kioskId, w, mac] = code.split('.');
      const window = Number(w);
      const now = Math.floor(Date.now() / QR_WINDOW_MS);
      const expected = kioskId && mac && Number.isInteger(window) && (window === now || window === now - 1) ? this.qrCode(kioskId, window) : null;
      const valid = expected !== null && expected.length === code.length && timingSafeEqual(Buffer.from(expected), Buffer.from(code));
      if (!valid) throw Errors.badRequest('qr_expired', 'This QR code has expired or is not valid. Scan the code on the kiosk screen again.');
      const kiosk = await tx.collection('attendance_kiosks').findOne({ id: kioskId, revoked_at: null });
      if (!kiosk) throw Errors.badRequest('qr_expired', 'This QR code has expired or is not valid. Scan the code on the kiosk screen again.');
      const e = await this.me(tx);
      await this.authz.require('attendance:punch', attrsOf(e), tx);
      this.requireEmployed(e, localToday(e.tz));
      const policy = await this.days.policy(tx, e.location_id);
      if (!policy.qr_punch) throw Errors.forbidden('QR punching is turned off for your location.');
      return this.record(tx, e, {
        source: 'qr', sourceEventId: `${kiosk.id}:${window}:${e.id}`, direction, latitude: null, longitude: null, accuracy: null,
        geofence: 'kiosk', distance: null, note: `Kiosk: ${kiosk.name}`, ip: ctx?.ip ?? null, kioskId: kiosk.id,
      });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Kiosks
  // ---------------------------------------------------------------------------------------------------------

  listKiosks() {
    return this.db.tenant(async (tx) => {
      const kiosks = await tx.collection('attendance_kiosks').find({});
      const locations = await fieldById(tx, 'locations', kiosks.map((k) => k.location_id));
      // Live kiosks first, by name; then revoked ones.
      return kiosks
        .filter((k) => locations.has(k.location_id))
        .sort((a, b) => Number(!!a.revoked_at) - Number(!!b.revoked_at) || (a.revoked_at && b.revoked_at ? a.revoked_at - b.revoked_at : 0) || String(a.name).localeCompare(String(b.name)))
        .map((k) => ({ id: k.id, name: k.name, locationId: k.location_id, locationName: locations.get(k.location_id)!, lastSeenAt: k.last_seen_at ?? null, revokedAt: k.revoked_at ?? null, createdAt: k.created_at }));
    });
  }

  async createKiosk(input: z.infer<typeof kioskInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('locations').exists({ id: input.locationId, archived_at: null }))) throw Errors.badRequest('invalid_location', 'Location not found');
      const token = randomBytes(32).toString('base64url');
      const row = await tx.collection('attendance_kiosks').insert({ name: input.name, location_id: input.locationId, token_hash: sha256(token), created_by: actor.userId });
      await this.audit.record(tx, { action: 'kiosk.created', resourceType: 'attendance_kiosk', resourceId: row.id, changes: input });
      // The token is shown once; only its hash is stored.
      return { id: row.id, ...input, token };
    });
  }

  async revokeKiosk(id: string) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('attendance_kiosks').updateOne({ id, revoked_at: null }, { $set: { revoked_at: new Date() } }))) throw Errors.notFound('Kiosk');
      await this.audit.record(tx, { action: 'kiosk.revoked', resourceType: 'attendance_kiosk', resourceId: id });
    });
  }

  /** For the kiosk screen itself, authenticated by its token (no user session). */
  async kioskDisplay(token: string) {
    const k = await this.db.platform(async (tx) => {
      const kiosk = await tx.collection('attendance_kiosks').findOne({ token_hash: sha256(token), revoked_at: null });
      const tenant = kiosk && (await tx.collection('tenants').findOne({ id: kiosk.tenant_id, status: 'active' }));
      const location = tenant && (await tx.collection('locations').findOne({ id: kiosk.location_id }));
      return location ? { id: kiosk.id as string, tenant_id: kiosk.tenant_id as string, name: kiosk.name as string, location: location.name as string, tenant: tenant.name as string, lastSeen: kiosk.last_seen_at as Date | null } : undefined;
    });
    if (!k) throw Errors.unauthorized('This kiosk link is not valid or was revoked');
    // Kiosks are part of advanced attendance; the screen stops showing codes when the plan no longer includes it.
    if (!(await this.db.tenant((tx) => loadEntitlements(tx), { tenantId: k.tenant_id })).features.has('attendance_advanced')) throw Errors.featureNotInPlan('Geofencing, kiosks, biometric devices');
    if (!k.lastSeen || k.lastSeen.getTime() < Date.now() - 60_000) {
      await this.db.platform((tx) => tx.collection('attendance_kiosks').updateOne({ id: k.id }, { $set: { last_seen_at: new Date() } }));
    }
    const window = Math.floor(Date.now() / QR_WINDOW_MS);
    return { kiosk: k.name, location: k.location, workspace: k.tenant, code: this.qrCode(k.id, window), expiresAt: new Date((window + 1) * QR_WINDOW_MS).toISOString(), refreshSeconds: QR_WINDOW_MS / 1000 };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------------------

  private async dayRow(tx: TenantTx, employeeId: string, date: string) {
    const d = await tx.collection('attendance_days').findOne({ employee_id: employeeId, work_date: date });
    return d ? (await dayViews(tx, [d]))[0] : undefined;
  }

  /** My day today: status, punches, what I can do next. */
  async today() {
    return this.db.tenant(async (tx) => {
      const e = await this.me(tx);
      const date = await this.days.workDateAt(tx, e, Date.now());
      const policy = await this.days.policy(tx, e.location_id);
      const plan = (await this.days.plan(tx, e, date, addDays(date, 1))).get(date)!;
      const win = await this.days.window(tx, e, date);
      const punches = await this.days.punches(tx, e.id, win.from, win.to);
      if (date >= e.date_of_joining) {
        // Punching recomputes the day itself; a view only refreshes a day that is missing or stale.
        const stored = await tx.collection('attendance_days').findOne({ employee_id: e.id, work_date: date });
        if (!stored || !(await freshDays(tx, date, [stored])).has(e.id)) await this.days.recompute(tx, e.id, date, date);
      }
      const last = punches.at(-1);
      return {
        employeeId: e.id,
        date,
        timeZone: e.tz,
        shift: plan.shift ? { code: plan.shift.code, name: plan.shift.name, start: plan.shift.start_time.slice(0, 5), end: plan.shift.end_time.slice(0, 5) } : null,
        dayType: plan.dayType,
        holidayName: plan.holidayName,
        nextDirection: last && last.direction !== 'out' ? 'out' : 'in',
        punches: punches.map((p) => ({ id: p.id, at: p.captured_at, direction: p.direction, source: p.source, geofence: p.geofence_result, device: p.device_name, viaCorrection: Boolean(p.correction_id), flags: p.risk_flags })),
        day: await this.dayRow(tx, e.id, date),
        allowed: { web: policy.web_punch, mobile: policy.mobile_punch, qr: policy.qr_punch },
        geofence: { mode: policy.geofence_mode, configured: Boolean(e.fence), radiusM: e.fence?.radiusM ?? null },
        locked: await isLocked(tx, e.id, date),
      };
    });
  }

  /** Days for one employee in a range, computing any that are missing. */
  async employeeDays(employeeId: string | undefined, from: string, to: string) {
    return this.db.tenant(async (tx) => {
      const e = employeeId ? await this.days.employee(tx, employeeId) : await this.me(tx);
      if (!e) throw Errors.notFound('Employee');
      await this.authz.require('attendance:read', attrsOf(e), tx);
      const today = localToday(e.tz);
      const end = to > today ? today : to;
      const start = from < e.date_of_joining ? e.date_of_joining : from;
      if (start <= end) {
        const have = new Set(
          (await tx.collection('attendance_days').find({ employee_id: e.id, work_date: { $gte: start, $lte: end, $lt: addDays(today, -1) } }, { projection: { work_date: 1 } })).map((r) => r.work_date as string),
        );
        for (let d = start; d <= end; d = addDays(d, 1)) if (!have.has(d)) await this.days.recompute(tx, e.id, d, d);
      }
      const rows = await dayViews(tx, await tx.collection('attendance_days').find({ employee_id: e.id, work_date: { $gte: from, $lte: to } }, { sort: { work_date: 1 } }));
      const count = (s: string) => rows.filter((r) => r.status === s).length;
      return {
        employee: { id: e.id, name: e.name, code: e.code, timeZone: e.tz },
        from, to,
        summary: {
          present: count('present'), halfDay: count('half_day') + count('half_day_leave'), absent: count('absent'), missingPunch: count('missing_punch'),
          onLeave: count('on_leave'), late: rows.filter((r) => r.lateMinutes > 0).length,
          workedMinutes: rows.reduce((t, r) => t + r.workedMinutes, 0),
          overtimeMinutes: rows.reduce((t, r) => t + r.overtimeMinutes, 0),
          approvedOvertimeMinutes: rows.reduce((t, r) => t + r.approvedOvertimeMinutes, 0),
        },
        days: rows,
        corrections: (await tx.collection('attendance_corrections').find({ employee_id: e.id, work_date: { $gte: from, $lte: to } }, { sort: { created_at: -1 } })).map((c) => ({
          id: c.id,
          workDate: c.work_date,
          status: c.status,
          punches: c.punches,
          reason: c.reason,
          createdAt: c.created_at,
        })),
        overtimeClaims: (await tx.collection('overtime_claims').find({ employee_id: e.id, work_date: { $gte: from, $lte: to } }, { sort: { created_at: -1 } })).map((c) => ({
          id: c.id,
          workDate: c.work_date,
          status: c.status,
          minutes: c.minutes,
          reason: c.reason ?? null,
        })),
      };
    });
  }

  /** One day in detail: the computed result and every raw punch behind it. */
  async dayDetail(employeeId: string, date: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.days.employee(tx, employeeId);
      if (!e) throw Errors.notFound('Employee');
      await this.authz.require('attendance:read', attrsOf(e), tx);
      const win = await this.days.window(tx, e, date);
      const punches = await this.days.punches(tx, e.id, win.from, win.to);
      return {
        employee: { id: e.id, name: e.name, code: e.code, timeZone: e.tz },
        day: (await this.dayRow(tx, e.id, date)) ?? null,
        window: { from: new Date(win.from).toISOString(), to: new Date(win.to).toISOString() },
        punches: punches.map((p) => ({ id: p.id, at: p.captured_at, direction: p.direction, source: p.source, geofence: p.geofence_result, device: p.device_name, verifyMethod: p.verify_method, viaCorrection: Boolean(p.correction_id), note: p.note, flags: p.risk_flags })),
        locked: await isLocked(tx, e.id, date),
      };
    });
  }

  /** Everyone the caller can see on one date, with a status summary. Recent days are refreshed first. */
  async team(q: { date: string; status?: string; departmentId?: string; locationId?: string }) {
    return this.db.tenant(async (tx) => {
      const scope = await this.authz.filter('attendance:read', EMPLOYEE_FIELDS, tx);
      const and: Record<string, unknown>[] = [scope, { date_of_joining: { $lte: q.date } }, { $or: [{ last_working_day: null }, { last_working_day: { $gte: q.date } }] }];
      if (q.departmentId) and.push({ current_department_id: q.departmentId });
      if (q.locationId) and.push({ current_location_id: q.locationId });
      // A day is refreshed when it was never computed, or (for today and yesterday, which change as time passes) when
      // it is older than TEAM_REFRESH_SECONDS or a leave request changed after it. Punches, corrections, devices and
      // shift changes recompute their days when they are written, so a busy team view does not rewrite every
      // person's day on every request.
      const employees = await tx.collection('employees').find({ $and: and }, { limit: 1000 });
      const ids = employees.map((e) => e.id as string);
      const stored = new Map((await tx.collection('attendance_days').find({ employee_id: { $in: ids }, work_date: q.date })).map((d) => [d.employee_id as string, d]));
      const fresh = await freshDays(tx, q.date, [...stored.values()]);
      const tenant = await tx.collection('tenants').findOne({});
      const locationTz = await fieldById(tx, 'locations', employees.map((e) => e.current_location_id), 'timezone');
      const entityTz = await fieldById(tx, 'legal_entities', employees.map((e) => e.current_legal_entity_id), 'timezone');
      const people = employees.map((e) => ({
        id: e.id as string,
        computed: stored.has(e.id),
        fresh: fresh.has(e.id),
        tz: locationTz.get(e.current_location_id) ?? entityTz.get(e.current_legal_entity_id) ?? (tenant!.timezone as string),
      }));
      const stale = people.filter((p) => q.date <= localToday(p.tz) && (!p.computed || (q.date >= addDays(localToday(p.tz), -1) && !p.fresh)));
      if (stale.length) {
        await this.days.lockBulk(tx);
        for (const p of stale.sort((a, b) => a.id.localeCompare(b.id))) await this.days.recompute(tx, p.id, q.date, q.date);
      }
      if (!people.length) return { date: q.date, summary: {}, rows: [] };
      const allDays = await tx.collection('attendance_days').find({ employee_id: { $in: ids }, work_date: q.date });
      const views = await dayViews(tx, q.status ? allDays.filter((d) => d.status === q.status) : allDays);
      const byId = new Map(employees.map((e) => [e.id as string, e]));
      const departments = await fieldById(tx, 'departments', employees.map((e) => e.current_department_id));
      const locations = await fieldById(tx, 'locations', employees.map((e) => e.current_location_id));
      const rows = views
        .map((d) => {
          const e = byId.get(d.employeeId)!;
          return {
            ...d,
            employeeName: `${e.preferred_name ?? e.first_name} ${e.last_name}`.trim(),
            employeeCode: e.employee_code as string,
            department: departments.get(e.current_department_id) ?? null,
            location: locations.get(e.current_location_id) ?? null,
          };
        })
        .sort((a, b) => (a.employeeName < b.employeeName ? -1 : a.employeeName > b.employeeName ? 1 : 0));
      const all = allDays.map((d) => ({ status: d.status as string, lateMinutes: d.late_minutes as number, firstIn: d.first_in ?? null, lastOut: d.last_out ?? null }));
      const summary: Record<string, number> = { total: all.length, late: all.filter((r) => r.lateMinutes > 0).length, onSiteNow: all.filter((r) => r.status === 'in_progress' && r.firstIn && !r.lastOut).length };
      for (const r of all) summary[r.status] = (summary[r.status] ?? 0) + 1;
      return { date: q.date, summary, rows };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Corrections
  // ---------------------------------------------------------------------------------------------------------

  async requestCorrection(input: CorrectionInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const { e, onBehalf } = await this.target(tx, input.employeeId, 'attendance:correct');
      const today = localToday(e.tz);
      if (input.workDate > today) throw Errors.badRequest('future_date', 'You cannot correct a day that has not happened yet.');
      if (input.workDate < e.date_of_joining) throw Errors.badRequest('before_joining', 'That date is before the joining date.');
      const policy = await this.days.policy(tx, e.location_id);
      const s = await this.authz.subject(tx);
      const isAdmin = grantsFor(s, 'attendance:configure').some((g) => grantCovers(s, g, attrsOf(e)));
      if (!isAdmin && input.workDate < addDays(today, -policy.correction_window_days)) {
        throw Errors.badRequest('too_old', `Corrections can be requested for the last ${policy.correction_window_days} days only.`);
      }
      if (await isLocked(tx, e.id, input.workDate)) {
        throw Errors.conflict('period_locked', 'This date is in a period locked for payroll.');
      }
      const times = input.punches.map((p) => fromLocal(input.workDate, hhmm(p.time) + (p.nextDay ? 1440 : 0), e.tz));
      if (times.some((t) => t > Date.now())) throw Errors.badRequest('future_time', 'A corrected punch cannot be in the future.');
      const row = (await tx.collection('attendance_corrections').insert({
        employee_id: e.id,
        work_date: input.workDate,
        punches: input.punches,
        reason: input.reason,
        requested_by_membership_id: actor.membershipId,
      }).catch((err: { code?: string }) => {
        if (err.code === '23505') throw Errors.conflict('correction_pending', 'There is already a pending correction for this day.');
        throw err;
      }))!;
      const summary = `${e.name}: add ${input.punches.map((p) => `${p.direction} ${p.time}${p.nextDay ? ' (next day)' : ''}`).join(', ')} on ${input.workDate}. "${input.reason}"`;
      const approvalId = await this.approvals.start(tx, { resourceType: 'attendance_correction', resourceId: row.id, subjectEmployeeId: e.id, summary });
      await tx.collection('attendance_corrections').updateOne({ id: row.id }, { $set: { approval_request_id: approvalId } });
      await this.audit.record(tx, { action: 'attendance_correction.submitted', resourceType: 'attendance_correction', resourceId: row.id, changes: { employeeId: e.id, workDate: input.workDate, punches: input.punches }, metadata: { onBehalf } });
      return this.correction(tx, row.id);
    });
  }

  private async correction(tx: TenantTx, id: string) {
    const c = await tx.collection('attendance_corrections').findOne({ id });
    return c ? (await correctionViews(tx, [c]))[0] : undefined;
  }

  private async correctionApproved(tx: TenantTx, req: ApprovalRequestRow) {
    const c = await tx.collection<{ id: string; employee_id: string; work_date: string; punches: { time: string; direction: 'in' | 'out'; nextDay?: boolean }[]; requested_by_membership_id: string | null }>(
      'attendance_corrections',
    ).findOne({ id: req.resource_id, status: 'pending' });
    if (!c) return;
    const e = (await this.days.employee(tx, c.employee_id))!;
    if (await isLocked(tx, e.id, c.work_date)) {
      throw Errors.conflict('period_locked', 'This date was locked for payroll after the correction was requested. Unlock the period first.');
    }
    if (!(await tx.collection('attendance_corrections').updateOne({ id: c.id, status: 'pending' }, { $set: { status: 'approved', decided_at: new Date() } }))) return;
    for (const [i, p] of c.punches.entries()) {
      // Corrections add punches; the original record stays as it was.
      await tx.collection('attendance_events').insert({
        employee_id: e.id,
        source: 'correction',
        source_event_id: `${c.id}:${i}`,
        captured_at: new Date(fromLocal(c.work_date, hhmm(p.time) + (p.nextDay ? 1440 : 0), e.tz)),
        direction: p.direction,
        correction_id: c.id,
        recorded_by_membership_id: c.requested_by_membership_id,
        note: 'Approved correction',
      });
    }
    await this.days.recompute(tx, e.id, addDays(c.work_date, -1), addDays(c.work_date, 1) > localToday(e.tz) ? c.work_date : addDays(c.work_date, 1));
    await this.audit.record(tx, { action: 'attendance_correction.approved', resourceType: 'attendance_correction', resourceId: c.id, metadata: { workDate: c.work_date, punches: c.punches.length } });
  }

  async listCorrections(q: { scope: 'mine' | 'visible'; status?: string }) {
    return this.db.tenant(async (tx) => {
      const and: Record<string, unknown>[] = [];
      if (q.scope === 'mine') and.push({ employee_id: (await this.me(tx)).id });
      else {
        const scope = await this.authz.filter('attendance:read', EMPLOYEE_FIELDS, tx);
        and.push({ employee_id: { $in: (await tx.collection('employees').find(scope, { projection: { _id: 1 } })).map((e) => e.id) } });
      }
      if (q.status) and.push({ status: q.status });
      const rows = await tx.collection('attendance_corrections').find({ $and: and }, { sort: { created_at: -1 }, limit: 200 });
      return (await correctionViews(tx, rows)).map(({ approvalId: _a, ...c }) => c);
    });
  }

  async cancelCorrection(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const c = await tx.collection('attendance_corrections').findOne({ id });
      if (!c) throw Errors.notFound('Correction');
      const e = (await this.days.employee(tx, c.employee_id))!;
      if (c.requested_by_membership_id !== actor.membershipId && e.membership_id !== actor.membershipId) {
        await this.authz.require('attendance:read', attrsOf(e), tx);
        throw Errors.forbidden('Only the person who asked for this correction can withdraw it');
      }
      if (c.status !== 'pending') throw Errors.conflict('invalid_state', `This correction is already ${c.status}`);
      if (!(await tx.collection('attendance_corrections').updateOne({ id, status: 'pending' }, { $set: { status: 'cancelled', decided_at: new Date() } }))) {
        throw Errors.conflict('invalid_state', 'This correction was decided meanwhile');
      }
      if (c.approval_request_id) await this.approvals.cancel(tx, c.approval_request_id);
      await this.audit.record(tx, { action: 'attendance_correction.cancelled', resourceType: 'attendance_correction', resourceId: id });
      return this.correction(tx, id);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Overtime
  // ---------------------------------------------------------------------------------------------------------

  async claimOvertime(input: z.infer<typeof overtimeClaimInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const { e, onBehalf } = await this.target(tx, input.employeeId, 'attendance:correct');
      const policy = await this.days.policy(tx, e.location_id);
      if (!policy.overtime_requires_approval) throw Errors.badRequest('no_approval_needed', 'Overtime at your location counts automatically; there is nothing to claim.');
      if (await isLocked(tx, e.id, input.workDate)) throw Errors.conflict('period_locked', 'This date is in a period locked for payroll.');
      await this.days.recompute(tx, e.id, input.workDate, input.workDate);
      const day = await tx.collection('attendance_days').findOne({ employee_id: e.id, work_date: input.workDate });
      if (!day || day.overtime_minutes <= 0) throw Errors.badRequest('no_overtime', 'No overtime was recorded on this day.');
      if (input.minutes > day.overtime_minutes) throw Errors.badRequest('too_many_minutes', `At most ${day.overtime_minutes} minutes of overtime were recorded on this day.`);
      const row = (await tx.collection('overtime_claims').insert({
        employee_id: e.id,
        work_date: input.workDate,
        minutes: input.minutes,
        computed_minutes: day.overtime_minutes,
        reason: input.reason ?? null,
        requested_by_membership_id: actor.membershipId,
      }).catch((err: { code?: string }) => {
        if (err.code === '23505') throw Errors.conflict('claim_exists', 'There is already a pending or approved overtime claim for this day.');
        throw err;
      }))!;
      const approvalId = await this.approvals.start(tx, {
        resourceType: 'overtime_claim', resourceId: row.id, subjectEmployeeId: e.id,
        summary: `${e.name}: ${input.minutes} minutes of overtime on ${input.workDate}${input.reason ? `. "${input.reason}"` : ''}`,
      });
      await tx.collection('overtime_claims').updateOne({ id: row.id }, { $set: { approval_request_id: approvalId } });
      await this.audit.record(tx, { action: 'overtime_claim.submitted', resourceType: 'overtime_claim', resourceId: row.id, changes: { employeeId: e.id, workDate: input.workDate, minutes: input.minutes }, metadata: { onBehalf } });
      const claim = (await tx.collection('overtime_claims').findOne({ id: row.id }))!;
      return { id: claim.id, employeeId: claim.employee_id, workDate: claim.work_date, minutes: claim.minutes, computedMinutes: claim.computed_minutes, status: claim.status, reason: claim.reason ?? null };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Policies, locks, recompute
  // ---------------------------------------------------------------------------------------------------------

  listPolicies() {
    return this.db.tenant(async (tx) => {
      const policies = await tx.collection('attendance_policies').find({});
      const locations = await fieldById(tx, 'locations', policies.map((p) => p.location_id));
      const shifts = await fieldById(tx, 'shift_templates', policies.map((p) => p.default_shift_id));
      return policies
        .map((p) => ({
          id: p.id,
          locationId: p.location_id ?? null,
          locationName: locations.get(p.location_id) ?? null,
          webPunch: p.web_punch,
          mobilePunch: p.mobile_punch,
          qrPunch: p.qr_punch,
          geofenceMode: p.geofence_mode,
          defaultShiftId: p.default_shift_id ?? null,
          defaultShiftName: shifts.get(p.default_shift_id) ?? null,
          overtimeRequiresApproval: p.overtime_requires_approval,
          earlyWindowMinutes: p.early_window_minutes,
          correctionWindowDays: p.correction_window_days,
        }))
        .sort((a, b) => Number(a.locationId !== null) - Number(b.locationId !== null) || String(a.locationName ?? '').localeCompare(String(b.locationName ?? '')));
    });
  }

  async savePolicy(input: AttendancePolicyInput) {
    return this.db.tenant(async (tx) => {
      if (input.locationId && !(await tx.collection('locations').exists({ id: input.locationId }))) throw Errors.badRequest('invalid_location', 'Location not found');
      if (input.defaultShiftId && !(await tx.collection('shift_templates').exists({ id: input.defaultShiftId, archived_at: null }))) throw Errors.badRequest('invalid_shift', 'Shift not found');
      const before = await tx.collection('attendance_policies').findOne({ location_id: input.locationId ?? null });
      const values = {
        web_punch: input.webPunch,
        mobile_punch: input.mobilePunch,
        qr_punch: input.qrPunch,
        geofence_mode: input.geofenceMode,
        default_shift_id: input.defaultShiftId ?? null,
        overtime_requires_approval: input.overtimeRequiresApproval,
        early_window_minutes: input.earlyWindowMinutes,
        correction_window_days: input.correctionWindowDays,
      };
      if (before) await tx.collection('attendance_policies').updateOne({ id: before.id }, { $set: values });
      else await tx.collection('attendance_policies').insert({ location_id: input.locationId ?? null, ...values });
      await this.audit.record(tx, { action: before ? 'attendance_policy.updated' : 'attendance_policy.created', resourceType: 'attendance_policy', resourceId: input.locationId ?? 'default', changes: input });
      return input;
    });
  }

  async removePolicy(locationId: string) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('attendance_policies').deleteOne({ location_id: locationId }))) throw Errors.notFound('Location policy');
      await this.audit.record(tx, { action: 'attendance_policy.removed', resourceType: 'attendance_policy', resourceId: locationId });
    });
  }

  listLocks() {
    return this.db.tenant(async (tx) => {
      const periods = await tx.collection('attendance_periods').find({}, { sort: { period_start: -1, locked_at: -1 }, limit: 100 });
      const entities = await fieldById(tx, 'legal_entities', periods.map((p) => p.legal_entity_id));
      const users = await (await usersTable(tx)).find({ id: { $in: [...new Set(periods.flatMap((p) => [p.locked_by, p.unlocked_by]).filter(Boolean))] } }, { projection: { full_name: 1 } });
      const name = new Map(users.map((u) => [u.id as string, (u.full_name as string | null) ?? null]));
      return periods.map((p) => ({
        id: p.id,
        legalEntityId: p.legal_entity_id ?? null,
        legalEntityName: entities.get(p.legal_entity_id) ?? null,
        periodStart: p.period_start,
        periodEnd: p.period_end,
        note: p.note ?? null,
        lockedAt: p.locked_at,
        lockedBy: name.get(p.locked_by) ?? null,
        unlockedAt: p.unlocked_at ?? null,
        unlockedBy: name.get(p.unlocked_by) ?? null,
        unlockReason: p.unlock_reason ?? null,
      }));
    });
  }

  async lock(input: z.infer<typeof periodLockInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      if (input.legalEntityId && !(await tx.collection('legal_entities').exists({ id: input.legalEntityId }))) throw Errors.badRequest('invalid_legal_entity', 'Legal entity not found');
      // Live locks for one entity (or the whole workspace) never overlap (an exclusion constraint in PostgreSQL).
      if (
        await tx.collection('attendance_periods').exists({
          unlocked_at: null,
          legal_entity_id: input.legalEntityId ?? null,
          period_start: { $lte: input.periodEnd },
          period_end: { $gte: input.periodStart },
        })
      ) {
        throw Errors.conflict('already_locked', 'Part of this period is already locked.');
      }
      const row = await tx.collection('attendance_periods').insert({
        legal_entity_id: input.legalEntityId ?? null,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        note: input.note ?? null,
        locked_by: actor.userId,
      });
      const open = await tx.collection('attendance_corrections').find({ status: 'pending', work_date: { $gte: input.periodStart, $lte: input.periodEnd } }, { projection: { employee_id: 1 } });
      const inEntity = input.legalEntityId
        ? new Set((await tx.collection('employees').find({ id: { $in: open.map((c) => c.employee_id) }, current_legal_entity_id: input.legalEntityId }, { projection: { _id: 1 } })).map((e) => e.id))
        : null;
      const pending = { n: open.filter((c) => !inEntity || inEntity.has(c.employee_id)).length };
      await this.audit.record(tx, { action: 'attendance_period.locked', resourceType: 'attendance_period', resourceId: row.id, changes: input, metadata: { pendingCorrections: pending!.n } });
      return { id: row.id, ...input, pendingCorrections: pending!.n };
    });
  }

  async unlock(id: string, reason: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('attendance_periods').updateOne({ id, unlocked_at: null }, { $set: { unlocked_at: new Date(), unlocked_by: actor.userId, unlock_reason: reason } }))) {
        throw Errors.notFound('Locked period');
      }
      await this.audit.record(tx, { action: 'attendance_period.unlocked', resourceType: 'attendance_period', resourceId: id, metadata: { reason } });
    });
  }

  /** Recomputes days, for one employee or everyone the caller can configure, in a range of up to 62 days. */
  async recomputeRange(q: { employeeId?: string; from: string; to: string }) {
    return this.db.tenant(async (tx) => {
      const scope = await this.authz.filter('attendance:configure', EMPLOYEE_FIELDS, tx);
      const people = await tx.collection('employees').find(
        { $and: [scope, { date_of_joining: { $lte: q.to } }, { $or: [{ last_working_day: null }, { last_working_day: { $gte: q.from } }] }, ...(q.employeeId ? [{ id: q.employeeId }] : [])] },
        { projection: { _id: 1 } },
      );
      let days = 0;
      if (people.length > 1) await this.days.lockBulk(tx);
      for (const p of people) days += (await this.days.recompute(tx, p.id, q.from, q.to)).size;
      await this.audit.record(tx, { action: 'attendance.recomputed', resourceType: 'attendance', resourceId: q.employeeId ?? 'all', metadata: { from: q.from, to: q.to, employees: people.length, days } });
      return { employees: people.length, days };
    });
  }

  /**
   * Hourly: brings the last few days up to date for everyone, so absences appear without anyone opening a page
   * and in-progress days close once their window ends.
   */
  async refreshRecent(tenantId: string, days = 2) {
    return this.db.tenant(async (tx) => {
      const utcToday = new Date().toISOString().slice(0, 10);
      const people = await tx.collection('employees').find(
        { status: { $ne: 'pre_boarding' }, date_of_joining: { $lte: addDays(utcToday, 1) }, $or: [{ last_working_day: null }, { last_working_day: { $gte: addDays(utcToday, -(days + 1)) } }] },
        { projection: { _id: 1 } },
      );
      let n = 0;
      if (people.length) await this.days.lockBulk(tx);
      for (const p of people.sort((a, b) => a.id.localeCompare(b.id))) {
        const e = (await this.days.employee(tx, p.id))!;
        const today = localToday(e.tz);
        const from = addDays(today, -days) < e.date_of_joining ? e.date_of_joining : addDays(today, -days);
        if (from <= today) n += (await this.days.recompute(tx, e.id, from, today)).size;
      }
      return n;
    }, { tenantId });
  }

  /** Recompute hook for other modules (leave approvals and cancellations change attendance days). */
  async recomputeFor(tx: TenantTx, employeeId: string, from: string, to: string) {
    const e = await this.days.employee(tx, employeeId);
    if (!e) return;
    const today = localToday(e.tz);
    const end = to > today ? today : to;
    if (from <= end) await this.days.recompute(tx, employeeId, from < e.date_of_joining ? e.date_of_joining : from, end);
  }
}
