import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { PlansView, type PlanRequest, type PlatformPlan } from './plans-view';

export const metadata: Metadata = { title: 'Plans & pricing' };

export default async function PlansPage() {
  const [me, plans, requests] = await Promise.all([
    load<Admin>('/platform/auth/me'),
    load<PlatformPlan[]>('/platform/plans'),
    load<PlanRequest[]>('/platform/plan-requests'),
  ]);
  return (
    <>
      <PageHeader
        title="Plans & pricing"
        description="Decide what each plan includes and what it costs. A workspace can use only the modules and limits of the plan its admin bought; changes apply to every workspace on the plan straight away."
      />
      <PlansView plans={plans} requests={requests} canEdit={hasCap(me, 'plans:manage')} />
    </>
  );
}
