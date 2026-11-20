import type { PlatformFeatureRow } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { FeaturesView } from './features-view';

export const metadata: Metadata = { title: 'Feature management' };

export default async function FeaturesPage() {
  const [me, data] = await Promise.all([load<Admin>('/platform/auth/me'), load<{ items: PlatformFeatureRow[]; counts: Record<string, number> }>('/platform/features')]);
  return (
    <>
      <PageHeader
        title="Feature management"
        description="Every module of SampCrew with each of its pages. What you switch off here is gone at once for every company and every level below (Super Workspace, HR Workspace, Employee Workspace), whatever their plan says, and their records are kept. New features arrive as Pending and stay off until you activate them. For one company only, use its Access tab."
      />
      <FeaturesView rows={data.items} counts={data.counts} canEdit={hasCap(me, 'access:manage')} />
    </>
  );
}
