import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { RequestDetail } from '../../types';
import { LiveDocuments } from '../../ui';
import { RequestView } from './request-view';

export const metadata: Metadata = { title: 'Document request' };

export default async function DocumentRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await load<RequestDetail>(`/document-requests/${id}`);
  const from = r.targetType === 'hr_workspace' ? r.hrWorkspace?.name ?? 'an HR Workspace' : r.employee?.name ?? 'an employee';
  return (
    <>
      <LiveDocuments />
      <PageHeader
        eyebrow={`Document request · ${r.reference}`}
        title={r.title}
        description={r.isMine ? `Requested by ${r.requestedBy.label}${r.requestedBy.name ? ` (${r.requestedBy.name})` : ''}` : `From ${from} · requested by ${r.requestedBy.label}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/documents?tab=requests">All requests</Link>}
      />
      <RequestView r={r} />
    </>
  );
}
