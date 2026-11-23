import { EmptyState, buttonClass } from '@crew/ui';
import { KeyRound, Lock, Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { loadOptional, safeReturnPath } from '@/lib/api';
import type { Me } from '@/lib/types';
import { NoAccessMfa } from './verify-mfa';

export const metadata: Metadata = { title: 'No access' };

const REASONS: Record<string, { title: string; description: string; icon: React.ReactNode; action?: { href: string; label: string } }> = {
  mfa_required: {
    title: 'Verify with two-step verification first',
    description: 'This page holds sensitive information, so your session must be verified with an authenticator app. Do it below; you stay signed in.',
    icon: <KeyRound className="size-6" />,
  },
  crm_not_enabled: {
    title: 'Candidate CRM is not switched on for your HR Workspace',
    description: 'Your Super Workspace decides which HR Workspaces use Candidate CRM. Ask them to switch it on in Candidate CRM settings. Nothing is lost while it is off.',
    icon: <Lock className="size-6" />,
  },
  crm_not_available: {
    title: 'Candidate CRM is not part of your access',
    description: 'Candidate CRM is for Super Workspace and HR Workspace people who work in recruitment. Employee Workspace does not have it.',
    icon: <Lock className="size-6" />,
  },
  feature_not_in_plan: {
    title: 'Not included in your plan',
    description: 'Your workspace plan does not include this module. An administrator can compare plans on the Plan & billing page.',
    icon: <Sparkles className="size-6" />,
  },
  feature_disabled: {
    title: 'This module is switched off',
    description: 'SAMPLEDGE has switched this module off for your workspace. Your workspace owner can contact SAMPLEDGE support to turn it back on.',
    icon: <Lock className="size-6" />,
  },
  feature_off_in_app: {
    title: 'Not available in the Web Portal',
    description: 'SAMPLEDGE has switched this module off in the Web Portal for your workspace. It may still be available in the SampCrew mobile app.',
    icon: <Lock className="size-6" />,
  },
  app_switched_off: {
    title: 'The Web Portal is switched off',
    description: 'SAMPLEDGE has switched the Web Portal off for your workspace. Use the SampCrew mobile app, or ask your workspace owner to contact SAMPLEDGE support.',
    icon: <Lock className="size-6" />,
  },
  feature_off_by_platform: {
    title: 'This is switched off for now',
    description: 'SAMPLEDGE has switched this module or page off for every workspace for now. Nothing was deleted; it comes back when it is switched on again.',
    icon: <Lock className="size-6" />,
  },
  feature_switched_off: {
    title: 'This is switched off in your workspace',
    description: 'Your company’s Super Workspace switched this module or page off. Nothing was deleted; it comes back when they switch it on again.',
    icon: <Lock className="size-6" />,
  },
  feature_off_for_level: {
    title: 'This is switched off for your access level',
    description: 'Your company’s Super Workspace switched this off for your workspace access level. Ask them if you need it for your work.',
    icon: <Lock className="size-6" />,
  },
  feature_off_for_employees: {
    title: 'This is switched off for Employee Workspace',
    description: 'Your HR team switched this off for Employee Workspace. Ask them if you need it for your work.',
    icon: <Lock className="size-6" />,
  },
  feature_not_for_hr_workspace: {
    title: 'This is not given to your HR Workspace',
    description: 'Your company’s Super Workspace has not given this module to your HR Workspace. Ask them if you need it.',
    icon: <Lock className="size-6" />,
  },
  feature_not_for_member: {
    title: 'This module is not available to you',
    description: 'Your access to this module has been turned off for your account. Ask your workspace administrator if you need it for your work.',
    icon: <Lock className="size-6" />,
  },
};

export default async function NoAccessPage({ searchParams }: { searchParams: Promise<{ reason?: string; from?: string }> }) {
  const { reason, from } = await searchParams;
  const me = reason === 'mfa_required' ? await loadOptional<Me>('/me') : null;
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
      {me && !me.session.mfa && <NoAccessMfa mfaEnabled={me.user.mfaEnabled} from={safeReturnPath(from)} />}
    </div>
  );
}
