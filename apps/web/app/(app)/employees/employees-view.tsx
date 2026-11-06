'use client';
import type { SavedView, ViewState } from '@crew/contracts';
import { Alert, Avatar, Button, Card, type DataColumn, DataTable, EmptyState, Input, Select, buttonClass } from '@crew/ui';
import { Contact, Copy, Download, FilePen, Search, Trash2, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { SavedViews } from '@/components/saved-views';
import { photoUrl } from '@/lib/photo';
import { useCreateParam } from '@/lib/use-create-param';
import type { Department, Designation, Employee, LegalEntity, Location, OnboardingTemplate, Page } from '@/lib/types';
import type { Structure } from '../payroll/types';
import type { DeviceOption, ShiftOption } from './[id]/profile-extras';
import { TemporaryPassword } from './[id]/profile-extras';
import { discardHireDraftAction } from './actions';
import { type EmployeeDraft, HIRE_STEPS, HireWizard } from './hire-wizard';
import { EmployeeStatus } from './status';
import { DEFAULT_COLUMNS, viewUrl } from './view-url';

export type { EmployeeDraft };
const TYPE_LABEL: Record<string, string> = { full_time: 'Full time', part_time: 'Part time', contract: 'Contract', intern: 'Intern', temporary: 'Temporary' };
const muted = (v: string | null | undefined) => <span className="text-fg-muted">{v ?? '—'}</span>;
const COLUMNS: DataColumn<Employee>[] = [
  {
    key: 'name', label: 'Name', sort: 'name', required: true,
    render: (e) => (
      <Link href={`/employees/${e.id}`} className="flex items-center gap-3" onClick={(ev) => ev.stopPropagation()}>
        <Avatar name={e.displayName} size={32} src={photoUrl(e)} />
        <span>
          <span className="block font-medium">{e.displayName}</span>
          <span className="block text-xs text-fg-subtle">{e.designationName ?? 'No designation'}{e.membershipId ? '' : ' · no SampCrew login'}</span>
        </span>
      </Link>
    ),
  },
  { key: 'code', label: 'Code', sort: 'code', className: 'font-mono text-xs text-fg-muted', render: (e) => e.employeeCode },
  { key: 'designation', label: 'Designation', render: (e) => muted(e.designationName) },
  { key: 'department', label: 'Department', sort: 'department', render: (e) => muted(e.departmentName) },
  { key: 'location', label: 'Location', sort: 'location', render: (e) => muted(e.locationName) },
  { key: 'entity', label: 'Legal entity', render: (e) => muted(e.legalEntityName) },
  { key: 'manager', label: 'Manager', render: (e) => muted(e.managerName) },
  { key: 'workEmail', label: 'Work email', render: (e) => muted(e.workEmail) },
  { key: 'type', label: 'Employment type', render: (e) => muted(TYPE_LABEL[e.employmentType] ?? e.employmentType) },
  { key: 'joined', label: 'Joined', sort: 'joined', className: 'whitespace-nowrap', render: (e) => muted(e.dateOfJoining) },
  { key: 'status', label: 'Status', sort: 'status', render: (e) => <EmployeeStatus status={e.status} /> },
];

interface Props {
  page: Page<Employee> & { total?: number };
  state: ViewState;
  cursor: string | null;
  views: SavedView[];
  activeViewId: string | null;
  departments: Department[];
  entities: LegalEntity[];
  locations: Location[];
  designations: Designation[];
  managers: Employee[];
  templates: OnboardingTemplate[];
  drafts: EmployeeDraft[];
  structures: Structure[];
  canHire: boolean;
  canPay: boolean;
  canDocs: boolean;
  shifts: ShiftOption[] | null;
  devices: DeviceOption[] | null;
  canManageOrg: boolean;
  canAttendance: boolean;
  canConfigureShifts: boolean;
  setupPending: boolean;
}

export type HireDone = { inviteUrl: string | null; warnings: string[]; name: string; login?: { email: string; temporaryPassword: string } | null };

export function EmployeesView(props: Props) {
  const { page, state, departments, canHire, drafts } = props;
  const router = useRouter();
  const [hireOpen, setHireOpen] = useCreateParam('employee');
  const [draft, setDraft] = useState<EmployeeDraft | null>(null);
  const [done, setDone] = useState<HireDone | null>(null);
  const [login, setLogin] = useState<{ email: string; temporaryPassword: string } | null>(null);
  const [, start] = useTransition();
  const filters = state.filters ?? {};
  // Every change keeps the active view selected; the menu shows when it no longer matches what is saved.
  const go = (patch: Partial<ViewState>) => router.push(viewUrl({ ...state, ...patch }, props.activeViewId));
  const filter = (patch: Record<string, string>) => go({ filters: { ...filters, ...patch } });
  const exportQs = new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), sort: state.sort ?? 'name', dir: state.dir ?? 'asc', columns: (state.columns ?? DEFAULT_COLUMNS).join(',') });
  const filtered = Object.values(filters).some(Boolean);
  const shown = page.items.length;
  return (
    <>
      {props.setupPending && (
        <Alert tone="info" title="Finish your company setup first" className="mb-4">
          {props.canManageOrg
            ? <>Add your company details, departments and designations so every new employee can be placed properly. <Link className="font-medium text-accent hover:underline" href="/setup">Open company setup</Link></>
            : 'Your workspace administrator has not finished the company setup yet, so departments and designations may be missing.'}
        </Alert>
      )}
      {done?.inviteUrl && (
        <Alert tone="info" title="Invitation queued" className="mb-4">
          An invitation email has been queued. If email delivery is not configured in this environment, share this one-time link instead:
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-[0.6875rem] text-fg">{done.inviteUrl}</code>
            <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(done.inviteUrl!)}><Copy className="size-3.5" /> Copy</Button>
          </div>
        </Alert>
      )}
      {done && done.warnings.length > 0 && (
        <Alert tone="warning" title={`${done.name} was added, with something left to finish`} className="mb-4">
          <ul className="list-disc pl-5">{done.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          Finish these from their profile.
        </Alert>
      )}
      {canHire && drafts.length > 0 && (
        <Card className="mb-4" aria-label="Unfinished hires">
          <div className="flex items-center gap-2 border-b border-border px-5 py-2.5 text-[0.8125rem] font-medium"><FilePen className="size-4 text-fg-subtle" /> Unfinished hires</div>
          <ul className="divide-y divide-border">
            {drafts.map((d) => {
              const who = [d.data.firstName, d.data.lastName].filter(Boolean).join(' ') || 'Unnamed';
              return (
                <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-[0.8125rem]">
                  <span className="font-medium">{who}</span>
                  <span className="text-fg-subtle">Next: {HIRE_STEPS[Math.min(d.step, HIRE_STEPS.length - 1)]} · saved {new Date(d.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  <span className="flex-1" />
                  <Button size="sm" variant="secondary" onClick={() => { setDraft(d); setHireOpen(true); }} aria-label={`Resume hiring ${who}`}>Resume</Button>
                  <Button size="sm" variant="ghost" onClick={() => start(async () => { await discardHireDraftAction(d.id); router.refresh(); })} aria-label={`Discard draft for ${who}`}><Trash2 className="size-3.5" /></Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <Card>
        <DataTable
          label="Employees"
          columns={COLUMNS}
          visible={state.columns ?? DEFAULT_COLUMNS}
          onVisibleChange={(columns) => go({ columns })}
          rows={page.items}
          rowKey={(e) => e.id}
          onRowClick={(e) => router.push(`/employees/${e.id}`)}
          sort={state.sort}
          dir={state.dir}
          onSort={(sort, dir) => go({ sort, dir })}
          density={state.density}
          onDensityChange={(density) => go({ density })}
          toolbar={
            <>
              <form className="relative min-w-48 flex-1" onSubmit={(e) => { e.preventDefault(); filter({ q: String(new FormData(e.currentTarget).get('q') ?? '') }); }}>
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
                <Input key={filters.q ?? ''} name="q" defaultValue={filters.q ?? ''} placeholder="Search by name, employee code or email" className="pl-9" aria-label="Search employees" />
              </form>
              {departments.length > 0 && (
                <Select value={filters.departmentId ?? ''} onChange={(e) => filter({ departmentId: e.target.value })} className="sm:w-44" aria-label="Filter by department">
                  <option value="">All departments</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              )}
              <Select value={filters.status ?? ''} onChange={(e) => filter({ status: e.target.value })} className="sm:w-40" aria-label="Filter by status">
                <option value="">Current staff</option>
                <option value="pre_boarding">Joining soon</option>
                <option value="probation">On probation</option>
                <option value="active">Confirmed</option>
                <option value="notice">Serving notice</option>
                <option value="exited">Left</option>
              </Select>
            </>
          }
          actions={
            <>
              <SavedViews
                page="employees"
                allLabel="All employees"
                views={props.views}
                activeId={props.activeViewId}
                current={state}
                onApply={(v) => router.push(v ? viewUrl(v.state, v.id) : '/employees?view=all')}
              />
              <a className={buttonClass('secondary', 'sm')} href={`/employees-export?${exportQs}`} download>
                <Download className="size-3.5" /> Export CSV
              </a>
              <a className={buttonClass('secondary', 'sm')} href={`/employees-export?${exportQs}&format=xlsx`} download>
                <Download className="size-3.5" /> Export Excel
              </a>
              {canHire && (props.setupPending && props.canManageOrg
                ? <Link className={buttonClass('primary', 'sm')} href="/setup"><UserPlus className="size-4" /> Add employee</Link>
                : <Button size="sm" onClick={() => { setDraft(null); setHireOpen(true); }}><UserPlus className="size-4" /> Add employee</Button>)}
            </>
          }
          empty={<EmptyState icon={<Contact className="size-5" />} title={filtered ? 'No one matches these filters' : 'No employee records yet'} description={canHire ? 'Add employees one by one with the guided hire. Bulk import arrives with the data migration tools.' : undefined} />}
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-[0.8125rem] text-fg-muted">
              <span>{page.total !== undefined ? `${shown} shown of ${page.total}` : `${shown} shown`}{props.cursor ? ' (later page)' : ''}</span>
              <span className="flex gap-4">
                {props.cursor && <Link className="font-medium text-accent hover:underline" href={viewUrl(state, props.activeViewId)}>First page</Link>}
                {page.nextCursor && <Link className="font-medium text-accent hover:underline" href={`${viewUrl(state, props.activeViewId)}&cursor=${encodeURIComponent(page.nextCursor)}`}>Next page</Link>}
              </span>
            </div>
          }
        />
      </Card>
      {canHire && (
        <HireWizard
          {...props}
          open={hireOpen}
          draft={draft}
          onClose={() => { setHireOpen(false); setDraft(null); }}
          onDone={(d) => { setDone(d); if (d.login) setLogin(d.login); }}
        />
      )}
      <TemporaryPassword login={login} onClose={() => setLogin(null)} />
    </>
  );
}
