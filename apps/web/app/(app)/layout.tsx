import { designLevelOf, welcomeSceneFor, type MemberPreferences, type NotificationPreferences, type NotificationView } from '@crew/contracts';
import { RememberWelcome } from '@/components/remember-welcome';
import { cookies, headers } from 'next/headers';
import { DemoBanner, WelcomeIntro } from '@crew/ui';
import Link from 'next/link';
import { loadOptional, loadSession } from '@/lib/api';
import { DeletePasswordProvider } from '@/components/delete-guard';
import { MfaStepUpProvider } from '@/components/mfa-step-up';
import { LiveProvider } from '@/components/live';
import { IdleWatch } from '@/components/idle-watch';
import { appearanceFromCookie } from '@/lib/appearance-cookie';
import { HOME_VIEW_COOKIE, canSwitchWorkView, homeViews, quickActions, visibleNav, workflowActions } from '@/lib/nav';
import type { Me, TaskCounts } from '@/lib/types';
import { Shell, type Notifications } from './shell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await loadSession<Me>('/me');
  const handlesHelpdesk = Boolean(me.permissions['helpdesk:manage']) && me.features.includes('helpdesk');
  const chatsOn = me.features.includes('helpdesk') && Boolean(me.permissions['helpdesk:use']);
  const newsOn = me.features.includes('announcements') && Boolean(me.permissions['announcements:read']);
  // Everything the shell needs is fetched together, so each page waits for one round of requests.
  const [notifications, prefs, inbox, cookieAppearance, helpdesk, notificationPrefs, taskCounts, chats, news, noticeSummary, requestSummary] = await Promise.all([
    loadOptional<Notifications & { items: NotificationView[] }>('/notifications?limit=15'),
    loadOptional<MemberPreferences>('/me/preferences'),
    loadOptional<unknown[]>('/approvals/inbox'),
    appearanceFromCookie(),
    handlesHelpdesk ? loadOptional<{ queue: { awaitingHr: number } | null }>('/helpdesk/summary') : Promise.resolve(null),
    loadOptional<NotificationPreferences>('/notifications/preferences'),
    loadOptional<TaskCounts>('/tasks/counts'),
    chatsOn ? loadOptional<{ unread: number }>('/communication/unread') : Promise.resolve(null),
    newsOn ? loadOptional<{ total: number }>('/announcements/unread') : Promise.resolve(null),
    loadOptional<{ categories: { category: string; unread: number }[]; actionNeeded?: number }>('/notifications/summary'),
    loadOptional<{ pending: number; toApply: number }>('/requests/summary'),
  ]);
  // Unread notices per category: the menu marks the matching module (Leave, Attendance, Learning ...) with them.
  const byCategory = noticeSummary ? Object.fromEntries(noticeSummary.categories.filter((c) => c.unread > 0).map((c) => [c.category, c.unread])) : null;
  const counts: Record<string, number> = {};
  if (inbox?.length) counts['/approvals'] = inbox.length;
  // Questions from employees that HR still has to answer, on the HR helpdesk menu item.
  if (helpdesk?.queue?.awaitingHr) counts['/helpdesk/queue'] = helpdesk.queue.awaitingHr;
  // Unread chat messages, and for HR the help requests waiting for an answer, on the Communication menu item.
  const comm = (chats?.unread ?? 0) + (helpdesk?.queue?.awaitingHr ?? 0);
  if (comm) counts['/communication'] = comm;
  // Announcements not read yet, or waiting for an acknowledgement.
  if (news?.total) counts['/announcements'] = news.total;
  // Open HR and manager tasks, plus work others sent me to check.
  const tasks = taskCounts ? taskCounts.hr.open + taskCounts.manager.open + taskCounts.toReview + taskCounts.documentsToVerify : 0;
  if (tasks) counts['/tasks'] = tasks;
  // Approved requests that still need their leave application.
  if (requestSummary?.toApply) counts['/requests'] = requestSummary.toApply;
  // The level's design is on <html> before the first paint (the shell keeps it in step afterwards).
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  // The sign-in page remembers this level, so the next sign-in on this browser opens with its own welcome.
  // My Workforce / My Day (issue #86): My Day keeps only the person's own pages in the menu, in its own colour.
  const switchable = canSwitchWorkView(me);
  const workView = switchable ? (prefs?.experience?.workView ?? 'workforce') : 'workforce';
  // The whole menu goes to the shell, which keeps only My Day's pages itself, so the menu follows the switch at once.
  const nav = visibleNav(me);
  const views = homeViews(me);
  const homeView = (await cookies()).get(HOME_VIEW_COOKIE)?.value;
  const levelScript = `document.documentElement.dataset.level=${JSON.stringify(workView === 'myday' ? 'employee' : designLevelOf(me.levels))};document.documentElement.dataset.view=${JSON.stringify(workView)}`;
  return (
    <>
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: levelScript }} />
      <RememberWelcome scene={welcomeSceneFor(me.levels)} />
      <IdleWatch minutes={me.session.idleMinutes} />
      {/* The welcome that plays once right after signing in, over the dashboard while it loads. */}
      <WelcomeIntro scene={welcomeSceneFor(me.levels)} name={me.user.fullName} workspace={me.tenant.name} />
      {me.tenant.isDemo && <DemoBanner />}
      {me.subscription?.locked && (
        <div role="alert" data-testid="read-only-banner" className="border-b border-danger/30 bg-danger-subtle px-4 py-1.5 text-center text-xs font-medium text-danger">
          This workspace is read-only because an invoice is overdue. You can still view everything.{' '}
          {me.permissions['billing:manage'] ? <Link href="/settings/billing" className="underline">Pay the invoice to open it again</Link> : 'Ask a billing admin to pay it on Plan & billing.'}
        </div>
      )}
      <MfaStepUpProvider mfaEnabled={me.user.mfaEnabled}>
        <DeletePasswordProvider>
        <LiveProvider initial={notifications ? { unread: notifications.unread, items: notifications.items } : null} byCategory={byCategory} actionNeeded={noticeSummary?.actionNeeded ?? 0} prefs={notificationPrefs}>
        <Shell me={me} nav={nav} workView={switchable ? workView : null} views={views.length > 1 ? views : []} homeView={homeView === 'organization' || homeView === 'workforce' ? homeView : null} notifications={notifications} prefs={prefs} cookieAppearance={cookieAppearance} counts={counts} quick={quickActions(me)} workflows={workflowActions(me)}>
          {children}
        </Shell>
        </LiveProvider>
        </DeletePasswordProvider>
      </MfaStepUpProvider>
    </>
  );
}
