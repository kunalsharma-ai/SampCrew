import type { MemberPreferences, NotificationPreferences, NotificationView } from '@crew/contracts';
import { DemoBanner } from '@crew/ui';
import Link from 'next/link';
import { loadOptional, loadSession } from '@/lib/api';
import { MfaStepUpProvider } from '@/components/mfa-step-up';
import { LiveProvider } from '@/components/live';
import { appearanceFromCookie } from '@/lib/appearance-cookie';
import { quickActions, visibleNav, workflowActions } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { Shell, type Notifications } from './shell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await loadSession<Me>('/me');
  const handlesHelpdesk = Boolean(me.permissions['helpdesk:manage']) && me.features.includes('helpdesk');
  const [notifications, prefs, inbox, cookieAppearance, helpdesk, notificationPrefs] = await Promise.all([
    loadOptional<Notifications & { items: NotificationView[] }>('/notifications?limit=15'),
    loadOptional<MemberPreferences>('/me/preferences'),
    loadOptional<unknown[]>('/approvals/inbox'),
    appearanceFromCookie(),
    handlesHelpdesk ? loadOptional<{ queue: { awaitingHr: number } | null }>('/helpdesk/summary') : Promise.resolve(null),
    loadOptional<NotificationPreferences>('/notifications/preferences'),
  ]);
  const chats = me.features.includes('helpdesk') && me.permissions['helpdesk:use'] ? await loadOptional<{ unread: number }>('/communication/unread') : null;
  const news = me.features.includes('announcements') && me.permissions['announcements:read'] ? await loadOptional<{ total: number }>('/announcements/unread') : null;
  const counts: Record<string, number> = {};
  if (inbox?.length) counts['/approvals'] = inbox.length;
  // Questions from employees that HR still has to answer, on the HR helpdesk menu item.
  if (helpdesk?.queue?.awaitingHr) counts['/helpdesk/queue'] = helpdesk.queue.awaitingHr;
  // Unread chat messages, and for HR the help requests waiting for an answer, on the Communication menu item.
  const comm = (chats?.unread ?? 0) + (helpdesk?.queue?.awaitingHr ?? 0);
  if (comm) counts['/communication'] = comm;
  // Announcements not read yet, or waiting for an acknowledgement.
  if (news?.total) counts['/announcements'] = news.total;
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
