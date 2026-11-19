import type { MemberPreferences, NotificationPreferences, NotificationView } from '@crew/contracts';
import { DemoBanner } from '@crew/ui';
import Link from 'next/link';
import { loadOptional, loadSession } from '@/lib/api';
import { MfaStepUpProvider } from '@/components/mfa-step-up';
import { LiveProvider } from '@/components/live';
import { appearanceFromCookie } from '@/lib/appearance-cookie';
import { quickActions, visibleNav, workflowActions } from '@/lib/nav';
import type { Me, TaskCounts } from '@/lib/types';
import { Shell, type Notifications } from './shell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await loadSession<Me>('/me');
  const handlesHelpdesk = Boolean(me.permissions['helpdesk:manage']) && me.features.includes('helpdesk');
  const [notifications, prefs, inbox, cookieAppearance, helpdesk, notificationPrefs, taskCounts] = await Promise.all([
    loadOptional<Notifications & { items: NotificationView[] }>('/notifications?limit=15'),
    loadOptional<MemberPreferences>('/me/preferences'),
    loadOptional<unknown[]>('/approvals/inbox'),
    appearanceFromCookie(),
    handlesHelpdesk ? loadOptional<{ queue: { awaitingHr: number } | null }>('/helpdesk/summary') : Promise.resolve(null),
    loadOptional<NotificationPreferences>('/notifications/preferences'),
    loadOptional<TaskCounts>('/tasks/counts'),
  ]);
  const counts: Record<string, number> = {};
  if (inbox?.length) counts['/approvals'] = inbox.length;
  // Questions from employees that HR still has to answer, on the HR helpdesk menu item.
  if (helpdesk?.queue?.awaitingHr) counts['/helpdesk/queue'] = helpdesk.queue.awaitingHr;
  // Open HR and manager tasks, plus work others sent me to check.
  const tasks = taskCounts ? taskCounts.hr.open + taskCounts.manager.open + taskCounts.toReview + taskCounts.documentsToVerify : 0;
  if (tasks) counts['/tasks'] = tasks;
  return (
    <>
      {me.tenant.isDemo && <DemoBanner />}
      {me.subscription?.locked && (
        <div role="alert" data-testid="read-only-banner" className="border-b border-danger/30 bg-danger-subtle px-4 py-1.5 text-center text-xs font-medium text-danger">
          This workspace is read-only because an invoice is overdue. You can still view everything.{' '}
          {me.permissions['billing:manage'] ? <Link href="/settings/billing" className="underline">Pay the invoice to open it again</Link> : 'Ask a billing admin to pay it on Plan & billing.'}
        </div>
      )}
      <MfaStepUpProvider mfaEnabled={me.user.mfaEnabled}>
        <LiveProvider initial={notifications ? { unread: notifications.unread, items: notifications.items } : null} prefs={notificationPrefs}>
        <Shell me={me} nav={visibleNav(me)} notifications={notifications} prefs={prefs} cookieAppearance={cookieAppearance} counts={counts} quick={quickActions(me)} workflows={workflowActions(me)}>
          {children}
        </Shell>
        </LiveProvider>
      </MfaStepUpProvider>
    </>
  );
}
