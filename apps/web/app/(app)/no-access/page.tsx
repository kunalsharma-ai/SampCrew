import { EmptyState, buttonClass } from '@crew/ui';
import { KeyRound, Lock, Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'No access' };

const REASONS: Record<string, { title: string; description: string; icon: React.ReactNode; action?: { href: string; label: string } }> = {
  mfa_required: {
    title: 'Verify with two-step verification first',
    description: 'This page holds sensitive information. Turn on two-step verification, or sign in again with your authenticator code, to open it.',
    icon: <KeyRound className="size-6" />,
    action: { href: '/settings/security', label: 'Go to security settings' },
  },
  feature_not_in_plan: {
    title: 'Not included in your plan',
    description: 'Your workspace plan does not include this module. An administrator can compare plans on the Plan & billing page.',
    icon: <Sparkles className="size-6" />,
  },
};

export default async function NoAccessPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  const r = REASONS[reason ?? ''] ?? {
    title: 'You do not have access to this page',
    description: 'Your roles in this workspace do not include it. If you need it for your work, ask a workspace administrator to update your role.',
    icon: <Lock className="size-6" />,
  };
  return (
    <div className="py-16">
      <EmptyState
        icon={r.icon}
        title={r.title}
        description={r.description}
        action={
          <div className="flex gap-2">
            {r.action && <Link href={r.action.href} className={buttonClass('primary')}>{r.action.label}</Link>}
            <Link href="/" className={buttonClass('secondary')}>Back to home</Link>
          </div>
        }
      />
    </div>
  );
}
