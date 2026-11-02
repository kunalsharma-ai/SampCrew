import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Employee, Page } from '@/lib/types';
import { PrivacyList } from './privacy-list';
import { RetentionCard, type RetentionState } from './retention-card';
import type { PrivacyRequestRow } from './types';

export const metadata: Metadata = { title: 'Privacy requests' };

export default async function PrivacyPage() {
  const [requests, people, retention] = await Promise.all([
    load<PrivacyRequestRow[]>('/privacy/requests'),
    load<Page<Employee>>('/employees?limit=200&includeExited=true'),
    load<RetentionState>('/privacy/retention'),
  ]);
  return (
    <>
      <PageHeader
        title="Privacy requests"
        description="When someone asks for a copy of the data CREW holds about them, or for it to be erased, log it here. Each request is due 30 days after it is logged. Check the deadline that applies to you with your legal adviser."
      />
      <div className="grid gap-6">
        <PrivacyList requests={requests} people={people.items.map((e) => ({ id: e.id, name: `${e.displayName} (${e.employeeCode})`, status: e.status }))} />
        <RetentionCard state={retention} />
      </div>
    </>
  );
}
