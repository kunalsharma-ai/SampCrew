import type { ConsoleAuditRow } from '@crew/contracts';
import { Alert } from '@crew/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AuditLogView, auditFiltersFrom } from '@/components/audit-log';
import { load } from '@/lib/api';
import { ClientHeader } from '../client-header';
import { loadClient } from '../load-client';

export const metadata: Metadata = { title: 'Company activity' };

/** What happened to this company: Console actions on it and its Super Workspaces, and optionally inside them. */
export default async function ClientActivityPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const r = await loadClient(id);
  if (!r) notFound();
  const { c, caps } = r;
  if (!caps.includes('audit:read')) return <><ClientHeader c={c} current="activity" caps={caps} /><Alert tone="warning">Your role cannot read the audit log.</Alert></>;
  const f = { ...auditFiltersFrom(sp), clientId: id };
  const data = await load<{ items: ConsoleAuditRow[]; next: string | null }>(`/platform/audit-log?${new URLSearchParams({ ...f, limit: '50' } as Record<string, string>)}`);
  const { clientId: _c, ...shown } = f;
  return (
    <>
      <ClientHeader c={c} current="activity" caps={caps} />
      <AuditLogView data={data} filters={shown} basePath={`/clients/${id}/activity`} canExport={false} compact />
    </>
  );
}
