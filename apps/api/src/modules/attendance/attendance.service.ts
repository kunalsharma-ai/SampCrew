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
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService, type ApprovalRequestRow } from '../approvals/approvals.service';
import { EMPLOYEE_SCOPE, employeeAttrs } from '../employees/employee-attrs';
import { AttendanceDaysService, type EmployeeCtx } from './attendance-days.service';

const { addDays, fromLocal, hhmm, localToday } = zonedTime;
const QR_WINDOW_MS = 30_000;

const DAY_COLUMNS = `d.employee_id as "employeeId", d.work_date as "workDate", d.status, d.day_type as "dayType", d.leave_part as "leavePart",
  d.first_in as "firstIn", d.last_out as "lastOut", d.worked_minutes as "workedMinutes", d.break_minutes as "breakMinutes",
  d.late_minutes as "lateMinutes", d.early_leave_minutes as "earlyLeaveMinutes", d.overtime_minutes as "overtimeMinutes",
  d.approved_overtime_minutes as "approvedOvertimeMinutes", d.flags, d.explanation, d.punch_count as "punchCount", d.computed_at as "computedAt",
  st.code as "shiftCode", st.name as "shiftName", to_char(st.start_time, 'HH24:MI') as "shiftStart", to_char(st.end_time, 'HH24:MI') as "shiftEnd", st.color as "shiftColor"`;

const attrsOf = (e: EmployeeCtx) =>
  employeeAttrs({ id: e.id, membershipId: e.membership_id, legalEntityId: e.legal_entity_id, departmentId: e.department_id, locationId: e.location_id });

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Punching, attendance views, corrections, overtime claims, policies, period locks and QR kiosks.
 * Raw punches are append-only; everything shown as a "day" is computed by the attendance engine.
 */
/** How long a computed day for today or yesterday is reused by read views before it is refreshed. */
const TEAM_REFRESH_SECONDS = 30;
/** SQL that is true when employee `e`'s computed day `d` for date $1 can be reused (see TEAM_REFRESH_SECONDS). */
const freshDay = (secondsParam: string) => `d.computed_at > now() - make_interval(secs => ${secondsParam}::int)
          and not exists (select 1 from leave_requests lr where lr.employee_id = e.id and lr.updated_at > d.computed_at and lr.start_date <= $1 and lr.end_date >= $1)`;

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
        await tx.query(`update attendance_corrections set status = 'rejected', decided_at = now() where id = $1 and status = 'pending'`, [req.resource_id]);
        await this.audit.record(tx, { action: 'attendance_correction.rejected', resourceType: 'attendance_correction', resourceId: req.resource_id });
      },
    });
    this.approvals.register('overtime_claim', {
      ...common,
      label: 'Overtime claim',
      link: () => '/attendance',
      attributes: async (tx, id) => attrsOf((await this.employeeFor(tx, 'overtime_claims', id))!),
      onApproved: async (tx, req) => {
        const c = (await one<{ employee_id: string; work_date: string; minutes: number }>(tx, `update overtime_claims set status = 'approved', decided_at = now() where id = $1 and status = 'pending' returning employee_id, work_date, minutes`, [req.resource_id]));
        if (!c) return;
        await this.days.recompute(tx, c.employee_id, c.work_date, c.work_date);
        await this.audit.record(tx, { action: 'overtime_claim.approved', resourceType: 'overtime_claim', resourceId: req.resource_id, metadata: { minutes: c.minutes, workDate: c.work_date } });
      },
      onRejected: async (tx, req) => {
        await tx.query(`update overtime_claims set status = 'rejected', decided_at = now() where id = $1 and status = 'pending'`, [req.resource_id]);
        await this.audit.record(tx, { action: 'overtime_claim.rejected', resourceType: 'overtime_claim', resourceId: req.resource_id });
      },
    });
  }

  private async employeeFor(tx: Tx, table: 'attendance_corrections' | 'overtime_claims', id: string) {
    const r = await one<{ employee_id: string }>(tx, `select employee_id from ${table} where id = $1`, [id]);
    return r ? this.days.employee(tx, r.employee_id) : undefined;
  }

  private async me(tx: Tx): Promise<EmployeeCtx> {
    const s = await this.authz.subject(tx);
    if (!s.employeeId) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet. Ask HR to link it.');
    return (await this.days.employee(tx, s.employeeId))!;
  }

  /** The employee a request is about: the caller, or someone they may act for with the given permission. */
  private async target(tx: Tx, employeeId: string | undefined, permission: string): Promise<{ e: EmployeeCtx; onBehalf: boolean }> {
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
      const device = await one<{ id: string }>(tx, 'select id from mobile_devices where id = $1 and membership_id = $2 and revoked_at is null', [input.deviceId, actor.membershipId]);
      if (!device) throw Errors.notFound('Device');
      const e = await this.me(tx);
      await this.authz.require('attendance:punch', attrsOf(e), tx);
      const policy = await this.days.policy(tx, e.location_id);
      const results: Record<string, unknown>[] = [];
      const touched: number[] = [];
      for (const p of [...input.punches].sort((a, b) => a.sequence - b.sequence)) {
        const sourceEventId = mobileSync.punchEventId(device.id, p.sequence);
        const existing = await one<{ id: string; captured_at: Date; direction: string; risk_flags: string[] }>(
          tx, `select id, captured_at, direction, risk_flags from attendance_events where source = 'mobile' and source_event_id = $1`, [sourceEventId],
        );
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
        const locked = (await one<{ locked: boolean }>(tx, 'select attendance_is_locked($1, $2) as locked', [e.id, workDate]))!.locked;
        let direction = p.direction;
        if (!direction) {
          const win = await this.days.window(tx, e, workDate);
          const last = (await this.days.punches(tx, e.id, win.from, at)).at(-1);
          direction = last && last.direction !== 'out' ? 'out' : 'in';
        }
        const row = (await one<{ id: string }>(
          tx,
          `insert into attendance_events (tenant_id, employee_id, source, source_event_id, captured_at, device_local_time, direction, latitude, longitude, accuracy_m,
                                          geofence_result, distance_m, recorded_by_membership_id, note, remote_ip, raw, mobile_device_id, risk_flags, arrived_after_lock)
           values (app_tenant_id(), $1, 'mobile', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
           on conflict (tenant_id, source, source_event_id) do nothing returning id`,
          [e.id, sourceEventId, new Date(at), p.capturedAt, direction, p.latitude ?? null, p.longitude ?? null, p.accuracyM ?? null, geofence, distance,
            actor.membershipId, p.note ?? null, ctx?.ip ?? null,
            JSON.stringify({ timeBasis: capture.basis, phoneTime: p.capturedAt, capturedElapsedMs: p.capturedElapsedMs ?? null, sentElapsedMs: input.sentElapsedMs ?? null, sameRun: p.capturedRunId !== undefined && p.capturedRunId === input.sentRunId }),
            device.id, flags, locked],
        ));
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
      await tx.query('update mobile_devices set last_sync_at = now(), last_seen_at = now() where id = $1', [device.id]);
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
    tx: Tx,
    e: EmployeeCtx,
    p: { source: 'web' | 'mobile' | 'qr'; sourceEventId: string; direction?: 'in' | 'out'; latitude: number | null; longitude: number | null; accuracy: number | null; geofence: string; distance: number | null; note: string | null; ip: string | null; kioskId?: string },
  ) {
    const actor = requestContext.tenantActor();
    const now = Date.now();
    const today = await this.days.workDateAt(tx, e, now);
    if ((await one<{ locked: boolean }>(tx, 'select attendance_is_locked($1, $2) as locked', [e.id, today]))!.locked) {
      throw Errors.conflict('period_locked', 'Attendance for today is locked for payroll. Ask HR to unlock it.');
    }
    const existing = await one<{ id: string }>(tx, 'select id from attendance_events where source = $1 and source_event_id = $2', [p.source, p.sourceEventId]);
    let id = existing?.id;
    let direction = p.direction;
    if (!existing) {
      if (!direction) {
        // The next punch alternates with the last one in the current work day's window.
        const win = await this.days.window(tx, e, today);
        const last = (await this.days.punches(tx, e.id, win.from, Math.min(win.to, now + 1))).at(-1);
        direction = last && last.direction !== 'out' ? 'out' : 'in';
      }
      id = (await one<{ id: string }>(
        tx,
        `insert into attendance_events (tenant_id, employee_id, kiosk_id, source, source_event_id, captured_at, direction, verify_method, latitude, longitude, accuracy_m,
                                        geofence_result, distance_m, recorded_by_membership_id, note, remote_ip)
         values (app_tenant_id(), $1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         on conflict (tenant_id, source, source_event_id) do nothing returning id`,
        [e.id, p.kioskId ?? null, p.source, p.sourceEventId, direction, p.source === 'qr' ? 'qr' : null, p.latitude, p.longitude, p.accuracy, p.geofence, p.distance, actor.membershipId, p.note, p.ip],
      ))?.id ?? (await one<{ id: string }>(tx, 'select id from attendance_events where source = $1 and source_event_id = $2', [p.source, p.sourceEventId]))!.id;
      const [prev, cur] = this.days.datesFor(e, now);
      await this.days.recompute(tx, e.id, prev, cur, now);
    }
    const punch = (await one(tx, `select id, captured_at as "capturedAt", direction, source, geofence_result as "geofence", distance_m as "distanceM" from attendance_events where id = $1`, [id]))!;
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
      const kiosk = await one<{ id: string; location_id: string; name: string }>(tx, 'select id, location_id, name from attendance_kiosks where id = $1 and revoked_at is null', [kioskId]);
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
    return this.db.tenant((tx) =>
      many(tx, `select k.id, k.name, k.location_id as "locationId", l.name as "locationName", k.last_seen_at as "lastSeenAt", k.revoked_at as "revokedAt", k.created_at as "createdAt"
                  from attendance_kiosks k join locations l on l.id = k.location_id order by k.revoked_at nulls first, k.name`),
    );
  }

  async createKiosk(input: z.infer<typeof kioskInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      if (!(await one(tx, 'select 1 from locations where id = $1 and archived_at is null', [input.locationId]))) throw Errors.badRequest('invalid_location', 'Location not found');
      const token = randomBytes(32).toString('base64url');
      const row = (await one<{ id: string }>(
        tx, `insert into attendance_kiosks (tenant_id, name, location_id, token_hash, created_by) values (app_tenant_id(), $1, $2, $3, $4) returning id`,
        [input.name, input.locationId, sha256(token), actor.userId],
      ))!;
      await this.audit.record(tx, { action: 'kiosk.created', resourceType: 'attendance_kiosk', resourceId: row.id, changes: input });
      // The token is shown once; only its hash is stored.
      return { id: row.id, ...input, token };
    });
  }

  async revokeKiosk(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.query('update attendance_kiosks set revoked_at = now() where id = $1 and revoked_at is null', [id]);
      if (!r.rowCount) throw Errors.notFound('Kiosk');
      await this.audit.record(tx, { action: 'kiosk.revoked', resourceType: 'attendance_kiosk', resourceId: id });
    });
  }

  /** For the kiosk screen itself, authenticated by its token (no user session). */
  async kioskDisplay(token: string) {
    const k = await this.db.platform((tx) =>
      one<{ id: string; tenant_id: string; name: string; location: string; tenant: string }>(
        tx,
        `select k.id, k.tenant_id, k.name, l.name as location, t.name as tenant from attendance_kiosks k join locations l on l.id = k.location_id join tenants t on t.id = k.tenant_id
          where k.token_hash = $1 and k.revoked_at is null and t.status = 'active'`,
        [sha256(token)],
      ),
    );
    if (!k) throw Errors.unauthorized('This kiosk link is not valid or was revoked');
    // Kiosks are part of advanced attendance; the screen stops showing codes when the plan no longer includes it.
    if (!(await this.db.tenant((tx) => loadEntitlements(tx), { tenantId: k.tenant_id })).features.has('attendance_advanced')) throw Errors.featureNotInPlan('Geofencing, kiosks, biometric devices');
    await this.db.platform((tx) => tx.query('update attendance_kiosks set last_seen_at = now() where id = $1 and (last_seen_at is null or last_seen_at < now() - interval \'1 minute\')', [k.id]));
    const window = Math.floor(Date.now() / QR_WINDOW_MS);
    return { kiosk: k.name, location: k.location, workspace: k.tenant, code: this.qrCode(k.id, window), expiresAt: new Date((window + 1) * QR_WINDOW_MS).toISOString(), refreshSeconds: QR_WINDOW_MS / 1000 };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------------------

  private dayRow(tx: Tx, employeeId: string, date: string) {
    return one(tx, `select ${DAY_COLUMNS} from attendance_days d left join shift_templates st on st.id = d.shift_template_id where d.employee_id = $1 and d.work_date = $2`, [employeeId, date]);
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
        const reuse = await one<{ ok: boolean }>(
          tx, `select coalesce((select ${freshDay('$3')} from employees e join attendance_days d on d.employee_id = e.id and d.work_date = $1 where e.id = $2), false) as ok`,
          [date, e.id, TEAM_REFRESH_SECONDS],
        );
        if (!reuse!.ok) await this.days.recompute(tx, e.id, date, date);
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
        locked: (await one<{ locked: boolean }>(tx, 'select attendance_is_locked($1, $2) as locked', [e.id, date]))!.locked,
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
        const have = new Set((await many<{ d: string }>(tx, `select work_date as d from attendance_days where employee_id = $1 and work_date between $2 and $3 and work_date < $4`, [e.id, start, end, addDays(today, -1)])).map((r) => r.d));
        for (let d = start; d <= end; d = addDays(d, 1)) if (!have.has(d)) await this.days.recompute(tx, e.id, d, d);
      }
      const rows = await many<{ workDate: string; status: string; workedMinutes: number; lateMinutes: number; overtimeMinutes: number; approvedOvertimeMinutes: number }>(
        tx, `select ${DAY_COLUMNS} from attendance_days d left join shift_templates st on st.id = d.shift_template_id where d.employee_id = $1 and d.work_date between $2 and $3 order by d.work_date`,
        [e.id, from, to],
      );
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
        corrections: await many(tx, `select id, work_date as "workDate", status, punches, reason, created_at as "createdAt" from attendance_corrections where employee_id = $1 and work_date between $2 and $3 order by created_at desc`, [e.id, from, to]),
        overtimeClaims: await many(tx, `select id, work_date as "workDate", status, minutes, reason from overtime_claims where employee_id = $1 and work_date between $2 and $3 order by created_at desc`, [e.id, from, to]),
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
        locked: (await one<{ locked: boolean }>(tx, 'select attendance_is_locked($1, $2) as locked', [e.id, date]))!.locked,
      };
    });
  }

  /** Everyone the caller can see on one date, with a status summary. Recent days are refreshed first. */
  async team(q: { date: string; status?: string; departmentId?: string; locationId?: string }) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [q.date];
      const where = [await this.authz.predicate('attendance:read', EMPLOYEE_SCOPE, params, tx), `e.date_of_joining <= $1`, `(e.last_working_day is null or e.last_working_day >= $1)`];
      if (q.departmentId) { params.push(q.departmentId); where.push(`e.current_department_id = $${params.length}`); }
      if (q.locationId) { params.push(q.locationId); where.push(`e.current_location_id = $${params.length}`); }
      // A day is refreshed when it was never computed, or (for today and yesterday, which change as time passes) when
      // it is older than TEAM_REFRESH_SECONDS or a leave request changed after it. Punches, corrections, devices and
      // shift changes recompute their days when they are written, so a busy team view no longer rewrites every
      // person's day on every request (the load test showed those writes queueing behind each other).
      params.push(TEAM_REFRESH_SECONDS);
      const fresh = freshDay(`$${params.length}`);
      const people = await many<{ id: string; computed: string | null; fresh: boolean; tz: string }>(
        tx,
        `select e.id, d.computed_at as computed, coalesce(${fresh}, false) as fresh, coalesce(l.timezone, le.timezone, t.timezone) as tz from employees e join tenants t on t.id = e.tenant_id
           left join locations l on l.id = e.current_location_id left join legal_entities le on le.id = e.current_legal_entity_id
           left join attendance_days d on d.employee_id = e.id and d.work_date = $1
          where ${where.join(' and ')} limit 1000`,
        params,
      );
      const stale = people.filter((p) => q.date <= localToday(p.tz) && (!p.computed || (q.date >= addDays(localToday(p.tz), -1) && !p.fresh)));
      if (stale.length) {
        await this.days.lockBulk(tx);
        for (const p of stale.sort((a, b) => a.id.localeCompare(b.id))) await this.days.recompute(tx, p.id, q.date, q.date);
      }
      if (!people.length) return { date: q.date, summary: {}, rows: [] };
      const rows = await many<{ status: string; lateMinutes: number; firstIn: string | null; lastOut: string | null }>(
        tx,
        `select ${DAY_COLUMNS}, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as "employeeName", e.employee_code as "employeeCode",
                dep.name as "department", loc.name as "location"
           from employees e join attendance_days d on d.employee_id = e.id and d.work_date = $1
           left join shift_templates st on st.id = d.shift_template_id
           left join departments dep on dep.id = e.current_department_id left join locations loc on loc.id = e.current_location_id
          where e.id = any($2) ${q.status ? 'and d.status = $3' : ''}
          order by "employeeName"`,
        q.status ? [q.date, people.map((p) => p.id), q.status] : [q.date, people.map((p) => p.id)],
      );
      const all = q.status
        ? await many<{ status: string; lateMinutes: number; firstIn: string | null; lastOut: string | null }>(tx, `select status, late_minutes as "lateMinutes", first_in as "firstIn", last_out as "lastOut" from attendance_days where work_date = $1 and employee_id = any($2)`, [q.date, people.map((p) => p.id)])
        : rows;
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
      if ((await one<{ locked: boolean }>(tx, 'select attendance_is_locked($1, $2) as locked', [e.id, input.workDate]))!.locked) {
        throw Errors.conflict('period_locked', 'This date is in a period locked for payroll.');
      }
      const times = input.punches.map((p) => fromLocal(input.workDate, hhmm(p.time) + (p.nextDay ? 1440 : 0), e.tz));
      if (times.some((t) => t > Date.now())) throw Errors.badRequest('future_time', 'A corrected punch cannot be in the future.');
      const row = (await one<{ id: string }>(
        tx,
        `insert into attendance_corrections (tenant_id, employee_id, work_date, punches, reason, requested_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5) returning id`,
        [e.id, input.workDate, JSON.stringify(input.punches), input.reason, actor.membershipId],
      ).catch((err: { code?: string }) => {
        if (err.code === '23505') throw Errors.conflict('correction_pending', 'There is already a pending correction for this day.');
        throw err;
      }))!;
      const summary = `${e.name}: add ${input.punches.map((p) => `${p.direction} ${p.time}${p.nextDay ? ' (next day)' : ''}`).join(', ')} on ${input.workDate}. "${input.reason}"`;
      const approvalId = await this.approvals.start(tx, { resourceType: 'attendance_correction', resourceId: row.id, subjectEmployeeId: e.id, summary });
      await tx.query('update attendance_corrections set approval_request_id = $2 where id = $1', [row.id, approvalId]);
      await this.audit.record(tx, { action: 'attendance_correction.submitted', resourceType: 'attendance_correction', resourceId: row.id, changes: { employeeId: e.id, workDate: input.workDate, punches: input.punches }, metadata: { onBehalf } });
      return this.correction(tx, row.id);
    });
  }

  private correction(tx: Tx, id: string) {
    return one(tx, `select c.id, c.employee_id as "employeeId", c.work_date as "workDate", c.punches, c.reason, c.status, c.created_at as "createdAt", c.approval_request_id as "approvalId",
                           trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as "employeeName"
                      from attendance_corrections c join employees e on e.id = c.employee_id where c.id = $1`, [id]);
  }

  private async correctionApproved(tx: Tx, req: ApprovalRequestRow) {
    const c = await one<{ id: string; employee_id: string; work_date: string; punches: { time: string; direction: 'in' | 'out'; nextDay?: boolean }[]; requested_by_membership_id: string | null }>(
      tx, `select id, employee_id, work_date, punches, requested_by_membership_id from attendance_corrections where id = $1 and status = 'pending' for update`, [req.resource_id],
    );
    if (!c) return;
    const e = (await this.days.employee(tx, c.employee_id))!;
    if ((await one<{ locked: boolean }>(tx, 'select attendance_is_locked($1, $2) as locked', [e.id, c.work_date]))!.locked) {
      throw Errors.conflict('period_locked', 'This date was locked for payroll after the correction was requested. Unlock the period first.');
    }
    await tx.query(`update attendance_corrections set status = 'approved', decided_at = now() where id = $1`, [c.id]);
    for (const [i, p] of c.punches.entries()) {
      // Corrections add punches; the original record stays as it was.
      await tx.query(
        `insert into attendance_events (tenant_id, employee_id, source, source_event_id, captured_at, direction, correction_id, recorded_by_membership_id, note)
         values (app_tenant_id(), $1, 'correction', $2, $3, $4, $5, $6, 'Approved correction')`,
        [e.id, `${c.id}:${i}`, new Date(fromLocal(c.work_date, hhmm(p.time) + (p.nextDay ? 1440 : 0), e.tz)), p.direction, c.id, c.requested_by_membership_id],
      );
    }
    await this.days.recompute(tx, e.id, addDays(c.work_date, -1), addDays(c.work_date, 1) > localToday(e.tz) ? c.work_date : addDays(c.work_date, 1));
    await this.audit.record(tx, { action: 'attendance_correction.approved', resourceType: 'attendance_correction', resourceId: c.id, metadata: { workDate: c.work_date, punches: c.punches.length } });
  }

  async listCorrections(q: { scope: 'mine' | 'visible'; status?: string }) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.scope === 'mine') {
        params.push((await this.me(tx)).id);
        where.push(`c.employee_id = $1`);
      } else where.push(await this.authz.predicate('attendance:read', EMPLOYEE_SCOPE, params, tx));
      if (q.status) { params.push(q.status); where.push(`c.status = $${params.length}`); }
      return many(tx, `select c.id, c.employee_id as "employeeId", c.work_date as "workDate", c.punches, c.reason, c.status, c.created_at as "createdAt",
                              trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as "employeeName"
                         from attendance_corrections c join employees e on e.id = c.employee_id where ${where.join(' and ')} order by c.created_at desc limit 200`, params);
    });
  }

  async cancelCorrection(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const c = await one<{ status: string; employee_id: string; approval_request_id: string | null; requested_by_membership_id: string | null }>(tx, 'select status, employee_id, approval_request_id, requested_by_membership_id from attendance_corrections where id = $1 for update', [id]);
      if (!c) throw Errors.notFound('Correction');
      const e = (await this.days.employee(tx, c.employee_id))!;
      if (c.requested_by_membership_id !== actor.membershipId && e.membership_id !== actor.membershipId) {
        await this.authz.require('attendance:read', attrsOf(e), tx);
        throw Errors.forbidden('Only the person who asked for this correction can withdraw it');
      }
      if (c.status !== 'pending') throw Errors.conflict('invalid_state', `This correction is already ${c.status}`);
      await tx.query(`update attendance_corrections set status = 'cancelled', decided_at = now() where id = $1`, [id]);
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
      if ((await one<{ locked: boolean }>(tx, 'select attendance_is_locked($1, $2) as locked', [e.id, input.workDate]))!.locked) throw Errors.conflict('period_locked', 'This date is in a period locked for payroll.');
      await this.days.recompute(tx, e.id, input.workDate, input.workDate);
      const day = await one<{ overtime_minutes: number; status: string }>(tx, 'select overtime_minutes, status from attendance_days where employee_id = $1 and work_date = $2', [e.id, input.workDate]);
      if (!day || day.overtime_minutes <= 0) throw Errors.badRequest('no_overtime', 'No overtime was recorded on this day.');
      if (input.minutes > day.overtime_minutes) throw Errors.badRequest('too_many_minutes', `At most ${day.overtime_minutes} minutes of overtime were recorded on this day.`);
      const row = (await one<{ id: string }>(
        tx,
        `insert into overtime_claims (tenant_id, employee_id, work_date, minutes, computed_minutes, reason, requested_by_membership_id) values (app_tenant_id(), $1, $2, $3, $4, $5, $6) returning id`,
        [e.id, input.workDate, input.minutes, day.overtime_minutes, input.reason ?? null, actor.membershipId],
      ).catch((err: { code?: string }) => {
        if (err.code === '23505') throw Errors.conflict('claim_exists', 'There is already a pending or approved overtime claim for this day.');
        throw err;
      }))!;
      const approvalId = await this.approvals.start(tx, {
        resourceType: 'overtime_claim', resourceId: row.id, subjectEmployeeId: e.id,
        summary: `${e.name}: ${input.minutes} minutes of overtime on ${input.workDate}${input.reason ? `. "${input.reason}"` : ''}`,
      });
      await tx.query('update overtime_claims set approval_request_id = $2 where id = $1', [row.id, approvalId]);
      await this.audit.record(tx, { action: 'overtime_claim.submitted', resourceType: 'overtime_claim', resourceId: row.id, changes: { employeeId: e.id, workDate: input.workDate, minutes: input.minutes }, metadata: { onBehalf } });
      return one(tx, `select id, employee_id as "employeeId", work_date as "workDate", minutes, computed_minutes as "computedMinutes", status, reason from overtime_claims where id = $1`, [row.id]);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Policies, locks, recompute
  // ---------------------------------------------------------------------------------------------------------

  listPolicies() {
    return this.db.tenant((tx) =>
      many(tx, `select p.id, p.location_id as "locationId", l.name as "locationName", p.web_punch as "webPunch", p.mobile_punch as "mobilePunch", p.qr_punch as "qrPunch",
                       p.geofence_mode as "geofenceMode", p.default_shift_id as "defaultShiftId", s.name as "defaultShiftName", p.overtime_requires_approval as "overtimeRequiresApproval",
                       p.early_window_minutes as "earlyWindowMinutes", p.correction_window_days as "correctionWindowDays"
                  from attendance_policies p left join locations l on l.id = p.location_id left join shift_templates s on s.id = p.default_shift_id
                 order by p.location_id nulls first, l.name`),
    );
  }

  async savePolicy(input: AttendancePolicyInput) {
    return this.db.tenant(async (tx) => {
      if (input.locationId && !(await one(tx, 'select 1 from locations where id = $1', [input.locationId]))) throw Errors.badRequest('invalid_location', 'Location not found');
      if (input.defaultShiftId && !(await one(tx, 'select 1 from shift_templates where id = $1 and archived_at is null', [input.defaultShiftId]))) throw Errors.badRequest('invalid_shift', 'Shift not found');
      const before = await one(tx, `select * from attendance_policies where location_id is not distinct from $1`, [input.locationId]);
      const values = [input.webPunch, input.mobilePunch, input.qrPunch, input.geofenceMode, input.defaultShiftId, input.overtimeRequiresApproval, input.earlyWindowMinutes, input.correctionWindowDays];
      if (before) {
        await tx.query(
          `update attendance_policies set web_punch = $2, mobile_punch = $3, qr_punch = $4, geofence_mode = $5, default_shift_id = $6, overtime_requires_approval = $7,
                  early_window_minutes = $8, correction_window_days = $9 where location_id is not distinct from $1`,
          [input.locationId, ...values],
        );
      } else {
        await tx.query(
          `insert into attendance_policies (tenant_id, location_id, web_punch, mobile_punch, qr_punch, geofence_mode, default_shift_id, overtime_requires_approval, early_window_minutes, correction_window_days)
           values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [input.locationId, ...values],
        );
      }
      await this.audit.record(tx, { action: before ? 'attendance_policy.updated' : 'attendance_policy.created', resourceType: 'attendance_policy', resourceId: input.locationId ?? 'default', changes: input });
      return input;
    });
  }

  async removePolicy(locationId: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.query('delete from attendance_policies where location_id = $1', [locationId]);
      if (!r.rowCount) throw Errors.notFound('Location policy');
      await this.audit.record(tx, { action: 'attendance_policy.removed', resourceType: 'attendance_policy', resourceId: locationId });
    });
  }

  listLocks() {
    return this.db.tenant((tx) =>
      many(tx, `select p.id, p.legal_entity_id as "legalEntityId", le.name as "legalEntityName", p.period_start as "periodStart", p.period_end as "periodEnd", p.note,
                       p.locked_at as "lockedAt", lu.full_name as "lockedBy", p.unlocked_at as "unlockedAt", uu.full_name as "unlockedBy", p.unlock_reason as "unlockReason"
                  from attendance_periods p left join legal_entities le on le.id = p.legal_entity_id
                  left join users lu on lu.id = p.locked_by left join users uu on uu.id = p.unlocked_by
                 order by p.period_start desc, p.locked_at desc limit 100`),
    );
  }

  async lock(input: z.infer<typeof periodLockInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const row = (await one<{ id: string }>(
        tx,
        `insert into attendance_periods (tenant_id, legal_entity_id, period_start, period_end, note, locked_by) values (app_tenant_id(), $1, $2, $3, $4, $5) returning id`,
        [input.legalEntityId, input.periodStart, input.periodEnd, input.note ?? null, actor.userId],
      ).catch((err: { code?: string }) => {
        if (err.code === '23P01') throw Errors.conflict('already_locked', 'Part of this period is already locked.');
        if (err.code === '23503') throw Errors.badRequest('invalid_legal_entity', 'Legal entity not found');
        throw err;
      }))!;
      const pending = await one<{ n: number }>(
        tx, `select count(*)::int as n from attendance_corrections c join employees e on e.id = c.employee_id where c.status = 'pending' and c.work_date between $1 and $2 and ($3::uuid is null or e.current_legal_entity_id = $3)`,
        [input.periodStart, input.periodEnd, input.legalEntityId],
      );
      await this.audit.record(tx, { action: 'attendance_period.locked', resourceType: 'attendance_period', resourceId: row.id, changes: input, metadata: { pendingCorrections: pending!.n } });
      return { id: row.id, ...input, pendingCorrections: pending!.n };
    });
  }

  async unlock(id: string, reason: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.query('update attendance_periods set unlocked_at = now(), unlocked_by = $2, unlock_reason = $3 where id = $1 and unlocked_at is null', [id, actor.userId, reason]);
      if (!r.rowCount) throw Errors.notFound('Locked period');
      await this.audit.record(tx, { action: 'attendance_period.unlocked', resourceType: 'attendance_period', resourceId: id, metadata: { reason } });
    });
  }

  /** Recomputes days, for one employee or everyone the caller can configure, in a range of up to 62 days. */
  async recomputeRange(q: { employeeId?: string; from: string; to: string }) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [q.to, q.from];
      const where = [await this.authz.predicate('attendance:configure', EMPLOYEE_SCOPE, params, tx), 'e.date_of_joining <= $1', '(e.last_working_day is null or e.last_working_day >= $2)'];
      if (q.employeeId) { params.push(q.employeeId); where.push(`e.id = $${params.length}`); }
      const people = await many<{ id: string }>(tx, `select e.id from employees e where ${where.join(' and ')}`, params);
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
      const people = await many<{ id: string }>(
        tx, `select id from employees where status <> 'pre_boarding' and date_of_joining <= current_date + 1 and (last_working_day is null or last_working_day >= current_date - $1::int)`, [days + 1],
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
  async recomputeFor(tx: Tx, employeeId: string, from: string, to: string) {
    const e = await this.days.employee(tx, employeeId);
    if (!e) return;
    const today = localToday(e.tz);
    const end = to > today ? today : to;
    if (from <= end) await this.days.recompute(tx, employeeId, from < e.date_of_joining ? e.date_of_joining : from, end);
  }
}
