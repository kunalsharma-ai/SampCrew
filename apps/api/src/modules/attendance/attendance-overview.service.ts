import { Injectable } from '@nestjs/common';
import {
  ATTENDANCE_BUCKET_LABEL,
  ATTENDANCE_EXPORT_MAX_ROWS, ATTENDANCE_REPORT_MAX_ROWS,
  ACCESS_LEVEL_LABEL,
  CENTRAL_GROUP,
  DAY_STATUS_LABEL,
  attendanceTotals,
  bucketOf,
  statusesOf,
  sumTotals,
  zonedTime,
  type AttendanceBucket,
  type AttendanceExportQuery,
  type AttendanceHrWorkspaceRow,
  type AttendanceOverview,
  type AttendancePeopleQuery,
  type AttendancePersonRow,
  type AttendanceRecordRow,
  type AttendanceRecordsQuery,
  type AttendanceTotals,
  type AttendanceTrendPoint,
  type AttendanceViewerLevel,
  type Paged,
  type StatusCounts,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { renderTableDocx } from '../../platform/export/table-docx';
import { renderTablePdf } from '../../platform/export/table-pdf';
import { type Cell, toXlsxBook } from '../../platform/export/tabular';
import { csv } from '../payroll/payroll-common';
import { Errors } from '../../platform/http/errors';
import { displayName, fieldById } from '../employees/employee-view';
import { AttendanceAccessService, type AttendanceViewer } from './attendance-access.service';
import { AttendanceService } from './attendance.service';

const { addDays, localToday } = zonedTime;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

interface Filters {
  hrWorkspaceId?: string;
  employeeId?: string;
  /** Only these people (the export's "chosen employees"). */
  employeeIds?: string[];
  level?: AttendanceViewerLevel;
  q?: string;
}

/** One visible person with what the overview needs about them. */
interface Person {
  id: string;
  name: string;
  code: string;
  level: AttendanceViewerLevel;
  hrWorkspaceId: string | null;
  /** The groups the person belongs to: where they are placed, and the HR Workspaces they look after. */
  groups: string[];
  departmentId: string | null;
  membershipId: string | null;
  joined: string;
  left: string | null;
  tz: string;
  doc: Doc;
}

interface PersonStats {
  counts: StatusCounts;
  late: number;
  stored: number;
}

const MAX_PEOPLE = 5000;
/** Missing days are counted on a view for at most this many people and this long a period per request. */
const BACKFILL_MAX_PEOPLE = 300;
const BACKFILL_MAX_DAYS = 92;
const LEVEL_WORKSPACE: Record<AttendanceViewerLevel, string> = { super: ACCESS_LEVEL_LABEL.super_workspace, hr: ACCESS_LEVEL_LABEL.hr_workspace, employee: ACCESS_LEVEL_LABEL.employee_workspace };
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' });
const dayName = (d: string) => WEEKDAY.format(new Date(`${d}T00:00:00Z`));
const clockIn = (at: Date | null | undefined, tz: string) =>
  at ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(at) : null;
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

/**
 * The attendance overview for every level: the person's own attendance, the HR Workspace and Employee Workspace
 * sections, date-wise records and the Excel export. Every number is counted from the stored attendance days (the
 * single source of truth the attendance engine writes); who is included always comes from AttendanceAccessService.
 */
@Injectable()
export class AttendanceOverviewService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AttendanceAccessService,
    private readonly attendance: AttendanceService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------------------------- people and counts

  private async today(tx: TenantTx) {
    const tenant = await tx.collection('tenants').findOne({});
    return { today: localToday((tenant?.timezone as string) ?? 'UTC'), tz: (tenant?.timezone as string) ?? 'UTC' };
  }

  private async groupNames(tx: TenantTx): Promise<Map<string, { name: string; code: string | null; status: string }>> {
    const rows = await tx.collection('hr_workspaces').find({}, { projection: { name: 1, code: 1, status: 1 } });
    const out = new Map<string, { name: string; code: string | null; status: string }>([[CENTRAL_GROUP, { name: 'Central group', code: null, status: 'active' }]]);
    for (const w of rows) out.set(w.id as string, { name: w.name as string, code: (w.code as string | null) ?? null, status: w.status as string });
    return out;
  }

  /** Everyone the viewer may see who was employed at some point in the period, narrowed by the filters. */
  private async people(tx: TenantTx, v: AttendanceViewer, from: string, to: string, f: Filters): Promise<Person[]> {
    const and: Doc[] = [await this.access.visibleFilter(tx, v), { date_of_joining: { $lte: to } }, { $or: [{ last_working_day: null }, { last_working_day: { $gte: from } }] }];
    if (f.employeeId) and.push({ id: f.employeeId });
    if (f.employeeIds?.length) and.push({ id: { $in: f.employeeIds } });
    if (f.hrWorkspaceId) and.push(this.access.groupFilter(v, [f.hrWorkspaceId]));
    const docs = await tx.collection('employees').find({ $and: and }, { limit: MAX_PEOPLE, sort: { first_name: 1, last_name: 1 } });
    const tenant = await tx.collection('tenants').findOne({});
    const locationTz = await fieldById(tx, 'locations', docs.map((e) => e.current_location_id), 'timezone');
    const entityTz = await fieldById(tx, 'legal_entities', docs.map((e) => e.current_legal_entity_id), 'timezone');
    const adminOf = new Map<string, string[]>();
    for (const [g, ms] of v.adminsByGroup) for (const m of ms) adminOf.set(m, [...(adminOf.get(m) ?? []), g]);
    let out = docs.map((e): Person => {
      const m = (e.membership_id as string | null) ?? null;
      const level: AttendanceViewerLevel = m && v.superMemberships.has(m) ? 'super' : m && v.hrMemberships.has(m) ? 'hr' : 'employee';
      const placed = (e.hr_workspace_id as string | null) ?? CENTRAL_GROUP;
      return {
        id: e.id, name: displayName(e as never), code: e.employee_code ?? '', level,
        hrWorkspaceId: (e.hr_workspace_id as string | null) ?? null,
        groups: [...new Set([placed, ...(level === 'hr' && m ? (adminOf.get(m) ?? []) : [])])],
        departmentId: e.current_department_id ?? null, membershipId: m,
        joined: e.date_of_joining, left: e.last_working_day ?? null,
        tz: locationTz.get(e.current_location_id) ?? entityTz.get(e.current_legal_entity_id) ?? ((tenant?.timezone as string) ?? 'UTC'),
        doc: e,
      };
    });
    if (f.level) out = out.filter((p) => p.level === f.level);
    if (f.q) {
      const needle = f.q.toLowerCase();
      out = out.filter((p) => `${p.name} ${p.code}`.toLowerCase().includes(needle));
    }
    return out;
  }

  /** Stored days per person and status in the period up to today (days still ahead are not attendance yet). */
  private async stats(tx: TenantTx, people: Person[], from: string, until: string, today: string): Promise<Map<string, PersonStats>> {
    const out = new Map<string, PersonStats>(people.map((p) => [p.id, { counts: {}, late: 0, stored: 0 }]));
    const to = until < today ? until : today;
    if (!people.length || from > to) return out;
    const count = () => tx.collection('attendance_days').aggregate<{ id: { e: string; s: string }; n: number; late: number }>([
      { $match: { employee_id: { $in: people.map((p) => p.id) }, work_date: { $gte: from, $lte: to }, status: { $ne: 'not_joined' } } },
      { $group: { _id: { e: '$employee_id', s: '$status' }, n: { $sum: 1 }, late: { $sum: { $cond: [{ $gt: ['$late_minutes', 0] }, 1, 0] } } } },
    ]);
    let rows = await count();
    // Days never counted (before the person was viewed or the daily refresh ran) are counted now from the raw punches,
    // leave and shifts, so the overview never shows a gap as absence. Bounded per request; the rest show as
    // "not counted yet" and are filled on later views.
    const stored = new Map<string, number>();
    for (const r of rows) stored.set(r.id.e, (stored.get(r.id.e) ?? 0) + r.n);
    const gaps = people.filter((p) => (stored.get(p.id) ?? 0) < this.expectedDays(p, from, to, today));
    if (gaps.length && Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) <= BACKFILL_MAX_DAYS) {
      for (const p of gaps.slice(0, BACKFILL_MAX_PEOPLE)) await this.attendance.recomputeFor(tx, p.id, from, to);
      rows = await count();
    }
    for (const r of rows) {
      const s = out.get(r.id.e);
      if (!s) continue;
      s.counts[r.id.s] = (s.counts[r.id.s] ?? 0) + r.n;
      s.late += r.late;
      s.stored += r.n;
    }
    return out;
  }

  /** Days in the period (inside employment, up to today) a person should have, for "not counted yet". */
  private expectedDays(p: Person, from: string, to: string, today: string) {
    const start = from > p.joined ? from : p.joined;
    let end = to < today ? to : today;
    if (p.left && p.left < end) end = p.left;
    if (start > end) return 0;
    return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  }

  private totalsOf(p: Person, s: PersonStats | undefined, from: string, to: string, today: string): AttendanceTotals {
    // stats() counts days up to today only, so stored and expected cover the same days.
    return attendanceTotals(s?.counts ?? {}, { unmarked: Math.max(0, this.expectedDays(p, from, to, today) - (s?.stored ?? 0)), late: s?.late ?? 0 });
  }

  /** Each person's status on one date (today, refreshed first so it is current). */
  private async statusOn(tx: TenantTx, people: Person[], date: string, refresh: boolean): Promise<Map<string, AttendanceBucket>> {
    const active = people.filter((p) => p.joined <= date && (!p.left || p.left >= date));
    if (refresh && active.length <= 1000) await this.attendance.refreshDate(tx, active.map((p) => p.doc), date);
    const days = active.length ? await tx.collection('attendance_days').find({ employee_id: { $in: active.map((p) => p.id) }, work_date: date }, { projection: { employee_id: 1, status: 1 } }) : [];
    const byId = new Map(days.map((d) => [d.employee_id as string, bucketOf(d.status)]));
    return new Map(active.map((p) => [p.id, byId.get(p.id) ?? 'unmarked']));
  }

  private async trend(tx: TenantTx, people: Person[], from: string, to: string, today: string): Promise<AttendanceTrendPoint[]> {
    if (!people.length) return [];
    const end = to < today ? to : today;
    if (from > end) return [];
    const rows = await tx.collection('attendance_days').aggregate<{ id: { d: string; s: string }; n: number }>([
      { $match: { employee_id: { $in: people.map((p) => p.id) }, work_date: { $gte: from, $lte: end }, status: { $ne: 'not_joined' } } },
      { $group: { _id: { d: '$work_date', s: '$status' }, n: { $sum: 1 } } },
    ]);
    const byDate = new Map<string, StatusCounts>();
    for (const r of rows) byDate.set(r.id.d, { ...(byDate.get(r.id.d) ?? {}), [r.id.s]: r.n });
    const out: AttendanceTrendPoint[] = [];
    for (let d = from; d <= end; d = addDays(d, 1)) {
      const t = attendanceTotals(byDate.get(d) ?? {});
      out.push({ date: d, present: t.present, absent: t.absent, leave: t.leave, percent: t.percent });
    }
    return out;
  }

  private personRow(p: Person, totals: AttendanceTotals, today: AttendanceBucket | null, names: Map<string, { name: string }>, departments: Map<string, string>): AttendancePersonRow {
    return {
      employeeId: p.id, name: p.name, code: p.code, level: p.level, hrWorkspaceId: p.hrWorkspaceId,
      hrWorkspaceName: names.get(p.hrWorkspaceId ?? CENTRAL_GROUP)?.name ?? 'Central group',
      department: (p.departmentId && departments.get(p.departmentId)) || null, today, totals,
    };
  }

  // ---------------------------------------------------------------------------------------------- views

  /** The top of the Attendance page: what the viewer can open, the summary cards and the daily trend. */
  overview(q: { from: string; to: string }): Promise<AttendanceOverview> {
    return this.db.tenant(async (tx) => {
      const v = await this.access.viewer(tx);
      const caps = this.access.capabilities(v);
      const { today } = await this.today(tx);
      // The person's own attendance always comes first, at every level.
      const self = v.employeeId ? await this.people(tx, v, q.from, q.to, { employeeId: v.employeeId }) : [];
      const selfStats = await this.stats(tx, self, q.from, q.to, today);
      const selfNow = await this.statusOn(tx, self, today, true);
      const me = self[0] ? { employeeId: self[0].id, name: self[0].name, totals: this.totalsOf(self[0], selfStats.get(self[0].id), q.from, q.to, today), today: selfNow.get(self[0].id) ?? null } : null;
      if (!caps.employees) {
        return { capabilities: caps, from: q.from, to: q.to, today, me, cards: null, trend: await this.trend(tx, self, q.from, q.to, today) };
      }
      const people = await this.people(tx, v, q.from, q.to, {});
      const stats = await this.stats(tx, people, q.from, q.to, today);
      const now = await this.statusOn(tx, people, today, true);
      const groups = caps.hrWorkspaces ? (await this.access.visibleGroups(tx, v)).filter((g) => g !== CENTRAL_GROUP) : [];
      const count = (b: AttendanceBucket) => [...now.values()].filter((x) => x === b).length;
      return {
        capabilities: caps, from: q.from, to: q.to, today, me,
        cards: {
          hrWorkspaces: caps.hrWorkspaces ? groups.length : null,
          employees: people.length,
          presentToday: count('present') + count('half_day'),
          absentToday: count('absent'),
          onLeaveToday: count('leave'),
          notCountedToday: count('unmarked'),
          totals: sumTotals(people.map((p) => this.totalsOf(p, stats.get(p.id), q.from, q.to, today))),
        },
        trend: await this.trend(tx, people, q.from, q.to, today),
      };
    });
  }

  private async groupRows(tx: TenantTx, v: AttendanceViewer, groups: string[], people: Person[], from: string, to: string, today: string): Promise<AttendanceHrWorkspaceRow[]> {
    const names = await this.groupNames(tx);
    const stats = await this.stats(tx, people, from, to, today);
    const now = await this.statusOn(tx, people, today, true);
    void v;
    return groups.map((g) => {
      const members = people.filter((p) => p.groups.includes(g));
      const n = (b: AttendanceBucket) => members.filter((p) => now.get(p.id) === b).length;
      const info = names.get(g);
      return {
        id: g, name: info?.name ?? 'HR Workspace', code: info?.code ?? null, status: info?.status ?? 'active',
        hrPeople: members.filter((p) => p.level === 'hr').length,
        employees: members.filter((p) => p.level !== 'hr').length,
        presentToday: n('present') + n('half_day'), absentToday: n('absent'), onLeaveToday: n('leave'),
        totals: sumTotals(members.map((p) => this.totalsOf(p, stats.get(p.id), from, to, today))),
      };
    }).sort((a, b) => (a.id === CENTRAL_GROUP ? -1 : b.id === CENTRAL_GROUP ? 1 : a.name.localeCompare(b.name)));
  }

  /** The HR Workspace section: every HR Workspace (and the central group) the viewer may open, with its numbers. */
  hrWorkspaces(q: { from: string; to: string }) {
    return this.db.tenant(async (tx) => {
      const v = await this.access.viewer(tx);
      if (!this.access.capabilities(v).hrWorkspaces) throw Errors.forbidden('Your access does not include other HR Workspace attendance');
      const groups = await this.access.visibleGroups(tx, v);
      const people = await this.people(tx, v, q.from, q.to, {});
      const { today } = await this.today(tx);
      return { from: q.from, to: q.to, today, rows: await this.groupRows(tx, v, groups, people, q.from, q.to, today) };
    });
  }

  /** One HR Workspace: its numbers, daily trend and every person in it the viewer may see. */
  hrWorkspace(id: string, q: { from: string; to: string }) {
    return this.db.tenant(async (tx) => {
      const v = await this.access.viewer(tx);
      if (!this.access.capabilities(v).hrWorkspaces || !(await this.access.visibleGroups(tx, v)).includes(id)) throw Errors.notFound('HR Workspace');
      const people = await this.people(tx, v, q.from, q.to, { hrWorkspaceId: id });
      const { today } = await this.today(tx);
      const [summary] = await this.groupRows(tx, v, [id], people, q.from, q.to, today);
      const stats = await this.stats(tx, people, q.from, q.to, today);
      const now = await this.statusOn(tx, people, today, false);
      const names = await this.groupNames(tx);
      const departments = await fieldById(tx, 'departments', people.map((p) => p.departmentId));
      return {
        from: q.from, to: q.to, today, workspace: summary!,
        trend: await this.trend(tx, people, q.from, q.to, today),
        people: people.map((p) => this.personRow(p, this.totalsOf(p, stats.get(p.id), q.from, q.to, today), now.get(p.id) ?? null, names, departments)),
      };
    });
  }

  private sortRows(rows: AttendancePersonRow[], sort: AttendancePeopleQuery['sort']) {
    const pct = (r: AttendancePersonRow) => r.totals.percent ?? -1;
    if (sort === 'percent') return rows.sort((a, b) => pct(a) - pct(b) || a.name.localeCompare(b.name));
    if (sort === 'absent') return rows.sort((a, b) => b.totals.absent - a.totals.absent || a.name.localeCompare(b.name));
    if (sort === 'present') return rows.sort((a, b) => b.totals.present - a.totals.present || a.name.localeCompare(b.name));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  private matchesStatus(r: AttendancePersonRow, status: AttendanceBucket | undefined) {
    if (!status) return true;
    const t = r.totals;
    const n: Record<AttendanceBucket, number> = { present: t.present, half_day: t.halfDays, absent: t.absent, leave: t.leave, holiday: t.holidays, weekend: t.weekends, unmarked: t.unmarked };
    return n[status] > 0;
  }

  private async personRows(tx: TenantTx, v: AttendanceViewer, q: { from: string; to: string } & Filters & { status?: AttendanceBucket }) {
    const people = await this.people(tx, v, q.from, q.to, q);
    const { today } = await this.today(tx);
    const stats = await this.stats(tx, people, q.from, q.to, today);
    const now = await this.statusOn(tx, people, today, false);
    const names = await this.groupNames(tx);
    const departments = await fieldById(tx, 'departments', people.map((p) => p.departmentId));
    const rows = people.map((p) => this.personRow(p, this.totalsOf(p, stats.get(p.id), q.from, q.to, today), now.get(p.id) ?? null, names, departments)).filter((r) => this.matchesStatus(r, q.status));
    return { rows, people, today };
  }

  /** The Employee Workspace section: one row per visible person with their period totals and today's status. */
  peopleList(q: AttendancePeopleQuery): Promise<Paged<AttendancePersonRow> & { totals: AttendanceTotals }> {
    return this.db.tenant(async (tx) => {
      const v = await this.access.viewer(tx);
      if (!this.access.capabilities(v).employees) throw Errors.forbidden('Your access shows your own attendance only');
      const { rows } = await this.personRows(tx, v, q);
      const sorted = this.sortRows(rows, q.sort);
      const start = (q.page - 1) * q.pageSize;
      return { rows: sorted.slice(start, start + q.pageSize), total: sorted.length, page: q.page, pageSize: q.pageSize, totals: sumTotals(sorted.map((r) => r.totals)) };
    });
  }

  /** Date-wise rows for the visible people (days not counted yet appear when filtering for them). */
  private async recordRows(tx: TenantTx, v: AttendanceViewer, q: { from: string; to: string; status?: AttendanceBucket } & Filters, page: { skip: number; limit: number }) {
    const people = await this.people(tx, v, q.from, q.to, q);
    const { today } = await this.today(tx);
    const names = await this.groupNames(tx);
    const byId = new Map(people.map((p) => [p.id, p]));
    // Count any days not counted yet first, so the rows match the totals on the same screen.
    await this.stats(tx, people, q.from, q.to, today);
    const toRow = (p: Person, date: string, status: string, d?: Doc): AttendanceRecordRow => ({
      employeeId: p.id, name: p.name, code: p.code, hrWorkspaceName: names.get(p.hrWorkspaceId ?? CENTRAL_GROUP)?.name ?? 'Central group', level: p.level,
      date, status: bucketOf(status === 'unmarked' ? null : status), detail: DAY_STATUS_LABEL[status] ?? status,
      firstIn: clockIn(d?.first_in, p.tz), lastOut: clockIn(d?.last_out, p.tz),
      workedMinutes: (d?.worked_minutes as number) ?? 0, lateMinutes: (d?.late_minutes as number) ?? 0, timeZone: p.tz,
    });
    if (q.status === 'unmarked') {
      const ids = people.map((p) => p.id);
      const end = q.to < today ? q.to : today;
      const have = new Set((ids.length ? await tx.collection('attendance_days').find({ employee_id: { $in: ids }, work_date: { $gte: q.from, $lte: end } }, { projection: { employee_id: 1, work_date: 1 } }) : []).map((d) => `${d.employee_id}|${d.work_date}`));
      const all: AttendanceRecordRow[] = [];
      for (let d = end; d >= q.from && all.length < ATTENDANCE_EXPORT_MAX_ROWS; d = addDays(d, -1)) {
        for (const p of people) if (p.joined <= d && (!p.left || p.left >= d) && !have.has(`${p.id}|${d}`)) all.push(toRow(p, d, 'unmarked'));
      }
      return { rows: all.slice(page.skip, page.skip + page.limit), total: all.length };
    }
    const filter: Doc = { employee_id: { $in: people.map((p) => p.id) }, work_date: { $gte: q.from, $lte: q.to }, status: q.status ? { $in: statusesOf(q.status) } : { $ne: 'not_joined' } };
    if (!people.length) return { rows: [], total: 0 };
    const total = await tx.collection('attendance_days').count(filter);
    const days = await tx.collection('attendance_days').find(filter, { sort: { work_date: -1, employee_id: 1 }, skip: page.skip, limit: page.limit });
    return { rows: days.map((d) => toRow(byId.get(d.employee_id)!, d.work_date, d.status, d)), total };
  }

  records(q: AttendanceRecordsQuery): Promise<Paged<AttendanceRecordRow>> {
    return this.db.tenant(async (tx) => {
      const v = await this.access.viewer(tx);
      // Employee Workspace: always their own days, whatever the request asks for.
      const f = v.level === 'employee' ? { ...q, employeeId: v.employeeId ?? '00000000-0000-0000-0000-000000000000', hrWorkspaceId: undefined } : q;
      const { rows, total } = await this.recordRows(tx, v, f, { skip: (q.page - 1) * q.pageSize, limit: q.pageSize });
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  // ---------------------------------------------------------------------------------------------- Excel export

  /**
   * The Excel workbook: the filters applied, only people the viewer may see, the same counting as the screens. Sheets:
   * About (who, when, filters), Employees (period totals), Date-wise (one row per person and day) and, where the
   * viewer has the HR Workspace section, HR Workspaces. Audited.
   */
  export(q: AttendanceExportQuery): Promise<{ fileName: string; content: Buffer | string; rows: number; contentType: string }> {
    return this.db.tenant(async (tx) => {
      const v = await this.access.viewer(tx);
      const caps = this.access.capabilities(v);
      if (!caps.export) throw Errors.forbidden(v.level === 'employee' ? 'Exporting your attendance is turned off for your workspace' : 'Exporting attendance is turned off for your HR Workspace');
      const own = v.level === 'employee';
      if (own && !v.employeeId) throw Errors.badRequest('no_employee_record', 'Your login has no employee record, so there is no attendance to export.');
      const f = own ? { ...q, employeeId: v.employeeId!, employeeIds: undefined, hrWorkspaceId: undefined, level: undefined } : q;
      const report = q.format === 'docx' || q.format === 'pdf';
      const sheets: { name: string; rows: Cell[][] }[] = [];
      const { rows: people } = await this.personRows(tx, v, f);
      // Who each person is (issue #83: the export must say more than a name): department, designation, location, email.
      const docs = await tx.collection('employees').find({ id: { $in: people.map((r) => r.employeeId) } }, { projection: { current_designation_id: 1, current_location_id: 1, work_email: 1, date_of_joining: 1 } });
      const designations = await fieldById(tx, 'designations', docs.map((d) => d.current_designation_id));
      const locations = await fieldById(tx, 'locations', docs.map((d) => d.current_location_id));
      const detail = new Map(docs.map((d) => [d.id as string, {
        designation: designations.get(d.current_designation_id) ?? '', location: locations.get(d.current_location_id) ?? '', email: (d.work_email as string | null) ?? '', joined: (d.date_of_joining as string | null) ?? '',
      }]));
      const departmentOf = new Map(people.map((r) => [r.employeeId, r.department ?? '']));
      const who = (id: string) => detail.get(id) ?? { designation: '', location: '', email: '', joined: '' };
      const pct = (n: number | null) => (n === null ? '' : n);
      const names = await this.groupNames(tx);
      const about: Cell[][] = [
        ['SampCrew attendance export', ''],
        ['Period', `${q.from} to ${q.to}`],
        ['Exported by', LEVEL_WORKSPACE[v.level]],
        ['Exported at (UTC)', new Date().toISOString().slice(0, 16).replace('T', ' ')],
        ['HR Workspace filter', f.hrWorkspaceId ? (names.get(f.hrWorkspaceId)?.name ?? f.hrWorkspaceId) : 'All you can see'],
        ['Status filter', f.status ? ATTENDANCE_BUCKET_LABEL[f.status] : 'All'],
        ['Search', f.q ?? ''],
        ['People', people.length],
        ['Attendance %', 'Present days / working days x 100. Working days are counted days except weekends and holidays; leave is a working day not worked.'],
      ];
      sheets.push({ name: 'About', rows: about });
      if (q.include === 'all' || q.include === 'people') {
        sheets.push({
          name: 'Employees',
          rows: [
            ['Workspace Name', 'Workspace Type', 'Employee Name', 'Employee ID', 'Department', 'Designation', 'Location', 'Work Email', 'Date of Joining', 'Status Today', 'Working Days', 'Present', 'Absent', 'Leave', 'Half Days', 'Holidays', 'Weekends', 'Not Counted Yet', 'Late Days', 'Attendance %'],
            ...people.map((r) => { const w = who(r.employeeId); return [r.hrWorkspaceName, LEVEL_WORKSPACE[r.level], r.name, r.code, r.department ?? '', w.designation, w.location, w.email, w.joined, r.today ? ATTENDANCE_BUCKET_LABEL[r.today] : '', r.totals.workingDays, r.totals.present, r.totals.absent, r.totals.leave, r.totals.halfDays, r.totals.holidays, r.totals.weekends, r.totals.unmarked, r.totals.late, pct(r.totals.percent)]; }),
          ],
        });
      }
      let recordCount = 0;
      if (q.include === 'all' || q.include === 'records') {
        const max = report ? ATTENDANCE_REPORT_MAX_ROWS : ATTENDANCE_EXPORT_MAX_ROWS;
        const { rows, total } = await this.recordRows(tx, v, f, { skip: 0, limit: max });
        if (total > max) throw Errors.badRequest('too_many_rows', `That is ${total} date-wise rows; ${report ? `a ${q.format === 'pdf' ? 'PDF' : 'Word'} report holds up to ${max} (Excel holds more)` : `one file holds up to ${max}`}. Pick a shorter period or fewer people.`);
        recordCount = rows.length;
        const percentOf = new Map(people.map((r) => [r.employeeId, r.totals.percent]));
        sheets.push({
          name: 'Date-wise',
          rows: [
            ['Workspace Name', 'Workspace Type', 'Employee Name', 'Employee ID', 'Department', 'Designation', 'Location', 'Date', 'Day', 'Attendance Status', 'Detail', 'Check-in Time', 'Check-out Time', 'Working Hours', 'Late Minutes', 'Time Zone', 'Attendance % (period)'],
            ...rows.map((r) => { const w = who(r.employeeId); return [r.hrWorkspaceName, LEVEL_WORKSPACE[r.level], r.name, r.code, departmentOf.get(r.employeeId) ?? '', w.designation, w.location, r.date, dayName(r.date), ATTENDANCE_BUCKET_LABEL[r.status], r.detail, r.firstIn ?? '', r.lastOut ?? '', hours(r.workedMinutes), r.lateMinutes, r.timeZone, pct(percentOf.get(r.employeeId) ?? null)]; }),
          ],
        });
      }
      if (caps.hrWorkspaces && !own && (q.include === 'all' || q.include === 'hr_workspaces')) {
        const groups = (await this.access.visibleGroups(tx, v)).filter((g) => !f.hrWorkspaceId || g === f.hrWorkspaceId);
        const all = await this.people(tx, v, q.from, q.to, { hrWorkspaceId: f.hrWorkspaceId });
        const { today } = await this.today(tx);
        const rows = await this.groupRows(tx, v, groups, all, q.from, q.to, today);
        sheets.push({
          name: 'HR Workspaces',
          rows: [
            ['HR Workspace', 'Code', 'Status', 'HR Workspace People', 'Employees', 'Present Today', 'Absent Today', 'On Leave Today', 'Working Days', 'Present', 'Absent', 'Leave', 'Attendance %'],
            ...rows.map((r) => [r.name, r.code ?? '', r.status, r.hrPeople, r.employees, r.presentToday, r.absentToday, r.onLeaveToday, r.totals.workingDays, r.totals.present, r.totals.absent, r.totals.leave, pct(r.totals.percent)]),
          ],
        });
      }
      await this.audit.record(tx, {
        action: 'attendance.exported', resourceType: 'attendance', resourceId: own ? v.employeeId! : 'overview',
        metadata: { from: q.from, to: q.to, include: q.include, format: q.format, hrWorkspaceId: f.hrWorkspaceId ?? null, employeeId: f.employeeId ?? null, employeeIds: f.employeeIds?.length ?? 0, status: f.status ?? null, people: people.length, records: recordCount, level: v.level },
      });
      const label = own ? `my-attendance` : f.hrWorkspaceId ? `attendance-${(names.get(f.hrWorkspaceId)?.name ?? 'hr-workspace').toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : 'attendance';
      const base = `${label}-${q.from}-to-${q.to}`;
      const tables = sheets.filter((x) => x.name !== 'About');
      const subtitle = `${q.from} to ${q.to} · ${people.length} ${people.length === 1 ? 'person' : 'people'} · Exported by ${LEVEL_WORKSPACE[v.level]} on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      if (q.format === 'csv') {
        // One table in a CSV: the date-wise rows when asked for, else the per-person totals.
        const main = tables.find((x) => x.name === 'Date-wise') ?? tables.find((x) => x.name === 'Employees') ?? tables[0];
        return { fileName: `${base}.csv`, content: '\uFEFF' + csv(main?.rows ?? []), rows: recordCount, contentType: 'text/csv; charset=utf-8' };
      }
      if (q.format === 'docx') return { fileName: `${base}.docx`, content: renderTableDocx('Attendance report', subtitle, tables), rows: recordCount, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
      if (q.format === 'pdf') {
        // One table per PDF (landscape pages): the date-wise rows when asked for, else the per-person totals.
        const main = tables.find((x) => x.name === 'Date-wise') ?? tables.find((x) => x.name === 'Employees') ?? tables[0];
        return { fileName: `${base}.pdf`, content: await renderTablePdf(`Attendance report: ${main?.name ?? ''}`, subtitle, main?.rows ?? [[]]), rows: recordCount, contentType: 'application/pdf' };
      }
      return { fileName: `${base}.xlsx`, content: toXlsxBook(sheets), rows: recordCount, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    });
  }
}
