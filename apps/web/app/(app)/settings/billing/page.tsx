import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { BillingView, type Invoice, type Plan, type PlanRequest, type SubscriptionInfo } from './billing-view';

export const metadata: Metadata = { title: 'Plan & billing' };

export default async function BillingPage() {
  const [me, plans, sub, invoices, requests] = await Promise.all([
    load<Me>('/me'),
    load<Plan[]>('/billing/plans'),
    load<SubscriptionInfo>('/billing/subscription'),
    load<Invoice[]>('/billing/invoices'),
    load<PlanRequest[]>('/billing/plan-requests'),
  ]);
  return (
    <>
      <PageHeader title="Plan & billing" description="Your subscription decides which SampCrew modules your workspace can use. Compare plans, buy a different one, or ask SAMPLEDGE for Enterprise." />
      <BillingView plans={plans} info={sub} invoices={invoices} requests={requests} features={me.features} canManage={can(me, 'billing:manage')} />
    </>
  );
}
