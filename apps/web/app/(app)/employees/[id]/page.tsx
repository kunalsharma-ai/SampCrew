import { Avatar, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, api, load, loadOptional } from '@/lib/api';
import type { Department, Designation, Employee, EmployeeDocument, EmployeeProfile, JobRecord, LeaveBalance, LeaveRequest, LegalEntity, LifecycleEvent, Location, OnboardingTask, Page } from '@/lib/types';
import { EmployeeStatus } from '../status';
import { DocumentsTab, JobTab, LeaveTab, OnboardingTab, OverviewTab } from './tabs';

export const metadata: Metadata = { title: 'Employee' };

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'job', label: 'Job & history' },
  { key: 'leave', label: 'Leave' },
  { key: 'documents', label: 'Documents' },
  { key: 'onboarding', label: 'Onboarding' },
] as const;

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const { tab: rawTab } = await searchParams;
  let e: EmployeeProfile;
  try {
    e = await api<EmployeeProfile>(`/employees/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return load<never>(`/employees/${id}`);
  }
  const tabs = TABS.filter((t) => (t.key === 'documents' ? e.can.readDocuments : t.key === 'leave' ? e.can.readLeave : true));
  const tab = tabs.find((t) => t.key === rawTab)?.key ?? 'overview';

  let content: React.ReactNode;
  if (tab === 'overview') {
    content = <OverviewTab e={e} />;
  } else if (tab === 'job') {
    const [history, reports, departments, entities, locations, designations, managers] = await Promise.all([
      load<{ records: JobRecord[]; events: LifecycleEvent[] }>(`/employees/${id}/history`),
      load<Employee[]>(`/employees/${id}/reports`),
      e.can.lifecycle ? loadOptional<Department[]>('/org/departments') : null,
      e.can.lifecycle ? loadOptional<LegalEntity[]>('/org/legal-entities') : null,
      e.can.lifecycle ? loadOptional<Location[]>('/org/locations') : null,
      e.can.lifecycle ? loadOptional<Designation[]>('/designations') : null,
      e.can.lifecycle ? loadOptional<Page<Employee>>('/employees?limit=200') : null,
    ]);
    content = (
      <JobTab
        e={e} history={history} reports={reports} departments={departments ?? []} entities={entities ?? []} locations={locations ?? []}
        designations={designations ?? []} managers={(managers?.items ?? []).filter((m) => m.id !== e.id)}
      />
    );
  } else if (tab === 'leave') {
    const [balances, requests] = await Promise.all([
      load<{ year: number; balances: LeaveBalance[] }>(`/leave/balances?employeeId=${id}`),
      load<LeaveRequest[]>(`/leave/requests?scope=visible&employeeId=${id}&limit=50`),
    ]);
    content = <LeaveTab balances={balances} requests={requests} />;
  } else if (tab === 'documents') {
    content = <DocumentsTab e={e} documents={await load<EmployeeDocument[]>(`/employees/${id}/documents`)} />;
  } else {
    content = <OnboardingTab e={e} tasks={await load<OnboardingTask[]>(`/onboarding/employees/${id}/tasks`)} />;
  }

  return (
    <>
      <div className="mb-2 text-[13px]"><Link href="/employees" className="text-fg-subtle hover:text-fg">Employees</Link></div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Avatar name={e.displayName} size={44} />
            <span>
              <span className="block">{e.displayName}</span>
              <span className="block text-sm font-normal text-fg-muted">{[e.designationName, e.departmentName, e.locationName].filter(Boolean).join(' · ') || 'No placement yet'}</span>
            </span>
          </span>
        }
        actions={<span className="flex items-center gap-2"><span className="font-mono text-xs text-fg-subtle">{e.employeeCode}</span><EmployeeStatus status={e.status} /></span>}
      />
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-border" aria-label="Employee sections">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/employees/${id}?tab=${t.key}`}
            aria-current={t.key === tab ? 'page' : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px] ${t.key === tab ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg'}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {content}
    </>
  );
}
