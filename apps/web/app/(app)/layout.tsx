import type { MemberPreferences } from '@crew/contracts';
import { DemoBanner } from '@crew/ui';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import { appearanceFromCookie } from '@/lib/appearance-cookie';
import { quickActions, visibleNav, workflowActions } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { Shell, type Notifications } from './shell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await load<Me>('/me');
  const [notifications, prefs, inbox, cookieAppearance] = await Promise.all([
    loadOptional<Notifications>('/notifications?limit=15'),
    loadOptional<MemberPreferences>('/me/preferences'),
    loadOptional<unknown[]>('/approvals/inbox'),
    appearanceFromCookie(),
  ]);
  const counts: Record<string, number> = {};
  if (inbox?.length) counts['/approvals'] = inbox.length;
  return (
    <>
      {me.tenant.isDemo && <DemoBanner />}
      {me.subscription?.locked && (
        <div role="alert" data-testid="read-only-banner" className="border-b border-danger/30 bg-danger-subtle px-4 py-1.5 text-center text-xs font-medium text-danger">
          This workspace is read-only because an invoice is overdue. You can still view everything.{' '}
          {me.permissions['billing:manage'] ? <Link href="/settings/billing" className="underline">Pay the invoice to open it again</Link> : 'Ask a billing admin to pay it on Plan & billing.'}
        </div>
      )}
      <Shell me={me} nav={visibleNav(me)} notifications={notifications} prefs={prefs} cookieAppearance={cookieAppearance} counts={counts} quick={quickActions(me)} workflows={workflowActions(me)}>
        {children}
      </Shell>
    </>
  );
}
