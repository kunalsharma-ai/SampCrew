import { Injectable } from '@nestjs/common';
import {
  ACCESS_LEVEL_LABEL,
  DAY_STATUS_LABEL,
  LOCATION_VERIFICATION_LABEL,
  REPORT_SHEETS,
  REPORT_SHEET_LABEL,
  WORK_MODE_ISSUE_LABEL,
  WORK_REPORT_MAX_DAYS,
  workModeLabel,
  zonedTime,
  type ReportSheet,
  type WorkforceCategory,
  type WorkforceDashboard,
  type WorkforcePersonRow,
  type WorkModeLabels,
  type WorkModeState,
  type WorkReportQuery,
} from '@crew/contracts';
import type { z } from 'zod';
import type { savedReportInput, workforceDashboardQuery, workforcePeopleQuery, workRegisterQuery } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { type Cell, cellText, toXlsxBook, xDate, xDateTime, xHours } from '../../platform/export/tabular';
import { Errors } from '../../platform/http/errors';
import { csvCell } from '../payroll/payroll-common';
import { displayName, fieldById } from '../employees/employee-view';
import { AttendanceAccessService, type AttendanceViewer } from './attendance-access.service';
import { AttendanceService } from './attendance.service';
import { WorkModeService, zoneOfPunch } from './work-mode.service';

const { addDays, localToday, toLocal } = zonedTime;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
type Level = 'super' | 'hr' | 'employee';

interface Person {
  id: string;
  name: string;
  code: string;
  level: Level;
  departmentId: string | null;
  designationId: string | null;
  locationId: string | null;
  hrWorkspaceId: string | null;
  managerId: string | null;
  joined: string;
  left: string | null;
  tz: string;
  doc: Doc;
}

type Filters = z.infer<typeof workforceDashboardQuery>;
const MAX_PEOPLE = 20_000;

/** What one person's stored day says about them, for the cards and lists. */
function categorise(d: Doc | undefined) {
  const status = (d?.status as string | undefined) ?? null;
  const present = Boolean(d?.first_in) || status === 'present' || status === 'half_day' || status === 'half_day_leave';
  const leave = status === 'on_leave';
  const off = (status === 'weekly_off' || status === 'holiday') && !d?.first_in;
  const issues = (d?.work_mode_issues as string[] | undefined) ?? [];
  const flags = (d?.flags as string[] | undefined) ?? [];
  const mode = (d?.work_mode as WorkModeState | null | undefined) ?? null;
  return {
    status,
    present,
    leave,
    off,
    notIn: !present && !leave && !off,
    absent: status === 'absent' || (status === 'missing_punch' && !d?.first_in),
    incomplete: status === 'missing_punch' || issues.includes('missing_check_out') || issues.includes('missing_check_in') || flags.includes('missing_out') || flags.includes('missing_in'),
    irregular: issues.length > 0 || mode === 'pending_verification' || flags.some((f) => ['late', 'early_leave', 'outside_geofence', 'missing_out', 'missing_in'].includes(f)),
    workingNow: status === 'in_progress' && Boolean(d?.first_in) && !d?.last_out,
    mode: present ? mode : null,
  };
}

function inCategory(c: ReturnType<typeof categorise>, cat: WorkforceCategory): boolean {
  switch (cat) {
    case 'all': return true;
    case 'present': return c.present;
    case 'office': return c.mode === 'office';
    case 'remote': return c.mode === 'remote';
    case 'hybrid': return c.mode === 'hybrid';
    case 'pending': return c.mode === 'pending_verification';
    case 'not_checked_in': return c.notIn;
    case 'on_leave': return c.leave;
    case 'incomplete': return c.incomplete;
    case 'irregular': return c.irregular;
    case 'absent': return c.absent;
  }
}

const clockOf = (at: Date | null | undefined, tz: string) => {
  if (!at) return null;
  const l = toLocal(at.getTime(), tz);
  return { date: l.date, minutes: l.minutes, text: `${String(Math.floor(l.minutes / 60)).padStart(2, '0')}:${String(l.minutes % 60).padStart(2, '0')}` };
};

/**
 * Where the workforce works: the organisation-wide dashboard (Super Workspace, and HR Workspace with
 * "organisation-wide totals"), the lists behind each card, the detailed attendance register, and the attendance report
 * workbook. Every number comes from the stored attendance days; names only ever come from the people the viewer may
 * see (AttendanceAccessService), while org-wide totals count everyone, Super Workspace and HR Workspace people included.
 */
@Injectable()
export class WorkforceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly access: AttendanceAccessService,
    private readonly attendance: AttendanceService,
    private readonly workMode: WorkModeService,
  ) {}

  private async today(tx: TenantTx) {
    const tenant = await tx.collection('tenants').findOne({});
    return { today: localToday((tenant?.timezone as string) ?? 'UTC'), tz: (tenant?.timezone as string) ?? 'UTC', name: (tenant?.name as string) ?? 'Company' };
  }

  /** People employed at some point between from and to: everyone (org-wide) or only those the viewer may see. */
  private async people(tx: TenantTx, v: AttendanceViewer, from: string, to: string, f: Partial<Filters> & { employeeIds?: string[]; departmentIds?: string[] }, orgWide: boolean): Promise<Person[]> {
    const and: Doc[] = [{ date_of_joining: { $lte: to } }, { $or: [{ last_working_day: null }, { last_working_day: { $gte: from } }] }, { status: { $ne: 'pre_boarding' } }];
    if (!orgWide) and.push(await this.access.visibleFilter(tx, v));
    if (v.level === 'employee') and.push({ id: v.employeeId ?? '00000000-0000-0000-0000-000000000000' });
    if (f.employeeId) and.push({ id: f.employeeId });
    if (f.employeeIds?.length) and.push({ id: { $in: f.employeeIds } });
    if (f.departmentId) and.push({ current_department_id: f.departmentId });
    if (f.departmentIds?.length) and.push({ current_department_id: { $in: f.departmentIds } });
    if (f.designationId) and.push({ current_designation_id: f.designationId });
    if (f.locationId) and.push({ current_location_id: f.locationId });
    if (f.managerId) and.push({ current_manager_employee_id: f.managerId });
    if (f.hrWorkspaceId) and.push(this.access.groupFilter(v, [f.hrWorkspaceId]));
    const docs = await tx.collection('employees').find({ $and: and }, { limit: MAX_PEOPLE, sort: { first_name: 1, last_name: 1 } });
    const tenant = await tx.collection('tenants').findOne({});
    const locationTz = await fieldById(tx, 'locations', docs.map((e) => e.current_location_id), 'timezone');
    const entityTz = await fieldById(tx, 'legal_entities', docs.map((e) => e.current_legal_entity_id), 'timezone');
    let out = docs.map((e): Person => {
      const m = (e.membership_id as string | null) ?? null;
      return {
        id: e.id, name: displayName(e as never), code: (e.employee_code as string) ?? '',
        level: m && v.superMemberships.has(m) ? 'super' : m && v.hrMemberships.has(m) ? 'hr' : 'employee',
        departmentId: e.current_department_id ?? null, designationId: e.current_designation_id ?? null, locationId: e.current_location_id ?? null,
        hrWorkspaceId: e.hr_workspace_id ?? null, managerId: e.current_manager_employee_id ?? null,
        joined: e.date_of_joining, left: e.last_working_day ?? null,
        tz: locationTz.get(e.current_location_id) ?? entityTz.get(e.current_legal_entity_id) ?? ((tenant?.timezone as string) ?? 'UTC'),
        doc: e,
      };
    });
    if (f.level) out = out.filter((p) => p.level === f.level);
    if (f.q) {
      const n = f.q.toLowerCase();
      out = out.filter((p) => `${p.name} ${p.code}`.toLowerCase().includes(n));
    }
    return out;
  }

  private async requireSection(tx: TenantTx) {
    await this.authz.require('attendance:read', undefined, tx);
    const v = await this.access.viewer(tx);
    if (v.level === 'employee') throw Errors.forbidden('Your access shows your own attendance only');
    return v;
  }

  private async daysOn(tx: TenantTx, people: Person[], date: string, refresh: boolean) {
    const active = people.filter((p) => p.joined <= date && (!p.left || p.left >= date));
    if (refresh && active.length && active.length <= 1500) await this.attendance.refreshDate(tx, active.map((p) => p.doc), date);
    const days = active.length ? await tx.collection('attendance_days').find({ employee_id: { $in: active.map((p) => p.id) }, work_date: date }) : [];
    return { active, byId: new Map(days.map((d) => [d.employee_id as string, d])) };
  }

  // ---------------------------------------------------------------------------------------------------------- dashboard

  dashboard(q: Filters): Promise<WorkforceDashboard> {
    return this.db.tenant(async (tx) => {
      const v = await this.requireSection(tx);
      const { today } = await this.today(tx);
      const date = q.date && q.date <= today ? q.date : today;
      const to = q.to ?? date;
      const from = q.from ?? addDays(to, -13);
      const orgWide = v.orgTotals;
      const people = await this.people(tx, v, from < date ? from : date, to > date ? to : date, q, orgWide);
      const visible = orgWide ? await this.people(tx, v, date, date, q, false) : people;
      const labels = (await this.workMode.settings(tx)).labels;
      const { active, byId } = await this.daysOn(tx, people, date, date >= addDays(today, -1));
      const cards = { total: active.length, present: 0, office: 0, remote: 0, hybrid: 0, pending: 0, notCheckedIn: 0, onLeave: 0, incomplete: 0, irregular: 0, absent: 0, off: 0, workingNow: 0 };
      let officeMinutes = 0;
      let remoteMinutes = 0;
      type Group = { total: number; present: number; office: number; remote: number; hybrid: number; pending: number };
      const empty = (): Group => ({ total: 0, present: 0, office: 0, remote: 0, hybrid: 0, pending: 0 });
      const dept = new Map<string | null, Group>();
      const loc = new Map<string | null, Group>();
      const lvl = new Map<Level, Group>();
      const bump = (g: Group, c: ReturnType<typeof categorise>) => {
        g.total++;
        if (c.present) g.present++;
        if (c.mode === 'office') g.office++;
        if (c.mode === 'remote') g.remote++;
        if (c.mode === 'hybrid') g.hybrid++;
        if (c.mode === 'pending_verification') g.pending++;
      };
      for (const p of active) {
        const d = byId.get(p.id);
        const c = categorise(d);
        if (c.present) cards.present++;
        if (c.mode === 'office') cards.office++;
        if (c.mode === 'remote') cards.remote++;
        if (c.mode === 'hybrid') cards.hybrid++;
        if (c.mode === 'pending_verification') cards.pending++;
        if (c.notIn) cards.notCheckedIn++;
        if (c.leave) cards.onLeave++;
        if (c.incomplete) cards.incomplete++;
        if (c.irregular) cards.irregular++;
        if (c.absent) cards.absent++;
        if (c.off) cards.off++;
        if (c.workingNow) cards.workingNow++;
        officeMinutes += (d?.office_minutes as number) ?? 0;
        remoteMinutes += (d?.remote_minutes as number) ?? 0;
        bump(dept.get(p.departmentId) ?? (dept.set(p.departmentId, empty()), dept.get(p.departmentId)!), c);
        bump(loc.get(p.locationId) ?? (loc.set(p.locationId, empty()), loc.get(p.locationId)!), c);
        bump(lvl.get(p.level) ?? (lvl.set(p.level, empty()), lvl.get(p.level)!), c);
      }
      const departments = await fieldById(tx, 'departments', [...dept.keys()]);
      const locations = await fieldById(tx, 'locations', [...loc.keys()]);
      const sortGroups = <T extends { total: number; name: string }>(rows: T[]) => rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
      // Daily trend over the range.
      const end = to < today ? to : today;
      const ids = people.map((p) => p.id);
      const rows = ids.length && from <= end ? await tx.collection('attendance_days').aggregate<{ id: { d: string; m: string | null; s: string }; n: number }>([
        { $match: { employee_id: { $in: ids }, work_date: { $gte: from, $lte: end } } },
        { $group: { _id: { d: '$work_date', m: '$work_mode', s: '$status' }, n: { $sum: 1 } } },
      ]) : [];
      const trend: WorkforceDashboard['trend'] = [];
      for (let d = from; d <= end; d = addDays(d, 1)) {
        const day = rows.filter((r) => r.id.d === d);
        const n = (pred: (r: (typeof day)[number]) => boolean) => day.filter(pred).reduce((t, r) => t + r.n, 0);
        trend.push({
          date: d,
          office: n((r) => r.id.m === 'office'), remote: n((r) => r.id.m === 'remote'), hybrid: n((r) => r.id.m === 'hybrid'), pending: n((r) => r.id.m === 'pending_verification'),
          absent: n((r) => r.id.s === 'absent'), leave: n((r) => r.id.s === 'on_leave'),
        });
      }
      return {
        date, from, to, labels, level: v.level as 'super' | 'hr', orgWide, visiblePeople: visible.filter((p) => p.joined <= date && (!p.left || p.left >= date)).length,
        cards,
        byDepartment: sortGroups([...dept].map(([id, g]) => ({ id, name: id ? departments.get(id) ?? 'Department' : 'No department', ...g }))),
        byLocation: sortGroups([...loc].map(([id, g]) => ({ id, name: id ? locations.get(id) ?? 'Location' : 'No location', ...g }))),
        byLevel: (['super', 'hr', 'employee'] as Level[]).filter((l) => lvl.has(l)).map((l) => ({ level: l, label: ACCESS_LEVEL_LABEL[`${l === 'super' ? 'super' : l === 'hr' ? 'hr' : 'employee'}_workspace` as keyof typeof ACCESS_LEVEL_LABEL], ...lvl.get(l)! })),
        trend,
        hours: { office: officeMinutes, remote: remoteMinutes },
      };
    });
  }

  /** The people behind one card, only those the viewer may see. */
  peopleList(q: z.infer<typeof workforcePeopleQuery>) {
    return this.db.tenant(async (tx) => {
      const v = await this.requireSection(tx);
      const { today } = await this.today(tx);
      const date = q.date && q.date <= today ? q.date : today;
      const people = await this.people(tx, v, date, date, q, false);
      const { active, byId } = await this.daysOn(tx, people, date, date >= addDays(today, -1));
      const departments = await fieldById(tx, 'departments', active.map((p) => p.departmentId));
      const designations = await fieldById(tx, 'designations', active.map((p) => p.designationId));
      const locations = await fieldById(tx, 'locations', active.map((p) => p.locationId));
      const matched = active.filter((p) => inCategory(categorise(byId.get(p.id)), q.category));
      const start = (q.page - 1) * q.pageSize;
      const rows: WorkforcePersonRow[] = matched.slice(start, start + q.pageSize).map((p) => {
        const d = byId.get(p.id);
        const detail = (d?.work_mode_detail as Doc | null) ?? null;
        return {
          employeeId: p.id, name: p.name, code: p.code, level: p.level,
          department: (p.departmentId && departments.get(p.departmentId)) || null,
          designation: (p.designationId && designations.get(p.designationId)) || null,
          location: (p.locationId && locations.get(p.locationId)) || null,
          status: (d?.status as string) ?? 'unmarked',
          mode: categorise(d).mode,
          provisional: Boolean(d?.work_mode_provisional),
          checkIn: clockOf(d?.first_in, p.tz)?.text ?? null,
          checkOut: clockOf(d?.last_out, p.tz)?.text ?? null,
          checkInPlace: detail?.checkIn?.place ?? (detail?.checkIn?.zone === 'remote' ? 'Away from office' : null),
          checkOutPlace: detail?.checkOut?.place ?? (detail?.checkOut?.zone === 'remote' ? 'Away from office' : null),
          officeMinutes: (d?.office_minutes as number) ?? 0,
          remoteMinutes: (d?.remote_minutes as number) ?? 0,
          workedMinutes: (d?.worked_minutes as number) ?? 0,
          issues: (d?.work_mode_issues as string[]) ?? [],
        };
      });
      return { date, category: q.category, rows, total: matched.length, page: q.page, pageSize: q.pageSize };
    });
  }

  // ---------------------------------------------------------------------------------------------------------- register

  private dayFilter(people: Person[], from: string, to: string, q: { modes?: WorkModeState[]; status?: string; verification?: 'verified' | 'unverified' }): Doc {
    const and: Doc[] = [{ employee_id: { $in: people.map((p) => p.id) } }, { work_date: { $gte: from, $lte: to } }, { status: { $ne: 'not_joined' } }];
    if (q.modes?.length) and.push({ work_mode: { $in: q.modes } });
    switch (q.status) {
      case 'present': and.push({ $or: [{ first_in: { $ne: null } }, { status: { $in: ['present', 'half_day', 'half_day_leave'] } }] }); break;
      case 'absent': and.push({ status: 'absent' }); break;
      case 'leave': and.push({ status: { $in: ['on_leave', 'half_day_leave'] } }); break;
      case 'incomplete': and.push({ $or: [{ status: 'missing_punch' }, { work_mode_issues: { $in: ['missing_check_out', 'missing_check_in'] } }] }); break;
      case 'late': and.push({ late_minutes: { $gt: 0 } }); break;
      case 'early_leave': and.push({ early_leave_minutes: { $gt: 0 } }); break;
      case 'irregular': and.push({ $or: [{ 'work_mode_issues.0': { $exists: true } }, { flags: { $in: ['late', 'early_leave', 'outside_geofence', 'missing_out', 'missing_in'] } }, { work_mode: 'pending_verification' }] }); break;
      case 'pending': and.push({ work_mode: 'pending_verification' }); break;
      default: break;
    }
    if (q.verification === 'unverified') and.push({ $or: [{ work_mode: 'pending_verification' }, { unverified_minutes: { $gt: 0 } }] });
    if (q.verification === 'verified') and.push({ work_mode: { $in: ['office', 'remote', 'hybrid'] } });
    return { $and: and };
  }

  private async names(tx: TenantTx, people: Person[]) {
    return {
      departments: await fieldById(tx, 'departments', people.map((p) => p.departmentId)),
      designations: await fieldById(tx, 'designations', people.map((p) => p.designationId)),
      locations: await fieldById(tx, 'locations', people.map((p) => p.locationId)),
      groups: new Map([['central', 'Central group'], ...(await tx.collection('hr_workspaces').find({}, { projection: { name: 1 } })).map((w) => [w.id as string, w.name as string] as [string, string])]),
    };
  }

  private registerRow(p: Person, d: Doc, n: Awaited<ReturnType<WorkforceService['names']>>, labels: WorkModeLabels) {
    const detail = (d.work_mode_detail as Doc | null) ?? null;
    const inC = clockOf(d.first_in, p.tz);
    const outC = clockOf(d.last_out, p.tz);
    const mode = (d.work_mode as WorkModeState | null) ?? null;
    return {
      employeeId: p.id, name: p.name, code: p.code, level: p.level,
      department: (p.departmentId && n.departments.get(p.departmentId)) || null,
      designation: (p.designationId && n.designations.get(p.designationId)) || null,
      location: (p.locationId && n.locations.get(p.locationId)) || null,
      hrWorkspace: n.groups.get(p.hrWorkspaceId ?? 'central') ?? 'Central group',
      date: d.work_date as string,
      status: d.status as string,
      statusLabel: DAY_STATUS_LABEL[d.status] ?? d.status,
      mode, modeLabel: mode ? workModeLabel(mode, labels) : null,
      provisional: Boolean(d.work_mode_provisional),
      corrected: d.work_mode_override ? { by: d.work_mode_override.byName ?? null, reason: d.work_mode_override.reason, source: d.work_mode_override.source } : null,
      checkIn: inC?.text ?? null, checkOut: outC?.text ?? null,
      checkInDate: inC?.date ?? null, checkOutDate: outC?.date ?? null,
      checkInMinutes: inC?.minutes ?? null, checkOutMinutes: outC?.minutes ?? null,
      checkInPlace: detail?.checkIn?.place ?? null, checkOutPlace: detail?.checkOut?.place ?? null,
      checkInZone: detail?.checkIn?.zone ?? null, checkOutZone: detail?.checkOut?.zone ?? null,
      checkInVerification: detail?.checkIn?.verification ?? null, checkOutVerification: detail?.checkOut?.verification ?? null,
      verified: mode === null ? null : mode !== 'pending_verification',
      workedMinutes: (d.worked_minutes as number) ?? 0,
      officeMinutes: (d.office_minutes as number) ?? 0,
      remoteMinutes: (d.remote_minutes as number) ?? 0,
      unverifiedMinutes: (d.unverified_minutes as number) ?? 0,
      lateMinutes: (d.late_minutes as number) ?? 0,
      earlyLeaveMinutes: (d.early_leave_minutes as number) ?? 0,
      overtimeMinutes: (d.overtime_minutes as number) ?? 0,
      places: (d.work_mode_places as string[]) ?? [],
      issues: (d.work_mode_issues as string[]) ?? [],
      flags: (d.flags as string[]) ?? [],
      transitions: ((detail?.transitions as unknown[]) ?? []).length,
      timeZone: p.tz,
    };
  }

  register(q: z.infer<typeof workRegisterQuery>) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:read', undefined, tx);
      const v = await this.access.viewer(tx);
      const people = await this.people(tx, v, q.from, q.to, q, false);
      const byId = new Map(people.map((p) => [p.id, p]));
      const labels = (await this.workMode.settings(tx)).labels;
      if (!people.length) return { rows: [], total: 0, page: q.page, pageSize: q.pageSize, labels };
      const filter = this.dayFilter(people, q.from, q.to, q);
      const total = await tx.collection('attendance_days').count(filter);
      const days = await tx.collection('attendance_days').find(filter, { sort: { work_date: -1, employee_id: 1 }, skip: (q.page - 1) * q.pageSize, limit: q.pageSize });
      const n = await this.names(tx, people);
      const canVerify = v.level !== 'employee' && (await this.authz.require('attendance:approve', undefined, tx).then(() => true, () => false));
      return { rows: days.map((d) => this.registerRow(byId.get(d.employee_id)!, d, n, labels)), total, page: q.page, pageSize: q.pageSize, labels, canVerify };
    });
  }

  // ---------------------------------------------------------------------------------------------------------- report

  /**
   * The attendance report workbook: Summary, Detailed Register, Office, Work From Home, Hybrid, Check-In and Check-Out
   * Log, Exceptions & Corrections and Employee Summary. Each sheet has the company, report title, period and when it
   * was made above a frozen, filterable header; dates and times are real Excel values. Sheets with no records are
   * left out (and the summary says which). Every record matching the filters is included, never one screen's page.
   */
  report(q: WorkReportQuery) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:read', undefined, tx);
      const v = await this.access.viewer(tx);
      if (!v.canExport) throw Errors.forbidden(v.level === 'employee' ? 'Exporting your attendance is turned off for your workspace' : 'Exporting attendance is turned off for your HR Workspace');
      const own = v.level === 'employee';
      if (own && !v.employeeId) throw Errors.badRequest('no_employee_record', 'Your login has no employee record, so there is no attendance to export.');
      if (q.scope === 'selected' && !q.employeeIds?.length && !q.departmentIds?.length && !q.modes?.length) throw Errors.badRequest('nothing_selected', 'Choose the employees, departments or attendance categories to export.');
      const { today, name: company } = await this.today(tx);
      const s = await this.workMode.settings(tx);
      const labels = s.labels;
      // What the file holds: everything the person may see (all), the screen's filters (current) or a selection.
      const f = q.scope === 'all' ? {} : q.scope === 'selected' ? { employeeIds: q.employeeIds, departmentIds: q.departmentIds } : q;
      const dayQ = q.scope === 'all' ? {} : { modes: q.modes, status: q.scope === 'current' ? q.status : undefined, verification: q.scope === 'current' ? q.verification : undefined };
      const people = await this.people(tx, v, q.from, q.to, f, false);
      const byId = new Map(people.map((p) => [p.id, p]));
      const n = await this.names(tx, people);
      const end = q.to < today ? q.to : today;
      // Days not counted yet in a recent period are counted first, so the file matches the screens.
      if (people.length <= 300 && end >= q.from && (Date.parse(end) - Date.parse(q.from)) / 86_400_000 <= 62) {
        for (const p of people) await this.attendance.recomputeFor(tx, p.id, q.from > p.joined ? q.from : p.joined, end);
      }
      const total = people.length ? await tx.collection('attendance_days').count(this.dayFilter(people, q.from, end, dayQ)) : 0;
      if (total > WORK_REPORT_MAX_DAYS) throw Errors.badRequest('too_many_rows', `That is ${total.toLocaleString('en')} attendance days; one file holds up to ${WORK_REPORT_MAX_DAYS.toLocaleString('en')}. Pick a shorter period or fewer people.`);
      const rows: ReturnType<WorkforceService['registerRow']>[] = [];
      for (let i = 0; i < people.length; i += 500) {
        const chunk = people.slice(i, i + 500);
        const days = await tx.collection('attendance_days').find(this.dayFilter(chunk, q.from, end, dayQ), { sort: { work_date: 1 } });
        for (const d of days) rows.push(this.registerRow(byId.get(d.employee_id)!, d, n, labels));
      }
      rows.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
      const wanted = new Set<ReportSheet>(q.sheets?.length ? q.sheets : REPORT_SHEETS);
      const level = ACCESS_LEVEL_LABEL[(v.level === 'super' ? 'super_workspace' : v.level === 'hr' ? 'hr_workspace' : 'employee_workspace') as keyof typeof ACCESS_LEVEL_LABEL];
      const generated = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const filterText = [
        q.scope === 'all' ? 'All records you may see' : q.scope === 'selected' ? 'Selected records' : 'Current view',
        ...(q.scope !== 'all' && q.modes?.length ? [`Categories: ${q.modes.map((m) => workModeLabel(m, labels)).join(', ')}`] : []),
        ...(q.scope === 'current' && q.status ? [`Status: ${q.status.replace(/_/g, ' ')}`] : []),
        ...(q.scope === 'current' && q.q ? [`Search: ${q.q}`] : []),
        ...(q.scope === 'selected' && q.employeeIds?.length ? [`${q.employeeIds.length} employees`] : []),
        ...(q.scope === 'selected' && q.departmentIds?.length ? [`${q.departmentIds.length} departments`] : []),
      ].join(' · ');
      const head = (title: string): Cell[][] => [
        [`${company} · ${title}`],
        [`Reporting period: ${q.from} to ${q.to}`],
        [`Generated ${generated} UTC by ${level}`],
        [filterText],
        [],
      ];
      const HEADER = 5;
      const sheets: { name: string; rows: Cell[][]; header?: number; filter?: boolean }[] = [];
      const leftOut: string[] = [];
      const mode = (r: (typeof rows)[number]) => (r.mode ? workModeLabel(r.mode, labels) : 'Not classified');
      const verif = (x: string | null) => (x ? LOCATION_VERIFICATION_LABEL[x as keyof typeof LOCATION_VERIFICATION_LABEL] ?? x : '');
      const tIn = (r: (typeof rows)[number]): Cell => (r.checkInDate !== null && r.checkInMinutes !== null ? xDateTime(r.checkInDate, r.checkInMinutes) : '');
      const tOut = (r: (typeof rows)[number]): Cell => (r.checkOutDate !== null && r.checkOutMinutes !== null ? xDateTime(r.checkOutDate, r.checkOutMinutes) : '');
      const issues = (r: (typeof rows)[number]) => [...r.issues.map((i) => WORK_MODE_ISSUE_LABEL[i as keyof typeof WORK_MODE_ISSUE_LABEL] ?? i), ...(r.lateMinutes ? [`Late ${r.lateMinutes} min`] : []), ...(r.earlyLeaveMinutes ? [`Left early ${r.earlyLeaveMinutes} min`] : [])].join('; ');
      const present = (r: (typeof rows)[number]) => Boolean(r.checkIn) || ['present', 'half_day', 'half_day_leave'].includes(r.status);

      // 1. Summary.
      if (wanted.has('summary')) {
        const c = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).length;
        const workingDays = c((r) => !['weekly_off', 'holiday'].includes(r.status) || Boolean(r.checkIn));
        const presentDays = c(present);
        const groupTable = (key: 'department' | 'location', title: string): Cell[][] => {
          const g = new Map<string, { people: Set<string>; present: number; office: number; remote: number; hybrid: number; pending: number; absent: number; leave: number }>();
          for (const r of rows) {
            const k = r[key] ?? `No ${key}`;
            const x = g.get(k) ?? { people: new Set(), present: 0, office: 0, remote: 0, hybrid: 0, pending: 0, absent: 0, leave: 0 };
            x.people.add(r.employeeId);
            if (present(r)) x.present++;
            if (r.mode === 'office') x.office++;
            if (r.mode === 'remote') x.remote++;
            if (r.mode === 'hybrid') x.hybrid++;
            if (r.mode === 'pending_verification') x.pending++;
            if (r.status === 'absent') x.absent++;
            if (r.status === 'on_leave') x.leave++;
            g.set(k, x);
          }
          return [
            [],
            [title, 'Employees', 'Present days', labels.office, labels.remote, labels.hybrid, 'Pending verification', 'Absent days', 'Leave days'],
            ...[...g].sort((a, b) => a[0].localeCompare(b[0])).map(([k, x]) => [k, x.people.size, x.present, x.office, x.remote, x.hybrid, x.pending, x.absent, x.leave]),
          ];
        };
        sheets.push({
          name: REPORT_SHEET_LABEL.summary,
          header: HEADER,
          rows: [
            ...head('Attendance Summary'),
            ['Measure', 'Value'],
            ['Total headcount (people in the report)', people.length],
            ['Headcount by level', (['super', 'hr', 'employee'] as Level[]).map((l) => `${l === 'super' ? 'Super Workspace' : l === 'hr' ? 'HR Workspace' : 'Employee Workspace'}: ${people.filter((p) => p.level === l).length}`).join(', ')],
            ['Attendance days in the report', rows.length],
            ['Present days', presentDays],
            [`${labels.office} days`, c((r) => r.mode === 'office')],
            [`${labels.remote} days`, c((r) => r.mode === 'remote')],
            [`${labels.hybrid} days`, c((r) => r.mode === 'hybrid')],
            ['Pending verification days', c((r) => r.mode === 'pending_verification')],
            ['Absent days', c((r) => r.status === 'absent')],
            ['Leave days', c((r) => r.status === 'on_leave') + 0.5 * c((r) => r.status === 'half_day_leave')],
            ['Incomplete attendance days', c((r) => r.status === 'missing_punch' || r.issues.includes('missing_check_out'))],
            ['Attendance % (present days / working days)', workingDays ? Math.round((presentDays / workingDays) * 1000) / 10 : ''],
            ['Office hours', xHours(rows.reduce((t, r) => t + r.officeMinutes, 0))],
            ['Remote hours', xHours(rows.reduce((t, r) => t + r.remoteMinutes, 0))],
            ['Total working hours', xHours(rows.reduce((t, r) => t + r.workedMinutes, 0))],
            ...groupTable('department', 'Department'),
            ...groupTable('location', 'Office / location'),
          ],
        });
      }

      // 2. Detailed register.
      const registerHead: Cell[] = ['Employee ID', 'Employee Name', 'Department', 'Designation', 'Workspace', 'HR Workspace', 'Assigned Office / Location', 'Date', 'Attendance Classification', 'Check-in', 'Check-in Place', 'Check-out', 'Check-out Place', 'Total Working Hours', 'Office Hours', 'Remote Hours', 'Attendance Status', 'Verification Status', 'Corrected By HR', 'Exceptions', 'Time Zone'];
      const registerRow = (r: (typeof rows)[number]): Cell[] => [
        r.code, r.name, r.department ?? '', r.designation ?? '', r.level === 'super' ? 'Super Workspace' : r.level === 'hr' ? 'HR Workspace' : 'Employee Workspace', r.hrWorkspace, r.location ?? '',
        xDate(r.date), mode(r), tIn(r), r.checkInPlace ?? (r.checkInZone === 'remote' ? 'Away from office' : ''), tOut(r), r.checkOutPlace ?? (r.checkOutZone === 'remote' ? 'Away from office' : ''),
        xHours(r.workedMinutes), xHours(r.officeMinutes), xHours(r.remoteMinutes), r.statusLabel,
        r.verified === null ? '' : r.verified ? 'Verified' : 'Pending verification', r.corrected ? `${r.corrected.by ?? 'HR'}: ${r.corrected.reason}` : '', issues(r), r.timeZone,
      ];
      if (wanted.has('register')) sheets.push({ name: REPORT_SHEET_LABEL.register, header: HEADER, filter: true, rows: [...head('Detailed Attendance Register'), registerHead, ...rows.map(registerRow)] });

      // 3-5. One sheet per arrangement.
      const perMode: [ReportSheet, WorkModeState, string][] = [['office', 'office', labels.office], ['remote', 'remote', labels.remote], ['hybrid', 'hybrid', labels.hybrid]];
      for (const [sheet, m, title] of perMode) {
        if (!wanted.has(sheet)) continue;
        const list = rows.filter((r) => r.mode === m);
        if (!list.length) {
          leftOut.push(`${REPORT_SHEET_LABEL[sheet]} (no ${title} days)`);
          continue;
        }
        const extra = m === 'hybrid' ? ['Moves Between Places'] : [];
        sheets.push({
          name: m === 'office' ? REPORT_SHEET_LABEL.office : m === 'remote' ? REPORT_SHEET_LABEL.remote : REPORT_SHEET_LABEL.hybrid,
          header: HEADER, filter: true,
          rows: [
            ...head(`${title} Details`),
            ['Employee ID', 'Employee Name', 'Department', 'Date', 'Check-in', 'Check-in Place', 'Check-in Verification', 'Check-out', 'Check-out Place', 'Check-out Verification', 'Office Hours', 'Remote Hours', 'Total Working Hours', ...extra, 'Places', 'Exceptions'],
            ...list.map((r) => [
              r.code, r.name, r.department ?? '', xDate(r.date), tIn(r), r.checkInPlace ?? '', verif(r.checkInVerification), tOut(r), r.checkOutPlace ?? '', verif(r.checkOutVerification),
              xHours(r.officeMinutes), xHours(r.remoteMinutes), xHours(r.workedMinutes), ...(m === 'hybrid' ? [r.transitions] : []), r.places.join(', '), issues(r),
            ]),
          ],
        });
      }

      // 6. Every check-in, check-out and location update.
      if (wanted.has('events')) {
        const coords = await this.authz.require('attendance:configure', undefined, tx).then(() => true, () => false);
        const fromMs = Date.parse(`${addDays(q.from, -1)}T00:00:00Z`);
        const toMs = Date.parse(`${addDays(end, 2)}T00:00:00Z`);
        const log: Cell[][] = [];
        for (let i = 0; i < people.length; i += 200) {
          const chunk = people.slice(i, i + 200);
          const events = await tx.collection('attendance_events').find({ employee_id: { $in: chunk.map((p) => p.id) }, captured_at: { $gte: new Date(fromMs), $lt: new Date(toMs) } }, { sort: { captured_at: 1 }, limit: WORK_REPORT_MAX_DAYS });
          const locs = await tx.collection('attendance_locations').find({ employee_id: { $in: chunk.map((p) => p.id) }, captured_at: { $gte: new Date(fromMs), $lt: new Date(toMs) } });
          const byEvent = new Map(locs.filter((l) => l.event_id).map((l) => [l.event_id as string, l]));
          const items = [
            ...events.map((ev) => ({ at: ev.captured_at as Date, employeeId: ev.employee_id as string, kind: ev.direction === 'in' ? 'Check-in' : ev.direction === 'out' ? 'Check-out' : 'Punch', source: ev.source as string, ev, loc: byEvent.get(ev.id) })),
            ...locs.filter((l) => l.kind === 'checkpoint').map((l) => ({ at: l.captured_at as Date, employeeId: l.employee_id as string, kind: 'Location update', source: l.source as string, ev: null as Doc | null, loc: l })),
          ].sort((a, b) => a.at.getTime() - b.at.getTime());
          for (const it of items) {
            const p = byId.get(it.employeeId)!;
            const c = clockOf(it.at, p.tz)!;
            if (c.date < q.from || c.date > q.to) continue;
            const z = it.ev ? zoneOfPunch({ work_zone: it.ev.work_zone ?? null, work_place_name: it.ev.work_place_name ?? null, source: it.ev.source, geofence_result: it.ev.geofence_result ?? null, device_name: null } as never) : { zone: it.loc!.zone, place: it.loc!.place_name ?? null };
            const verification = (it.ev?.location_verification ?? it.loc?.verification ?? null) as string | null;
            log.push([
              p.code, p.name, xDateTime(c.date, c.minutes), it.kind, it.source === 'mobile' ? 'Phone app' : it.source === 'web' ? 'Web' : it.source === 'qr' ? 'QR kiosk' : it.source === 'device' ? 'Biometric device' : it.source === 'correction' ? 'Approved correction' : it.source,
              z.zone === 'office' ? 'Office' : z.zone === 'remote' ? 'Away from office' : z.zone === 'neutral' ? 'No location (correction)' : 'Not verified', z.place ?? '', verif(verification),
              (it.loc?.distance_m as number | null) ?? '',
              ...(coords ? [it.loc && it.loc.latitude != null ? Number(it.loc.latitude) : it.loc?.purged_at ? 'Removed (retention)' : '', it.loc && it.loc.longitude != null ? Number(it.loc.longitude) : '', it.loc && it.loc.accuracy_m != null ? Number(it.loc.accuracy_m) : ''] : []),
              (it.ev?.note as string | null) ?? '',
            ]);
          }
        }
        if (log.length) {
          sheets.push({
            name: REPORT_SHEET_LABEL.events, header: HEADER, filter: true,
            rows: [...head('Check-In and Check-Out Log'), ['Employee ID', 'Employee Name', 'Date and Time', 'Event', 'Recorded From', 'Geofence Result', 'Office / Place', 'Verification', 'Distance to Nearest Office (m)', ...(coords ? ['Latitude', 'Longitude', 'Accuracy (m)'] : []), 'Note'], ...log],
          });
        } else leftOut.push(`${REPORT_SHEET_LABEL.events} (no punches)`);
      }

      // 7. Exceptions and corrections.
      if (wanted.has('exceptions')) {
        const ex: Cell[][] = [];
        for (const r of rows) {
          const items = [
            ...(r.status === 'missing_punch' || r.issues.includes('missing_check_out') ? ['Missing check-out or check-in'] : []),
            ...(r.lateMinutes ? [`Late arrival (${r.lateMinutes} min)`] : []),
            ...(r.earlyLeaveMinutes ? [`Early departure (${r.earlyLeaveMinutes} min)`] : []),
            ...(r.mode === 'pending_verification' ? ['Location pending verification'] : []),
            ...r.issues.filter((i) => !['missing_check_out', 'missing_check_in', 'location_unverified'].includes(i)).map((i) => WORK_MODE_ISSUE_LABEL[i as keyof typeof WORK_MODE_ISSUE_LABEL] ?? i),
          ];
          for (const item of items) ex.push([r.code, r.name, r.department ?? '', xDate(r.date), 'Exception', item, '', '', r.corrected ? `${r.corrected.by ?? 'HR'}: ${r.corrected.reason}` : '']);
        }
        const ids = people.map((p) => p.id);
        const corrections = ids.length ? await tx.collection('attendance_corrections').find({ employee_id: { $in: ids }, work_date: { $gte: q.from, $lte: q.to } }, { sort: { work_date: 1 } }) : [];
        for (const c of corrections) {
          const p = byId.get(c.employee_id)!;
          const what = [
            ...((c.punches as { time: string; direction: string }[]) ?? []).map((x) => `${x.direction} ${x.time}`),
            ...(c.work_mode ? [workModeLabel(c.work_mode, labels)] : []),
          ].join(', ');
          ex.push([p.code, p.name, (p.departmentId && n.departments.get(p.departmentId)) || '', xDate(c.work_date), 'Correction request', `${String(c.category ?? 'other').replace(/_/g, ' ')}: ${what}`, c.status, c.reason, c.decided_reason ?? '']);
        }
        const changes = ids.length ? await tx.collection('work_mode_changes').find({ employee_id: { $in: ids }, work_date: { $gte: q.from, $lte: q.to }, by: { $in: ['hr', 'correction'] } }, { sort: { created_at: 1 } }) : [];
        for (const c of changes) {
          const p = byId.get(c.employee_id)!;
          ex.push([p.code, p.name, (p.departmentId && n.departments.get(p.departmentId)) || '', xDate(c.work_date), c.by === 'hr' ? 'Corrected by HR' : 'Approved correction', `${workModeLabel(c.from_mode, labels)} to ${workModeLabel(c.to_mode, labels)}`, 'Applied', c.reason ?? '', c.by_name ?? '']);
        }
        if (ex.length) sheets.push({ name: REPORT_SHEET_LABEL.exceptions, header: HEADER, filter: true, rows: [...head('Attendance Exceptions & Corrections'), ['Employee ID', 'Employee Name', 'Department', 'Date', 'Type', 'Detail', 'Approval Status', 'Reason', 'Decision / Authorised Change'], ...ex] });
        else leftOut.push(`${REPORT_SHEET_LABEL.exceptions} (none in the period)`);
      }

      // 8. Per employee.
      if (wanted.has('employees')) {
        const byEmp = new Map<string, (typeof rows)[number][]>();
        for (const r of rows) byEmp.set(r.employeeId, [...(byEmp.get(r.employeeId) ?? []), r]);
        sheets.push({
          name: REPORT_SHEET_LABEL.employees, header: HEADER, filter: true,
          rows: [
            ...head('Employee Attendance Summary'),
            ['Employee ID', 'Employee Name', 'Department', 'Designation', 'Workspace', 'Present Days', `${labels.office} Days`, `${labels.remote} Days`, `${labels.hybrid} Days`, 'Pending Verification Days', 'Total Working Hours', 'Office Hours', 'Remote Hours', 'Overtime Hours', 'Leave Days', 'Absent Days', 'Late Days', 'Attendance %'],
            ...people.map((p) => {
              const list = byEmp.get(p.id) ?? [];
              const k = (pred: (r: (typeof rows)[number]) => boolean) => list.filter(pred).length;
              const working = k((r) => !['weekly_off', 'holiday'].includes(r.status) || Boolean(r.checkIn));
              const pres = k(present);
              return [
                p.code, p.name, (p.departmentId && n.departments.get(p.departmentId)) || '', (p.designationId && n.designations.get(p.designationId)) || '',
                p.level === 'super' ? 'Super Workspace' : p.level === 'hr' ? 'HR Workspace' : 'Employee Workspace',
                pres, k((r) => r.mode === 'office'), k((r) => r.mode === 'remote'), k((r) => r.mode === 'hybrid'), k((r) => r.mode === 'pending_verification'),
                xHours(list.reduce((t, r) => t + r.workedMinutes, 0)), xHours(list.reduce((t, r) => t + r.officeMinutes, 0)), xHours(list.reduce((t, r) => t + r.remoteMinutes, 0)), xHours(list.reduce((t, r) => t + r.overtimeMinutes, 0)),
                k((r) => r.status === 'on_leave') + 0.5 * k((r) => r.status === 'half_day_leave'), k((r) => r.status === 'absent'), k((r) => r.lateMinutes > 0),
                working ? Math.round((pres / working) * 1000) / 10 : '',
              ];
            }),
          ],
        });
      }
      if (leftOut.length && sheets[0]?.name === REPORT_SHEET_LABEL.summary) sheets[0].rows.push([], ['Sheets left out because they have no records', leftOut.join('; ')]);
      if (!sheets.length) sheets.push({ name: 'Report', header: HEADER, rows: [...head('Attendance Report'), ['No records match these filters.']] });

      await this.audit.record(tx, {
        action: 'attendance.report_exported', resourceType: 'attendance', resourceId: own ? v.employeeId! : 'workforce',
        metadata: {
          format: q.format, scope: q.scope, from: q.from, to: q.to, section: q.section ?? null, sheets: sheets.map((x) => x.name), people: people.length, days: rows.length,
          filters: { departmentId: q.departmentId ?? null, locationId: q.locationId ?? null, designationId: q.designationId ?? null, hrWorkspaceId: q.hrWorkspaceId ?? null, employeeId: q.employeeId ?? null, level: q.level ?? null, modes: q.modes ?? [], status: q.status ?? null, verification: q.verification ?? null, employeeIds: q.employeeIds?.length ?? 0, departmentIds: q.departmentIds?.length ?? 0, q: q.q ?? null },
          level: v.level,
        },
      });
      const base = `${own ? 'my-attendance' : 'attendance-report'}-${q.from}-to-${q.to}`;
      if (q.format === 'csv') {
        const lines = [registerHead, ...rows.map(registerRow)].map((r) => r.map((c) => csvCell(cellText(c))).join(',')).join('\r\n') + '\r\n';
        return { fileName: `${base}.csv`, content: '﻿' + lines, contentType: 'text/csv; charset=utf-8', rows: rows.length };
      }
      return { fileName: `${base}.xlsx`, content: toXlsxBook(sheets), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', rows: rows.length };
    });
  }

  // ---------------------------------------------------------------------------------------------------------- saved reports

  savedReports() {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => (await tx.collection('attendance_saved_reports').find({ membership_id: actor.membershipId }, { sort: { name: 1 } })).map((r) => ({ id: r.id, name: r.name, filters: r.filters, updatedAt: r.updated_at })));
  }

  saveReport(input: z.infer<typeof savedReportInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:read', undefined, tx);
      if ((await tx.collection('attendance_saved_reports').count({ membership_id: actor.membershipId })) >= 50) throw Errors.conflict('too_many', 'You can save up to 50 report filters. Delete one first.');
      const existing = (await tx.collection('attendance_saved_reports').find({ membership_id: actor.membershipId })).find((r) => String(r.name).toLowerCase() === input.name.toLowerCase());
      if (existing) await tx.collection('attendance_saved_reports').updateOne({ id: existing.id }, { $set: { filters: input.filters, name: input.name } });
      else await tx.collection('attendance_saved_reports').insert({ membership_id: actor.membershipId, name: input.name, filters: input.filters });
      return this.savedReportsIn(tx, actor.membershipId);
    });
  }

  private async savedReportsIn(tx: TenantTx, membershipId: string) {
    return (await tx.collection('attendance_saved_reports').find({ membership_id: membershipId }, { sort: { name: 1 } })).map((r) => ({ id: r.id, name: r.name, filters: r.filters, updatedAt: r.updated_at }));
  }

  deleteReport(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('attendance_saved_reports').deleteOne({ id, membership_id: actor.membershipId }))) throw Errors.notFound('Saved report');
    });
  }
}
