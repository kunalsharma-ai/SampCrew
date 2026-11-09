import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Me, Page } from '@/lib/types';
import { AuditView, type AuditEvent } from './audit-view';

export const metadata: Metadata = { title: 'Audit trail' };

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string; action?: string; resourceType?: string; cursor?: string }> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams({ limit: '50' });
  for (const k of ['q', 'action', 'resourceType', 'cursor'] as const) if (sp[k]) qs.set(k, sp[k]!);
  const [me, events] = await Promise.all([load<Me>('/me'), load<Page<AuditEvent>>(`/audit-events?${qs}`)]);
  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Every change in this workspace, who made it and when. Entries cannot be edited or deleted, and each one is chained to the previous one by a hash so tampering is detectable."
      />
      <AuditView page={events} query={{ q: sp.q ?? '', action: sp.action ?? '', resourceType: sp.resourceType ?? '' }} hasCursor={Boolean(sp.cursor)} canExport={me.features.includes('audit_export')} />
    </>
  );
}
