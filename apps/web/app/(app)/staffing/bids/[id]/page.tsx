import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import type { InboxItem, Me } from '@/lib/types';
import type { Bid } from '../../types';
import { BidDetail } from './bid-detail';

export const metadata: Metadata = { title: 'Staffing bid' };

export default async function BidPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [bid, me, inbox] = await Promise.all([
    loadOptional<Bid>(`/staffing/bids/${id}`),
    load<Me>('/me'),
    loadOptional<InboxItem[]>('/approvals/inbox'),
  ]);
  if (!bid) notFound();
  // The approver sees Approve and Reject here as well as in their inbox, only when the current step is theirs.
  const myApproval = bid.approval && bid.status === 'pending_approval' ? (inbox ?? []).find((i) => i.id === bid.approval!.id) ?? null : null;
  return <BidDetail bid={bid} myApproval={myApproval} notice={sp.notice?.slice(0, 300) ?? null} senderName={me.user.fullName} workspace={me.tenant.name} />;
}
