import { PageHeader, StatusPill } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { KIND, type PrivacyRequest } from '../types';
import { PrivacyDetail } from './privacy-detail';

export const metadata: Metadata = { title: 'Privacy request' };

export default async function PrivacyRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await load<PrivacyRequest>(`/privacy/requests/${id}`);
  return (
    <>
      <PageHeader
        eyebrow={<Link className="hover:underline" href="/privacy">Privacy requests</Link>}
        title={`${KIND[r.kind]}: ${r.employeeName}`}
        description={`${r.employeeCode} · logged by ${r.requestedBy} on ${new Date(r.createdAt).toLocaleDateString()} · due ${r.dueOn}`}
        actions={<StatusPill status={r.status} />}
      />
      <PrivacyDetail r={r} />
    </>
  );
}
