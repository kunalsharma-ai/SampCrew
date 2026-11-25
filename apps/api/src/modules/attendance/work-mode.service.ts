import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  ATTENDANCE_NOTICES,
  DEFAULT_WORK_MODE_LABELS,
  DEFAULT_WORK_MODE_SETTINGS,
  classifyWorkMode,
  resolveZone,
  workModeLabel,
  zonedTime,
  type AttendanceNoticeKey,
  type LocationStatus,
  type ModeCheckpoint,
  type ModePunch,
  type OfficeRequirement,
  type PunchZone,
  type WorkAssignmentInput,
  type WorkModeLabels,
  type WorkModeSettingsInput,
  type WorkModeState,
  type WorkPlace,
  type WorkSiteInput,
  type ZoneResult,
} from '@crew/contracts';
import type { z } from 'zod';
import type { newOfficeInput, officeGeofenceInput, workModeCheckpointInput, workModeOverrideInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { employeeAttrs } from '../employees/employee-attrs';
import { displayName, fieldById } from '../employees/employee-view';
import { OrganizationService } from '../organization/organization.service';
import { AttendanceAccessService } from './attendance-access.service';
import { AttendanceDaysService, type DayPunch, type EmployeeCtx } from './attendance-days.service';

const { localToday, toLocal } = zonedTime;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

export interface WorkModeSettings {
  enabled: boolean;
  labels: WorkModeLabels;
  minOfficeMinutes: number;
  minRemoteMinutes: number;
  transition: WorkModeSettingsInput['transition'];
  maxAccuracyM: number;
  otherOffices: WorkModeSettingsInput['otherOffices'];
  officeRequirement: OfficeRequirement;
  locationRetentionDays: number;
  employeeCanRequestCorrection: boolean;
  standardHours: number;
  classifyFrom: string;
  updatedAt: Date | null;
}

/** What a live punch needs to know about where it was, worked out before it is stored. */
export interface PunchPlace {
  enabled: boolean;
  zone: ZoneResult;
  requirement: OfficeRequirement;
  fix: { lat: number; lon: number; accuracyM: number | null } | null;
}

const attrsOf = (e: EmployeeCtx) =>
  employeeAttrs({ id: e.id, membershipId: e.membership_id, legalEntityId: e.legal_entity_id, departmentId: e.department_id, locationId: e.location_id });

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Legacy punches (before classification) and punches with no location by nature, mapped to a zone. */
export function zoneOfPunch(p: DayPunch): { zone: PunchZone; place: string | null } {
  if (p.work_zone) return { zone: p.work_zone, place: p.work_place_name };
  if (p.source === 'device' || p.source === 'qr' || p.geofence_result === 'kiosk') return { zone: 'office', place: p.device_name };
  if (p.source === 'correction' || p.source === 'import') return { zone: 'neutral', place: null };
  if (p.geofence_result === 'inside') return { zone: 'office', place: null };
  if (p.geofence_result === 'outside') return { zone: 'remote', place: null };
  return { zone: 'unverified', place: null };
}

/**
 * Office / home / hybrid attendance: the company's rules and labels, office geofences and approved sites, who may use
 * which, where each punch was, the classification of each day (run inside every day recompute), HR's verification
 * and corrections with their history, location updates, notices and the retention of coordinates.
 */
@Injectable()
export class WorkModeService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly days: AttendanceDaysService,
    private readonly access: AttendanceAccessService,
    private readonly org: OrganizationService,
  ) {}

  onModuleInit() {
    this.days.setClassifier((tx, e, d) => this.classify(tx, e, d));
  }

  // ---------------------------------------------------------------------------------------------------------- settings

  async settings(tx: TenantTx): Promise<WorkModeSettings> {
    let row = await tx.collection('work_mode_settings').findOne({});
    if (!row) {
      // A company created after the migration: its settings start with the defaults, classifying from today.
      const tenant = await tx.collection('tenants').findOne({});
      row = await tx.collection('work_mode_settings').insert({ classify_from: localToday((tenant?.timezone as string) ?? 'UTC') }).catch(async () => tx.collection('work_mode_settings').findOne({}));
    }
    const labels = { ...DEFAULT_WORK_MODE_LABELS, ...((row?.labels as Partial<WorkModeLabels>) ?? {}) };
    return {
      enabled: row?.enabled ?? true,
      labels,
      minOfficeMinutes: row?.min_office_minutes ?? DEFAULT_WORK_MODE_SETTINGS.minOfficeMinutes,
      minRemoteMinutes: row?.min_remote_minutes ?? DEFAULT_WORK_MODE_SETTINGS.minRemoteMinutes,
      transition: row?.transition ?? 'split',
      maxAccuracyM: row?.max_accuracy_m ?? DEFAULT_WORK_MODE_SETTINGS.maxAccuracyM,
      otherOffices: row?.other_offices ?? 'office',
      officeRequirement: row?.office_requirement ?? 'none',
      locationRetentionDays: row?.location_retention_days ?? DEFAULT_WORK_MODE_SETTINGS.locationRetentionDays,
      employeeCanRequestCorrection: row?.employee_can_request_correction ?? true,
      standardHours: (row?.standard_minutes ?? 480) / 60,
      classifyFrom: row?.classify_from ?? '1970-01-01',
      updatedAt: row?.updated_at ?? null,
    };
  }

  /** The settings page: rules, labels and who may change what. */
  settingsView() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:read', undefined, tx);
      const v = await this.access.viewer(tx);
      const s = await this.settings(tx);
      const canConfigure = await this.authz.require('attendance:configure', undefined, tx).then(() => true, () => false);
      return { settings: s, defaults: DEFAULT_WORK_MODE_SETTINGS, canConfigure, canRename: canConfigure && v.level === 'super' };
    });
  }

  saveSettings(input: WorkModeSettingsInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:configure', undefined, tx);
      const v = await this.access.viewer(tx);
      const before = await this.settings(tx);
      if (input.labels && v.level !== 'super') {
        const same = (Object.keys(input.labels) as (keyof WorkModeLabels)[]).every((k) => input.labels![k] === before.labels[k]);
        if (!same) throw Errors.forbidden('Only the Super Workspace can rename office, home and hybrid attendance');
      }
      const set: Doc = {
        enabled: input.enabled,
        min_office_minutes: input.minOfficeMinutes,
        min_remote_minutes: input.minRemoteMinutes,
        transition: input.transition,
        max_accuracy_m: input.maxAccuracyM,
        other_offices: input.otherOffices,
        office_requirement: input.officeRequirement,
        location_retention_days: input.locationRetentionDays,
        employee_can_request_correction: input.employeeCanRequestCorrection,
        standard_minutes: Math.round(input.standardHours * 60),
        updated_by_membership_id: v.membershipId,
      };
      if (input.labels && v.level === 'super') set.labels = input.labels;
      await tx.collection('work_mode_settings').updateOne({}, { $set: set });
      // Switched on again: classify from today, so days in between stay as they were.
      if (input.enabled && !before.enabled) {
        const tenant = await tx.collection('tenants').findOne({});
        await tx.collection('work_mode_settings').updateOne({}, { $set: { classify_from: localToday((tenant?.timezone as string) ?? 'UTC') } });
      }
      const after = await this.settings(tx);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of Object.keys(after) as (keyof WorkModeSettings)[]) {
        if (k === 'updatedAt') continue;
        if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changes[k] = { from: before[k], to: after[k] };
      }
      if (Object.keys(changes).length) await this.audit.record(tx, { action: 'work_mode.settings_updated', resourceType: 'work_mode_settings', resourceId: 'company', changes });
      return after;
    });
  }

  labels() {
    return this.db.tenant(async (tx) => (await this.settings(tx)).labels);
  }

  // ---------------------------------------------------------------------------------------------------------- places

  /** Office geofences: company locations with a position and a radius, not archived and switched on for attendance. */
  private async offices(tx: TenantTx) {
    const rows = await tx.collection('locations').find({ archived_at: null, latitude: { $ne: null }, geofence_radius_m: { $ne: null } });
    return rows.filter((l) => l.geofence_active !== false);
  }

  private async assignment(tx: TenantTx, employeeId: string) {
    return tx.collection('work_assignments').findOne({ employee_id: employeeId });
  }

  /** Every office and approved site a person's punches are checked against. */
  async placesFor(tx: TenantTx, e: EmployeeCtx, s?: WorkModeSettings): Promise<WorkPlace[]> {
    const settings = s ?? (await this.settings(tx));
    const a = await this.assignment(tx, e.id);
    const own = new Set<string>([...(e.location_id ? [e.location_id] : []), ...((a?.office_ids as string[]) ?? [])]);
    const offices = (await this.offices(tx)).map((l): WorkPlace => ({
      id: l.id, name: l.name, kind: 'office', lat: Number(l.latitude), lon: Number(l.longitude), radiusM: l.geofence_radius_m,
      countsAs: own.has(l.id) || settings.otherOffices === 'office' ? 'office' : 'remote',
    }));
    const siteIds = new Set<string>((a?.site_ids as string[]) ?? []);
    const sites = (await tx.collection('work_sites').find({ archived_at: null, active: true }))
      .filter((x) => x.everyone || siteIds.has(x.id))
      .map((x): WorkPlace => ({ id: x.id, name: x.name, kind: 'site', lat: Number(x.latitude), lon: Number(x.longitude), radiusM: x.radius_m, countsAs: x.counts_as }));
    return [...offices, ...sites];
  }

  async requirementFor(tx: TenantTx, e: EmployeeCtx, s?: WorkModeSettings): Promise<OfficeRequirement> {
    const a = await this.assignment(tx, e.id);
    return (a?.office_requirement as OfficeRequirement | null) ?? (s ?? (await this.settings(tx))).officeRequirement;
  }

  /** Where a live web or phone punch was. */
  async punchPlace(tx: TenantTx, e: EmployeeCtx, fix: { latitude?: number; longitude?: number; accuracyM?: number; mockLocation?: boolean; locationStatus?: LocationStatus }): Promise<PunchPlace> {
    const s = await this.settings(tx);
    const has = fix.latitude !== undefined && fix.longitude !== undefined;
    const reading = has ? { lat: fix.latitude!, lon: fix.longitude!, accuracyM: fix.accuracyM ?? null, mock: fix.mockLocation === true } : null;
    if (!s.enabled) return { enabled: false, zone: { zone: 'unverified', verification: 'not_needed', place: null, distanceM: null }, requirement: 'none', fix: null };
    const zone = resolveZone(reading, await this.placesFor(tx, e, s), { maxAccuracyM: s.maxAccuracyM, status: fix.locationStatus });
    return { enabled: true, zone, requirement: await this.requirementFor(tx, e, s), fix: reading ? { lat: reading.lat, lon: reading.lon, accuracyM: reading.accuracyM } : null };
  }

  /** A kiosk or QR punch: at the kiosk's location. */
  async kioskPlace(tx: TenantTx, locationId: string): Promise<PunchPlace> {
    const s = await this.settings(tx);
    const l = await tx.collection('locations').findOne({ id: locationId });
    return { enabled: s.enabled, zone: { zone: 'office', verification: 'device', place: l ? { id: l.id, name: l.name, kind: 'office' } : null, distanceM: null }, requirement: 'none', fix: null };
  }

  /** Refuses a check-in (or check-out) that must be at an office but is not. */
  requireOffice(p: PunchPlace, direction: 'in' | 'out') {
    if (!p.enabled || p.requirement === 'none') return;
    if (direction === 'out' && p.requirement !== 'check_in_out') return;
    if (p.zone.zone === 'office') return;
    const what = direction === 'in' ? 'Check-in' : 'Check-out';
    if (p.zone.zone === 'unverified') throw Errors.forbiddenCode('office_location_required', `${what} must be at an office, and your location could not be verified (${p.zone.verification.replace(/_/g, ' ')}). Allow location access and try again, or ask HR for a correction.`);
    throw Errors.forbiddenCode('office_required', `${what} must be at one of your offices${p.zone.distanceM !== null ? `; you are about ${p.zone.distanceM} m from the nearest one` : ''}. Ask HR for a correction if you are working elsewhere today.`);
  }

  /** The event fields for a punch's place (attendance_events is append-only, so they are set once, here). */
  eventFields(p: PunchPlace): Doc {
    if (!p.enabled) return {};
    return {
      work_zone: p.zone.zone,
      location_verification: p.zone.verification,
      work_place_id: p.zone.place?.id ?? null,
      work_place_name: p.zone.place?.name ?? null,
      work_place_kind: p.zone.place?.kind ?? null,
    };
  }

  /**
   * After a live punch is stored: keeps the coordinates apart (with the retention period), tells the person what
   * happened (if they want to know) and refreshes open dashboards.
   */
  async afterPunch(tx: TenantTx, e: EmployeeCtx, ev: { id: string; captured_at: Date; direction: string; source: 'web' | 'mobile' | 'qr' }, p: PunchPlace) {
    if (!p.enabled) return;
    await tx.collection('attendance_locations').insert({
      employee_id: e.id, event_id: ev.id, kind: 'punch', source: ev.source, captured_at: ev.captured_at,
      latitude: p.fix?.lat ?? null, longitude: p.fix?.lon ?? null, accuracy_m: p.fix?.accuracyM ?? null,
      zone: p.zone.zone, verification: p.zone.verification, distance_m: p.zone.distanceM,
      place_id: p.zone.place?.id ?? null, place_name: p.zone.place?.name ?? null, place_kind: p.zone.place?.kind ?? null,
    });
    if (e.membership_id) {
      const prefs = await this.noticePrefs(tx, e.membership_id);
      const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: e.tz }).format(ev.captured_at);
      const where = p.zone.place?.name ?? (p.zone.zone === 'remote' ? 'away from the office' : p.zone.zone === 'unverified' ? 'location not verified' : 'office');
      const key: AttendanceNoticeKey = ev.direction === 'in' ? 'check_in' : 'check_out';
      if (prefs[key]) {
        await this.notifications.notify(tx, {
          membershipIds: [e.membership_id], kind: `attendance.${key}`, includeActor: true, priority: 'low',
          title: `${ev.direction === 'in' ? 'Check-in' : 'Check-out'} recorded at ${time}`, body: where, link: '/attendance',
        });
      }
      if (p.zone.zone === 'unverified' && prefs.verification_failed) {
        await this.notifications.notify(tx, {
          membershipIds: [e.membership_id], kind: 'attendance.location_unverified', includeActor: true,
          title: 'Your location could not be verified',
          body: `Your ${ev.direction === 'in' ? 'check-in' : 'check-out'} at ${time} is recorded, and HR will review where you worked today. It is not counted as home.`,
          link: '/attendance', dedupeKey: `location-unverified:${e.id}:${localToday(e.tz)}`,
        });
      }
    }
    await this.signalDashboards(tx, e);
  }

  /** Open attendance pages (the person's own and the dashboards of Super and HR Workspace) refresh themselves. */
  async signalDashboards(tx: TenantTx, e: EmployeeCtx) {
    const v = await this.access.levelMemberships(tx);
    await this.notifications.signal(tx, [e.membership_id, ...v.superMemberships, ...v.hrMemberships], 'attendance.changed', { employeeId: e.id });
  }

  // ---------------------------------------------------------------------------------------------------------- classification

  /** Runs inside each day recompute (AttendanceDaysService), before the day is stored. */
  private async classify(tx: TenantTx, e: EmployeeCtx, d: Parameters<Parameters<AttendanceDaysService['setClassifier']>[0]>[2]): Promise<Doc> {
    const s = await this.settings(tx);
    if (!s.enabled || d.workDate < s.classifyFrom) return {};
    const stored = await tx.collection('attendance_days').findOne({ employee_id: e.id, work_date: d.workDate }, { projection: { work_mode: 1, work_mode_override: 1, work_mode_provisional: 1 } });
    const a = await this.assignment(tx, e.id);
    const punches: ModePunch[] = d.punches.map((p) => {
      const z = zoneOfPunch(p);
      return { at: p.captured_at.getTime(), direction: p.direction, zone: z.zone, place: z.place };
    });
    const checkpoints: ModeCheckpoint[] = (await tx.collection('attendance_locations').find(
      { employee_id: e.id, kind: 'checkpoint', captured_at: { $gte: new Date(d.window.from), $lt: new Date(d.window.to) } },
      { sort: { captured_at: 1 } },
    )).map((c) => ({ at: (c.captured_at as Date).getTime(), zone: c.zone === 'neutral' ? 'unverified' : c.zone, place: c.place_name ?? null }));
    const r = classifyWorkMode({
      timeZone: e.tz, punches, checkpoints, now: d.now, dayOpen: d.result.status === 'in_progress',
      approvedRemote: d.remote,
      rules: {
        minOfficeMinutes: (a?.min_office_minutes as number | null) ?? s.minOfficeMinutes,
        minRemoteMinutes: (a?.min_remote_minutes as number | null) ?? s.minRemoteMinutes,
        transition: s.transition,
      },
    });
    const override = (stored?.work_mode_override as Doc | null) ?? null;
    const state: WorkModeState | null = override?.mode ?? r.state;
    const ends = (which: 'first' | 'last') => {
      const p = which === 'first' ? d.punches.find((x) => x.direction !== 'out') : [...d.punches].reverse().find((x) => x.direction === 'out');
      if (!p) return null;
      const z = zoneOfPunch(p);
      return { at: p.captured_at, zone: z.zone, place: z.place, verification: p.location_verification ?? (z.zone === 'office' && (p.source === 'device' || p.source === 'qr') ? 'device' : null), source: p.source };
    };
    const detail = { checkIn: ends('first'), checkOut: d.result.lastOut ? ends('last') : null, transitions: r.transitions.map((t) => ({ ...t, at: new Date(t.at).toISOString() })) };
    const previous = (stored?.work_mode as WorkModeState | null | undefined) ?? null;
    if (previous !== state && !(previous === null && r.provisional && !override)) {
      await tx.collection('work_mode_changes').insert({ employee_id: e.id, work_date: d.workDate, from_mode: previous, to_mode: state, by: 'system', reason: r.explanation.slice(-2).join(' ') || null });
    }
    if (previous !== state && e.membership_id && state) await this.modeNotices(tx, e, d.workDate, previous, state, s.labels, r.provisional);
    return {
      work_mode: state,
      work_mode_auto: r.state,
      work_mode_guess: r.guess,
      work_mode_provisional: r.provisional,
      office_minutes: r.officeMinutes,
      remote_minutes: r.remoteMinutes,
      unverified_minutes: r.unverifiedMinutes,
      work_mode_places: r.places,
      work_mode_issues: r.issues,
      work_mode_explanation: r.explanation,
      work_mode_detail: detail,
    };
  }

  private async modeNotices(tx: TenantTx, e: EmployeeCtx, date: string, from: WorkModeState | null, to: WorkModeState, labels: WorkModeLabels, provisional: boolean) {
    const prefs = await this.noticePrefs(tx, e.membership_id!);
    if (from && prefs.mode_changed) {
      await this.notifications.notify(tx, {
        membershipIds: [e.membership_id], kind: 'attendance.work_mode_changed', includeActor: true,
        title: `${date === localToday(e.tz) ? 'Today' : date} is now ${workModeLabel(to, labels)}`,
        body: `It was ${workModeLabel(from, labels)}.${provisional ? ' This can still change when you check out.' : ''}`,
        link: '/attendance', dedupeKey: `work-mode:${e.id}:${date}`,
      });
    }
    if (to === 'pending_verification' && from !== 'pending_verification') {
      // Super Workspace and HR Workspace people who asked to hear about days waiting for verification.
      const v = await this.access.levelMemberships(tx);
      const emp = await tx.collection('employees').findOne({ id: e.id }, { projection: { hr_workspace_id: 1 } });
      const group = (emp?.hr_workspace_id as string | null) ?? 'central';
      const hr = [...(v.adminsByGroup.get(group) ?? []), ...(v.adminsByGroup.get('central') ?? [])];
      const candidates = [...new Set([...v.superMemberships, ...hr])].filter((m) => m !== e.membership_id);
      const want: string[] = [];
      for (const m of candidates) if ((await this.noticePrefs(tx, m)).team_pending) want.push(m);
      if (want.length) {
        await this.notifications.notify(tx, {
          membershipIds: want, kind: 'attendance.verification_needed', title: `${e.name}: location to verify for ${date}`,
          body: 'A check-in or check-out location could not be verified. Review it in the attendance register.',
          link: `/attendance/work-mode/register?category=pending&employeeId=${e.id}`, dedupeKey: `verify:${e.id}:${date}`, action: true,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------- one day

  /** The work arrangement part of /attendance/today for the person themselves. */
  async todayBlock(tx: TenantTx, e: EmployeeCtx, date: string, punches: DayPunch[]) {
    const s = await this.settings(tx);
    const d = await tx.collection('attendance_days').findOne({ employee_id: e.id, work_date: date });
    const last = punches.at(-1);
    const lastZone = last ? zoneOfPunch(last) : null;
    const lastCheckpoint = await tx.collection('attendance_locations').findOne({ employee_id: e.id, kind: 'checkpoint', captured_at: { $gte: punches[0]?.captured_at ?? new Date() } }, { sort: { captured_at: -1 } });
    const useCheckpoint = lastCheckpoint && last && (lastCheckpoint.captured_at as Date) > last.captured_at;
    return {
      enabled: s.enabled,
      labels: s.labels,
      state: (d?.work_mode as WorkModeState | null) ?? null,
      guess: (d?.work_mode_guess as string | null) ?? null,
      provisional: Boolean(d?.work_mode_provisional),
      officeMinutes: (d?.office_minutes as number) ?? 0,
      remoteMinutes: (d?.remote_minutes as number) ?? 0,
      unverifiedMinutes: (d?.unverified_minutes as number) ?? 0,
      places: (d?.work_mode_places as string[]) ?? [],
      issues: (d?.work_mode_issues as string[]) ?? [],
      explanation: (d?.work_mode_explanation as string[]) ?? [],
      override: d?.work_mode_override ?? null,
      current: useCheckpoint
        ? { zone: lastCheckpoint.zone, place: lastCheckpoint.place_name ?? null, at: lastCheckpoint.captured_at, verification: lastCheckpoint.verification }
        : last && lastZone ? { zone: lastZone.zone, place: lastZone.place, at: last.captured_at, verification: last.location_verification } : null,
      requirement: await this.requirementFor(tx, e, s),
      offices: (await this.placesFor(tx, e, s)).filter((p) => p.countsAs === 'office').map((p) => ({ name: p.name, kind: p.kind, radiusM: p.radiusM })),
      canRequestCorrection: s.employeeCanRequestCorrection,
    };
  }

  /** A location update while checked in (the person presses it; nothing is recorded on its own). */
  checkpoint(input: z.infer<typeof workModeCheckpointInput>) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!s.employeeId) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet.');
      const e = (await this.days.employee(tx, s.employeeId))!;
      await this.authz.require('attendance:punch', attrsOf(e), tx);
      const now = Date.now();
      const date = await this.days.workDateAt(tx, e, now);
      const win = await this.days.window(tx, e, date);
      const last = (await this.days.punches(tx, e.id, win.from, now + 1)).at(-1);
      if (!last || last.direction === 'out') throw Errors.conflict('not_checked_in', 'Check in first. A location update is only for while you are working.');
      const place = await this.punchPlace(tx, e, input);
      if (!place.enabled) throw Errors.conflict('work_mode_off', 'Office and home attendance is switched off for your company.');
      await tx.collection('attendance_locations').insert({
        employee_id: e.id, event_id: null, kind: 'checkpoint', source: 'web', captured_at: new Date(now),
        latitude: place.fix?.lat ?? null, longitude: place.fix?.lon ?? null, accuracy_m: place.fix?.accuracyM ?? null,
        zone: place.zone.zone, verification: place.zone.verification, distance_m: place.zone.distanceM,
        place_id: place.zone.place?.id ?? null, place_name: place.zone.place?.name ?? null, place_kind: place.zone.place?.kind ?? null,
      });
      await this.days.recompute(tx, e.id, date, date, now);
      await this.audit.record(tx, { action: 'work_mode.location_updated', resourceType: 'employee', resourceId: e.id, metadata: { zone: place.zone.zone, place: place.zone.place?.name ?? null, verification: place.zone.verification } });
      await this.signalDashboards(tx, e);
      return { zone: place.zone, today: await this.todayBlock(tx, e, date, await this.days.punches(tx, e.id, win.from, win.to)) };
    });
  }

  /** May the caller see raw coordinates of this person? Themselves, or attendance configuration rights over them. */
  private async seesCoordinates(tx: TenantTx, e: EmployeeCtx) {
    const s = await this.authz.subject(tx);
    if (s.employeeId === e.id) return true;
    return this.authz.require('attendance:configure', attrsOf(e), tx).then(() => true, () => false);
  }

  /** One day in full: classification, each punch's place, location updates and every change. */
  dayDetail(employeeId: string, date: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.days.employee(tx, employeeId);
      if (!e) throw Errors.notFound('Employee');
      const v = await this.access.viewer(tx);
      if (v.employeeId !== e.id && !(await tx.collection('employees').count({ $and: [await this.access.visibleFilter(tx, v), { id: e.id }] }))) throw Errors.notFound('Employee');
      const s = await this.settings(tx);
      const win = await this.days.window(tx, e, date);
      const coords = await this.seesCoordinates(tx, e);
      const locs = await tx.collection('attendance_locations').find({ employee_id: e.id, captured_at: { $gte: new Date(win.from), $lt: new Date(win.to) } }, { sort: { captured_at: 1 } });
      const byEvent = new Map(locs.filter((l) => l.event_id).map((l) => [l.event_id as string, l]));
      const punches = (await this.days.punches(tx, e.id, win.from, win.to)).map((p) => {
        const z = zoneOfPunch(p);
        const l = byEvent.get(p.id);
        return {
          id: p.id, at: p.captured_at, direction: p.direction, source: p.source, zone: z.zone, place: z.place, verification: p.location_verification,
          distanceM: (l?.distance_m as number | null) ?? null,
          location: coords && l && l.latitude !== null && l.latitude !== undefined ? { latitude: num(l.latitude), longitude: num(l.longitude), accuracyM: num(l.accuracy_m) } : null,
          locationRemoved: Boolean(l?.purged_at),
        };
      });
      const day = await tx.collection('attendance_days').findOne({ employee_id: e.id, work_date: date });
      const changes = await tx.collection('work_mode_changes').find({ employee_id: e.id, work_date: date }, { sort: { created_at: -1 }, limit: 100 });
      const canVerify = v.employeeId !== e.id && (await this.authz.require('attendance:approve', attrsOf(e), tx).then(() => true, () => false));
      return {
        employee: { id: e.id, name: e.name, code: e.code, timeZone: e.tz },
        date,
        labels: s.labels,
        classification: day ? {
          state: day.work_mode ?? null, auto: day.work_mode_auto ?? null, guess: day.work_mode_guess ?? null, provisional: Boolean(day.work_mode_provisional),
          officeMinutes: day.office_minutes ?? 0, remoteMinutes: day.remote_minutes ?? 0, unverifiedMinutes: day.unverified_minutes ?? 0, workedMinutes: day.worked_minutes ?? 0,
          places: day.work_mode_places ?? [], issues: day.work_mode_issues ?? [], explanation: day.work_mode_explanation ?? [], override: day.work_mode_override ?? null,
          status: day.status, detail: day.work_mode_detail ?? null,
        } : null,
        punches,
        checkpoints: locs.filter((l) => l.kind === 'checkpoint').map((l) => ({
          at: l.captured_at, zone: l.zone, place: l.place_name ?? null, verification: l.verification,
          location: coords && l.latitude !== null && l.latitude !== undefined ? { latitude: num(l.latitude), longitude: num(l.longitude), accuracyM: num(l.accuracy_m) } : null,
        })),
        changes: changes.map((c) => ({ at: c.created_at, from: c.from_mode ?? null, to: c.to_mode ?? null, by: c.by, byName: c.by_name ?? null, reason: c.reason ?? null })),
        canVerify,
      };
    });
  }

  /** HR verifies a day waiting for verification, or corrects any day's classification. Always with a reason. */
  override(input: z.infer<typeof workModeOverrideInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const e = await this.days.employee(tx, input.employeeId);
      if (!e) throw Errors.notFound('Employee');
      const s = await this.authz.subject(tx);
      if (s.employeeId === e.id) throw Errors.forbidden('You cannot verify or correct your own attendance. Ask HR.');
      await this.authz.require('attendance:read', attrsOf(e), tx);
      await this.authz.require('attendance:approve', attrsOf(e), tx);
      const day = await tx.collection('attendance_days').findOne({ employee_id: e.id, work_date: input.workDate });
      if (!day) throw Errors.notFound('Attendance day');
      const name = (await membershipUserNames(tx, [actor.membershipId])).get(actor.membershipId) ?? null;
      await this.applyOverride(tx, e, input.workDate, input.mode, input.reason, 'hr', actor.membershipId, name);
      return this.dayDetailIn(tx, e, input.workDate);
    });
  }

  private async dayDetailIn(tx: TenantTx, e: EmployeeCtx, date: string) {
    const d = await tx.collection('attendance_days').findOne({ employee_id: e.id, work_date: date });
    return { employeeId: e.id, date, state: d?.work_mode ?? null, auto: d?.work_mode_auto ?? null, override: d?.work_mode_override ?? null };
  }

  /** Sets (or with mode null removes) a day's classification correction and records it in the day's history. */
  async applyOverride(tx: TenantTx, e: EmployeeCtx, date: string, mode: 'office' | 'remote' | 'hybrid' | null, reason: string, by: 'hr' | 'correction', membershipId: string | null, byName: string | null) {
    const day = await tx.collection('attendance_days').findOne({ employee_id: e.id, work_date: date });
    const from = (day?.work_mode as WorkModeState | null) ?? null;
    const override = mode ? { mode, reason, byMembershipId: membershipId, byName, at: new Date().toISOString(), source: by } : null;
    const to: WorkModeState | null = mode ?? ((day?.work_mode_auto as WorkModeState | null) ?? null);
    if (day) await tx.collection('attendance_days').updateOne({ employee_id: e.id, work_date: date }, { $set: { work_mode_override: override, work_mode: to } });
    await tx.collection('work_mode_changes').insert({ employee_id: e.id, work_date: date, from_mode: from, to_mode: to, by, by_membership_id: membershipId, by_name: byName, reason });
    await this.audit.record(tx, {
      action: mode ? 'work_mode.corrected' : 'work_mode.correction_removed', resourceType: 'employee', resourceId: e.id,
      changes: { workMode: { from, to } }, metadata: { workDate: date, reason, source: by },
    });
    const labels = (await this.settings(tx)).labels;
    if (e.membership_id && from !== to && (await this.noticePrefs(tx, e.membership_id)).mode_changed) {
      await this.notifications.notify(tx, {
        membershipIds: [e.membership_id], kind: 'attendance.work_mode_corrected', includeActor: by === 'correction',
        title: `${date}: ${workModeLabel(to, labels)}`, body: `${by === 'hr' ? 'HR' : 'Your approved correction'} set this day to ${workModeLabel(to, labels)}. Reason: ${reason}`,
        link: `/attendance/day/${e.id}/${date}`,
      });
    }
    await this.signalDashboards(tx, e);
  }

  // ---------------------------------------------------------------------------------------------------------- offices and sites

  private async requireConfigure(tx: TenantTx) {
    await this.authz.require('attendance:configure', undefined, tx);
  }

  /** The Office locations page: offices (company locations), approved sites, who is assigned, legal entities. */
  places() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:read', undefined, tx);
      const canEdit = await this.requireConfigure(tx).then(() => true, () => false);
      const locations = await tx.collection('locations').find({ archived_at: null }, { sort: { name: 1 } });
      const sites = await tx.collection('work_sites').find({ archived_at: null }, { sort: { name: 1 } });
      const employees = await tx.collection('employees').find({ status: { $ne: 'exited' } }, { projection: { current_location_id: 1 } });
      const assignments = await tx.collection('work_assignments').find({});
      const home = new Map<string, number>();
      for (const e of employees) if (e.current_location_id) home.set(e.current_location_id, (home.get(e.current_location_id) ?? 0) + 1);
      const extra = new Map<string, number>();
      for (const a of assignments) for (const id of [...(a.office_ids ?? []), ...(a.site_ids ?? [])]) extra.set(id, (extra.get(id) ?? 0) + 1);
      const entities = await tx.collection('legal_entities').find({ archived_at: null }, { projection: { name: 1, timezone: 1, country_code: 1 } });
      const s = await this.settings(tx);
      return {
        canEdit,
        settings: { maxAccuracyM: s.maxAccuracyM, otherOffices: s.otherOffices, officeRequirement: s.officeRequirement, enabled: s.enabled },
        offices: locations.map((l) => ({
          id: l.id, name: l.name, kind: l.kind, city: l.city ?? null, addressLine: l.address_line ?? null, timezone: l.timezone,
          latitude: num(l.latitude), longitude: num(l.longitude), radiusM: l.geofence_radius_m ?? null,
          active: l.geofence_active !== false && l.latitude !== null && l.latitude !== undefined && !!l.geofence_radius_m,
          configured: l.latitude !== null && l.latitude !== undefined && !!l.geofence_radius_m,
          people: home.get(l.id) ?? 0, extraPeople: extra.get(l.id) ?? 0,
        })),
        sites: sites.map((x) => ({
          id: x.id, name: x.name, kind: x.kind, addressLine: x.address_line ?? null, latitude: num(x.latitude), longitude: num(x.longitude),
          radiusM: x.radius_m, countsAs: x.counts_as, everyone: Boolean(x.everyone), active: Boolean(x.active), people: extra.get(x.id) ?? 0,
        })),
        legalEntities: entities.map((x) => ({ id: x.id, name: x.name, timezone: x.timezone, countryCode: x.country_code })),
      };
    });
  }

  saveOfficeGeofence(id: string, input: z.infer<typeof officeGeofenceInput>) {
    return this.db.tenant(async (tx) => {
      await this.requireConfigure(tx);
      const before = await tx.collection('locations').findOne({ id, archived_at: null });
      if (!before) throw Errors.notFound('Office');
      const set = { latitude: input.latitude, longitude: input.longitude, geofence_radius_m: input.radiusM, geofence_active: input.active, ...(input.addressLine !== undefined ? { address_line: input.addressLine } : {}) };
      await tx.collection('locations').updateOne({ id }, { $set: set });
      await this.audit.record(tx, {
        action: 'work_mode.office_updated', resourceType: 'location', resourceId: id,
        changes: {
          latitude: { from: num(before.latitude), to: input.latitude }, longitude: { from: num(before.longitude), to: input.longitude },
          radiusM: { from: before.geofence_radius_m ?? null, to: input.radiusM }, active: { from: before.geofence_active !== false, to: input.active },
        },
      });
      return { ok: true };
    });
  }

  async createOffice(input: z.infer<typeof newOfficeInput>) {
    const entity = await this.db.tenant(async (tx) => {
      await this.requireConfigure(tx);
      return tx.collection('legal_entities').findOne({ id: input.legalEntityId, archived_at: null });
    });
    if (!entity) throw Errors.badRequest('invalid_legal_entity', 'Pick a legal entity of your company.');
    // Created through Organization, so the location is a full company location (holidays, policies, reports).
    const row = await this.org.create('locations', {
      name: input.name, legalEntityId: input.legalEntityId, kind: 'office', timezone: entity.timezone, countryCode: entity.country_code,
      city: input.city ?? undefined, addressLine: input.addressLine ?? undefined, latitude: input.latitude, longitude: input.longitude, geofenceRadiusM: input.radiusM,
    });
    await this.db.tenant((tx) => this.audit.record(tx, { action: 'work_mode.office_created', resourceType: 'location', resourceId: row!.id as string, metadata: { name: input.name } }));
    return row;
  }

  saveSite(id: string | null, input: WorkSiteInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      await this.requireConfigure(tx);
      const fields = {
        name: input.name, kind: input.kind, address_line: input.addressLine ?? null, latitude: input.latitude, longitude: input.longitude,
        radius_m: input.radiusM, counts_as: input.countsAs, everyone: input.everyone, active: input.active,
      };
      const dup = await tx.collection('work_sites').findOne({ archived_at: null, name: { $regex: `^${input.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }, ...(id ? { id: { $ne: id } } : {}) });
      if (dup) throw Errors.conflict('site_exists', 'There is already an approved place with that name.');
      if (id) {
        const before = await tx.collection('work_sites').findOne({ id, archived_at: null });
        if (!before) throw Errors.notFound('Approved place');
        await tx.collection('work_sites').updateOne({ id }, { $set: fields });
        await this.audit.record(tx, { action: 'work_mode.site_updated', resourceType: 'work_site', resourceId: id, changes: input });
        return { id };
      }
      const row = await tx.collection('work_sites').insert({ ...fields, created_by_membership_id: actor.membershipId });
      await this.audit.record(tx, { action: 'work_mode.site_created', resourceType: 'work_site', resourceId: row.id, changes: input });
      return { id: row.id as string };
    });
  }

  archiveSite(id: string) {
    return this.db.tenant(async (tx) => {
      await this.requireConfigure(tx);
      if (!(await tx.collection('work_sites').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date(), active: false } }))) throw Errors.notFound('Approved place');
      // Past days keep their place names; nobody can check in there any more.
      await this.audit.record(tx, { action: 'work_mode.site_archived', resourceType: 'work_site', resourceId: id });
    });
  }

  /** People and what they are assigned to (for the assignment dialog): optionally only those using one place. */
  assignments(q: { placeId?: string; q?: string }) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:read', undefined, tx);
      const v = await this.access.viewer(tx);
      const scope = await this.access.visibleFilter(tx, v);
      const and: Doc[] = [scope, { status: { $ne: 'exited' } }];
      const all = await tx.collection('employees').find({ $and: and }, { limit: 3000, sort: { first_name: 1, last_name: 1 } });
      const list = await tx.collection('work_assignments').find({ employee_id: { $in: all.map((e) => e.id) } });
      const byEmp = new Map(list.map((a) => [a.employee_id as string, a]));
      const locations = await fieldById(tx, 'locations', all.map((e) => e.current_location_id));
      const departments = await fieldById(tx, 'departments', all.map((e) => e.current_department_id));
      let rows = all.map((e) => {
        const a = byEmp.get(e.id);
        return {
          employeeId: e.id as string, name: displayName(e as never), code: (e.employee_code as string) ?? '',
          department: departments.get(e.current_department_id) ?? null,
          homeLocationId: (e.current_location_id as string | null) ?? null, homeLocation: locations.get(e.current_location_id) ?? null,
          officeIds: (a?.office_ids as string[]) ?? [], siteIds: (a?.site_ids as string[]) ?? [],
          officeRequirement: (a?.office_requirement as string | null) ?? null,
          minOfficeMinutes: (a?.min_office_minutes as number | null) ?? null, minRemoteMinutes: (a?.min_remote_minutes as number | null) ?? null,
          note: (a?.note as string | null) ?? null,
        };
      });
      if (q.placeId) rows = rows.filter((r) => r.homeLocationId === q.placeId || r.officeIds.includes(q.placeId!) || r.siteIds.includes(q.placeId!));
      if (q.q) {
        const n = q.q.toLowerCase();
        rows = rows.filter((r) => `${r.name} ${r.code}`.toLowerCase().includes(n));
      }
      return { rows };
    });
  }

  saveAssignments(input: WorkAssignmentInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      await this.requireConfigure(tx);
      const offices = new Set(await tx.collection('locations').distinct<string>('id', { id: { $in: input.officeIds ?? [] }, archived_at: null }));
      const sites = new Set(await tx.collection('work_sites').distinct<string>('id', { id: { $in: input.siteIds ?? [] }, archived_at: null }));
      if ((input.officeIds ?? []).some((x) => !offices.has(x)) || (input.siteIds ?? []).some((x) => !sites.has(x))) throw Errors.badRequest('unknown_place', 'Pick offices and approved places that exist.');
      let changed = 0;
      for (const employeeId of input.employeeIds) {
        const e = await this.days.employee(tx, employeeId);
        if (!e) throw Errors.notFound('Employee');
        await this.authz.require('attendance:read', attrsOf(e), tx);
        const before = await tx.collection('work_assignments').findOne({ employee_id: employeeId });
        const merge = (had: string[], given: string[] | undefined) => {
          if (given === undefined) return had;
          if (input.mode === 'add') return [...new Set([...had, ...given])];
          if (input.mode === 'remove') return had.filter((x) => !given.includes(x));
          return [...new Set(given)];
        };
        const set: Doc = {
          office_ids: merge((before?.office_ids as string[]) ?? [], input.officeIds),
          site_ids: merge((before?.site_ids as string[]) ?? [], input.siteIds),
          updated_by_membership_id: actor.membershipId,
        };
        if (input.officeRequirement !== undefined) set.office_requirement = input.officeRequirement;
        if (input.minOfficeMinutes !== undefined) set.min_office_minutes = input.minOfficeMinutes;
        if (input.minRemoteMinutes !== undefined) set.min_remote_minutes = input.minRemoteMinutes;
        if (input.note !== undefined) set.note = input.note;
        if (before) await tx.collection('work_assignments').updateOne({ id: before.id }, { $set: set });
        else await tx.collection('work_assignments').insert({ employee_id: employeeId, ...set });
        changed++;
        await this.audit.record(tx, {
          action: 'work_mode.assignment_updated', resourceType: 'employee', resourceId: employeeId,
          changes: { officeIds: { from: before?.office_ids ?? [], to: set.office_ids }, siteIds: { from: before?.site_ids ?? [], to: set.site_ids }, officeRequirement: { from: before?.office_requirement ?? null, to: set.office_requirement ?? before?.office_requirement ?? null } },
        });
      }
      return { changed };
    });
  }

  // ---------------------------------------------------------------------------------------------------------- notices

  async noticePrefs(tx: TenantTx, membershipId: string): Promise<Record<AttendanceNoticeKey, boolean>> {
    const row = await tx.collection('member_preferences').findOne({ membership_id: membershipId }, { projection: { attendance_notices: 1 } });
    const saved = (row?.attendance_notices as Record<string, boolean> | null) ?? {};
    return Object.fromEntries(ATTENDANCE_NOTICES.map((n) => [n.key, typeof saved[n.key] === 'boolean' ? saved[n.key] : n.default])) as Record<AttendanceNoticeKey, boolean>;
  }

  noticesView() {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const v = await this.access.viewer(tx);
      const prefs = await this.noticePrefs(tx, actor.membershipId);
      return { notices: ATTENDANCE_NOTICES.filter((n) => (n.levels as readonly string[]).includes(v.level)).map((n) => ({ key: n.key, label: n.label, description: n.description, enabled: prefs[n.key] })) };
    });
  }

  saveNotices(input: Record<string, boolean>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const before = await this.noticePrefs(tx, actor.membershipId);
      const next = { ...before, ...input };
      const row = await tx.collection('member_preferences').findOne({ membership_id: actor.membershipId });
      if (row) await tx.collection('member_preferences').updateOne({ membership_id: actor.membershipId }, { $set: { attendance_notices: next } });
      else await tx.collection('member_preferences').insert({ membership_id: actor.membershipId, attendance_notices: next });
      return this.noticesView();
    });
  }

  // ---------------------------------------------------------------------------------------------------------- jobs

  /**
   * Hourly: one "you forgot to check out" notice per day (for yesterday and the day before), and coordinates past the
   * company's retention period are removed (the office / home result stays).
   */
  async runJobs(tenantId: string, now = Date.now()) {
    return this.db.tenant(async (tx) => {
      const s = await this.settings(tx);
      let purged = 0;
      if (s.locationRetentionDays > 0) {
        const before = new Date(now - s.locationRetentionDays * 86_400_000);
        purged = await tx.collection('attendance_locations').update(
          { captured_at: { $lt: before }, purged_at: null, latitude: { $ne: null } },
          { $set: { latitude: null, longitude: null, accuracy_m: null, purged_at: new Date(now) } },
        );
      }
      let reminded = 0;
      const tenant = await tx.collection('tenants').findOne({});
      const today = localToday((tenant?.timezone as string) ?? 'UTC', now);
      const dates = [zonedTime.addDays(today, -1), zonedTime.addDays(today, -2)];
      const days = await tx.collection('attendance_days').find({ work_date: { $in: dates }, flags: 'missing_out', notices_sent: { $ne: 'missing_check_out' } }, { limit: 2000 });
      for (const d of days) {
        await tx.collection('attendance_days').updateOne({ employee_id: d.employee_id, work_date: d.work_date }, { $addToSet: { notices_sent: 'missing_check_out' } });
        const e = await tx.collection('employees').findOne({ id: d.employee_id }, { projection: { membership_id: 1 } });
        if (!e?.membership_id || !(await this.noticePrefs(tx, e.membership_id)).missing_check_out) continue;
        await this.notifications.notify(tx, {
          membershipIds: [e.membership_id], kind: 'attendance.missing_check_out', includeActor: true,
          title: `You did not check out on ${d.work_date}`, body: 'The day is incomplete until it is corrected. Ask for an attendance correction with the time you left.',
          link: `/attendance/day/${d.employee_id}/${d.work_date}`, dedupeKey: `missing-out:${d.employee_id}:${d.work_date}`,
        });
        reminded++;
      }
      return { purged, reminded };
    }, { tenantId });
  }

  /** The local clock time of an instant in a zone (for lists and exports). */
  static clock(at: Date | null | undefined, tz: string) {
    if (!at) return null;
    const l = toLocal(at.getTime(), tz);
    return `${String(Math.floor(l.minutes / 60)).padStart(2, '0')}:${String(l.minutes % 60).padStart(2, '0')}`;
  }
}
