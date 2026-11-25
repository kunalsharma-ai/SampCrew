import { Card, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { ClipboardList } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ApiError, api, load, loadOptional } from '@/lib/api';
import { dateLabel } from '@/lib/attendance-period';
import type { Department, Location, Me, WorkModeLabels } from '@/lib/types';
import { ModeBadge, hoursLabel } from '@/components/work-mode/parts';
import { ReportButton } from '@/components/work-mode/report-dialog';
import { RealtimeRefresh } from '@/components/work-mode/realtime-refresh';
import { Pager } from '../../overview-parts';
import { pickFilters, toQs, WorkforceFilters } from '../filters';
import { VerifyButton } from './verify-dialog';

export const metadata: Metadata = { title: 'Work-mode register' };

export interface RegisterRow {
  employeeId: string; name: string; code: string; level: string; department: string | null; designation: string | null; location: string | null; hrWorkspace: string;
  date: string; status: string; statusLabel: string; mode: string | null; modeLabel: string | null; provisional: boolean; corrected: { by: string | null; reason: string; source: string } | null;
  checkIn: string | null; checkOut: string | null; checkInPlace: string | null; checkOutPlace: string | null; checkInZone: string | null; checkOutZone: string | null;
  verified: boolean | null; workedMinutes: number; officeMinutes: number; remoteMinutes: number; unverifiedMinutes: number; lateMinutes: number; earlyLeaveMinutes: number; places: string[]; issues: string[];
}
const ISSUE: Record<string, string> = {
  location_unverified: 'Location not verified', missing_check_out: 'Missing check-out', missing_check_in: 'Missing check-in', short_remote_stay: 'Short time away', short_office_stay: 'Short office time',
};
const ZONE: Record<string, string> = { office: 'Office', remote: 'Away', unverified: 'Not verified', neutral: 'Correction' };
const MODES = ['office', 'remote', 'hybrid', 'pending_verification'];
const STATUSES: [string, string][] = [['present', 'Present'], ['absent', 'Absent'], ['leave', 'On leave'], ['incomplete', 'Incomplete'], ['late', 'Late'], ['early_leave', 'Left early'], ['irregular', 'Irregular'], ['pending', 'Pending verification']];
const iso = (v?: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') ? v : undefined);

/** HR's register: every day of every visible person, where it was worked, why, and verification or correction. */
export default async function WorkRegisterPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: me.tenant.timezone });
  const to = iso(sp.to) ?? today;
  const from = iso(sp.from) ?? new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  const filters = pickFilters(sp);
  const modes = (sp.modes ?? (sp.category === 'pending' ? 'pending_verification' : '')).split(',').filter((m) => MODES.includes(m));
  const status = STATUSES.some(([k]) => k === sp.status) ? sp.status : undefined;
  const verification = sp.verification === 'verified' || sp.verification === 'unverified' ? sp.verification : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  let data: { rows: RegisterRow[]; total: number; page: number; pageSize: number; labels: WorkModeLabels; canVerify?: boolean };
  try {
    data = await api(`/attendance/work-mode/register${toQs({ from, to: to < from ? from : to, ...filters, modes: modes.join(',') || undefined, status, verification, page: String(page), pageSize: '50' })}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) redirect('/attendance');
    throw e;
  }
  const [departments, designations, locations, spaces] = await Promise.all([
    loadOptional<Department[]>('/org/departments'),
    loadOptional<{ id: string; name: string }[]>('/designations'),
    loadOptional<Location[]>('/org/locations'),
    loadOptional<{ rows: { id: string; name: string }[] }>(`/attendance/overview/hr-workspaces?from=${to}&to=${to}`),
  ]);
  const L = data.labels;
  const keep = { from, to, ...filters, modes: modes.join(',') || undefined, status, verification };
  const sel = 'h-9 rounded-md border border-border bg-surface px-2';
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/attendance/work-mode" className="hover:underline">Workforce attendance</Link>}
        title="Work-mode register"
        description={`${dateLabel(from)} to ${dateLabel(to)}. Each day with where it was worked. Verify days waiting for verification and correct any day with a reason; every change is kept in the day's history.`}
        actions={<ReportButton from={from} to={to} today={today} filters={{ ...filters, modes: modes.join(',') || undefined, status, verification }} section="work-mode-register" labels={L} />}
      />
      <RealtimeRefresh />
      <WorkforceFilters path="/attendance/work-mode/register" dateMode="range" values={{ from, to, ...filters }} departments={departments ?? []} designations={designations ?? []} locations={locations ?? []} spaces={spaces?.rows ?? []}
        extra={<>
          <label className="grid gap-1"><span className="text-xs text-fg-muted">Category</span>
            <select className={sel} name="modes" defaultValue={modes.length === 1 ? modes[0] : ''}><option value="">All</option><option value="office">{L.office}</option><option value="remote">{L.remote}</option><option value="hybrid">{L.hybrid}</option><option value="pending_verification">Pending verification</option></select></label>
          <label className="grid gap-1"><span className="text-xs text-fg-muted">Status</span>
            <select className={sel} name="status" defaultValue={status ?? ''}><option value="">All</option>{STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="grid gap-1"><span className="text-xs text-fg-muted">Location check</span>
            <select className={sel} name="verification" defaultValue={verification ?? ''}><option value="">All</option><option value="verified">Verified</option><option value="unverified">Not verified</option></select></label>
        </>} />
      <Card data-testid="work-register">
        {data.rows.length === 0 ? <EmptyState icon={<ClipboardList className="size-5" />} title="No days match" description="Change the dates or filters." /> : (
          <>
            <Table>
              <THead><TR><TH>Date</TH><TH>Employee</TH><TH>Where</TH><TH>Check-in</TH><TH>Check-out</TH><TH className="text-right">Office</TH><TH className="text-right">Away</TH><TH>Notes</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
              <TBody>
                {data.rows.map((r) => (
                  <TR key={`${r.employeeId}-${r.date}`} data-testid="register-row">
                    <TD className="whitespace-nowrap"><Link className="font-medium hover:underline" href={`/attendance/day/${r.employeeId}/${r.date}`}>{dateLabel(r.date)}</Link><div className="text-xs text-fg-subtle">{r.statusLabel}</div></TD>
                    <TD><span className="font-medium text-fg">{r.name}</span><div className="text-xs text-fg-subtle">{[r.code, r.department].filter(Boolean).join(' · ')}</div></TD>
                    <TD><ModeBadge mode={r.mode} labels={L} provisional={r.provisional} corrected={Boolean(r.corrected)} />{r.corrected && <div className="mt-0.5 max-w-[14rem] truncate text-xs text-fg-subtle" title={r.corrected.reason}>{r.corrected.by ? `${r.corrected.by}: ` : ''}{r.corrected.reason}</div>}</TD>
                    <TD className="tabular">{r.checkIn ?? '-'}<div className="text-xs text-fg-subtle">{r.checkInPlace ?? (r.checkInZone ? ZONE[r.checkInZone] : '')}</div></TD>
                    <TD className="tabular">{r.checkOut ?? '-'}<div className="text-xs text-fg-subtle">{r.checkOutPlace ?? (r.checkOutZone ? ZONE[r.checkOutZone] : '')}</div></TD>
                    <TD className="tabular text-right">{hoursLabel(r.officeMinutes)}</TD>
                    <TD className="tabular text-right">{hoursLabel(r.remoteMinutes)}</TD>
                    <TD className="text-xs text-fg-muted">{[...r.issues.map((i) => ISSUE[i] ?? i), r.lateMinutes ? `${r.lateMinutes} min late` : null].filter(Boolean).join(', ') || '-'}</TD>
                    <TD className="text-right">{data.canVerify && r.mode && r.employeeId !== me.employee?.id && <VerifyButton row={r} labels={L} />}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} href={(n) => `/attendance/work-mode/register${toQs({ ...keep, page: String(n) })}`} />
          </>
        )}
      </Card>
    </>
  );
}
