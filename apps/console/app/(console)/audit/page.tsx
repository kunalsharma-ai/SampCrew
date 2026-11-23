import type { ConsoleAuditRow } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { AuditLogView } from '@/components/audit-log';
import { auditFiltersFrom } from '@/lib/audit-filters';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';

export const metadata: Metadata = { title: 'Audit log' };

/** Every privileged action in the Console (and, on request, inside client workspaces), with before and after values. */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const f = auditFiltersFrom(await searchParams);
  const qs = new URLSearchParams({ ...f, limit: '50' } as Record<string, string>);
  const [me, data] = await Promise.all([load<Admin>('/platform/auth/me'), load<{ items: ConsoleAuditRow[]; next: string | null }>(`/platform/audit-log?${qs}`)]);
  return (
    <>
      <PageHeader title="Audit log" description="Who did what and when, from which IP and device, with before and after values. Records are hash-chained and cannot be edited. Changes inside client workspaces show their values only to roles that may see contact details." />
      <AuditLogView data={data} filters={f} basePath="/audit" canExport={hasCap(me, 'audit:export')} />
    </>
  );
}
