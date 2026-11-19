import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { ApprovalDetail } from '../types';
import { ApprovalDetailView } from './approval-detail';

export const metadata: Metadata = { title: 'Approval request' };

export default async function ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await load<ApprovalDetail>(`/approvals/requests/${id}`);
  return <ApprovalDetailView d={d} />;
}
