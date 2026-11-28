import { PageHeader } from '@crew/ui';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { todayIn } from '@/lib/time';
import type { Me } from '@/lib/types';
import { LeaveForm } from '../../requests/leave-form';
import type { RequestOptions, RequestSettingsView } from '../../requests/types';

export const metadata: Metadata = { title: 'Apply for leave' };

/** Apply for Leave: the application is itself a request, sent straight to the approvers the person chooses. */
export default async function ApplyLeavePage() {
  const [options, me, settings] = await Promise.all([load<RequestOptions>('/requests/options'), load<Me>('/me'), load<RequestSettingsView>('/requests/settings')]);
  const cat = settings.settings.categories.find((c) => c.key === 'leave');
  return (
    <>
      <Link href="/leave" className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" /> Leave</Link>
      <PageHeader title="Apply for leave" eyebrow={options.me.levelLabel} description="Choose the leave type, the days, full day, half day or hours, and your approvers. You can follow it in My Requests." />
      {cat && !cat.enabled
        ? <p className="text-sm text-fg-muted">Leave applications are switched off for this workspace.</p>
        : <LeaveForm options={options} today={todayIn(me.tenant.timezone)} workflow={cat?.workflow ?? 'all'} attachments={cat?.attachments ?? 'optional'} />}
    </>
  );
}
