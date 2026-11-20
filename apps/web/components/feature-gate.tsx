'use client';
import { partForWebPath } from '@crew/contracts';
import { EmptyState } from '@crew/ui';
import { ToggleLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Me } from '@/lib/types';

const WHY: Record<string, string> = {
  platform_off: 'SAMPLEDGE has switched it off for now.',
  workspace_off: 'SAMPLEDGE has switched it off for your company.',
  admin_off: 'Your company’s Super Workspace switched it off.',
  level_off: 'Your company’s Super Workspace switched it off for your access level.',
  hr_level_off: 'Your HR team switched it off for Employee Workspace.',
  hr_workspace_off: 'It is not given to your HR Workspace.',
  hr_member_off: 'It is not given to you.',
  member_blocked: 'It is not given to you.',
  channel_off: 'It is switched off in this app.',
};

/**
 * Feature management on direct URLs: a page whose part (FEATURE_PARTS) is switched off at any level shows why instead
 * of its content, also when its address is typed in. The server refuses the page's own data routes as well.
 */
export function FeatureGate({ me, pathname, children }: { me: Pick<Me, 'features' | 'featureBlocks'>; pathname: string; children: ReactNode }) {
  const part = partForWebPath(pathname);
  if (!part || me.features.includes(part.key)) return <>{children}</>;
  // A whole module that is unavailable is explained by the page itself (switched-off and upgrade messages); here only
  // a page switched off while its module is on.
  if (!me.features.includes(part.feature)) return <>{children}</>;
  const blocks = (me.featureBlocks ?? {}) as Record<string, string>;
  const reason = blocks[part.key];
  if (!reason) return <>{children}</>;
  return (
    <div data-testid="feature-off" className="py-10">
      <EmptyState
        icon={<ToggleLeft className="size-6" aria-hidden />}
        title={`${part.name} is switched off`}
        description={`${WHY[reason] ?? 'It is not available to you.'} Nothing was deleted; it comes back when it is switched on again.`}
        action={<Link href="/" className="text-sm font-medium text-accent hover:underline">Go to Home</Link>}
      />
    </div>
  );
}
