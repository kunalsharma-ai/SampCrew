import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { PlansView, type PlatformPlan } from './plans-view';

export const metadata: Metadata = { title: 'Plans & pricing' };

export default async function PlansPage() {
  const [me, plans] = await Promise.all([load<Admin>('/platform/auth/me'), load<PlatformPlan[]>('/platform/plans')]);
  return (
    <>
      <PageHeader title="Plans & pricing" description="Per-seat list prices. Plan contents come from the feature catalogue in code, so they are reviewed like any other change." />
      <PlansView plans={plans} canEdit={hasCap(me, 'plans:manage')} />
    </>
  );
}
