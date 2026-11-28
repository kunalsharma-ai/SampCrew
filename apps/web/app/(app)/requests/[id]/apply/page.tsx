import { Alert } from '@crew/ui';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { LeaveForm } from '../../types';
import { LeaveApplicationForm } from './leave-application-form';

export const metadata: Metadata = { title: 'Leave application form' };

export default async function ApplyLeavePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await load<LeaveForm>(`/requests/${id}/leave-form`);
  const r = form.request;
  return (
    <>
      <Link href={`/requests/${id}`} className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" /> {r.title} ({r.ref})</Link>
      {!r.canApplyLeave ? (
        <Alert tone={r.leaveApplication ? 'success' : 'info'} title={r.leaveApplication ? 'You already applied for this leave' : 'Not ready to apply yet'}>
          {r.leaveApplication
            ? <>Your leave application {r.leaveApplication.ref} is {r.leaveApplication.status}. <Link className="underline" href={`/leave/requests/${r.leaveApplication.id}`}>Open it</Link>.</>
            : r.status === 'pending' ? 'Apply for leave once everyone you looped in has approved the request.' : !form.hasEmployeeRecord ? 'Your login is not linked to an employee record yet. Ask HR to link it.' : `This request is ${r.status}.`}
        </Alert>
      ) : (
        <LeaveApplicationForm id={id} form={form} />
      )}
    </>
  );
}
