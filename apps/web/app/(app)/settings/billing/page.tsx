import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { BillingView, type Addon, type BillingProfile, type Invoice, type Plan, type PlanRequest, type SubscriptionInfo, type UsageMetric } from './billing-view';

export const metadata: Metadata = { title: 'Plan & billing' };

export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const [me, plans, sub, invoices, requests, usage, addons, profile] = await Promise.all([
    load<Me>('/me'),
    load<Plan[]>('/billing/plans'),
    load<SubscriptionInfo>('/billing/subscription'),
    load<Invoice[]>('/billing/invoices'),
    load<PlanRequest[]>('/billing/plan-requests'),
    load<UsageMetric[]>('/billing/usage'),
    load<Addon[]>('/billing/addons'),
    load<BillingProfile | null>('/billing/profile'),
  ]);
  const order = one('order');
  const cancelled = one('status') === 'cancelled';
  return (
    <>
      <PageHeader title="Plan & billing" description="Your subscription decides which SampCrew modules your workspace can use. Compare plans, pay invoices, add modules, or ask SAMPLEDGE for Enterprise." />
      <BillingView
        plans={plans} info={sub} invoices={invoices} requests={requests} usage={usage} addons={addons} profile={profile}
        features={me.features} canManage={can(me, 'billing:manage')}
        orderId={order && /^[0-9a-f-]{36}$/.test(order) && !cancelled ? order : null}
        checkoutCancelled={cancelled}
        upgrade={one('upgrade')?.match(/^[a-z_]{2,40}$/) ? one('upgrade') : null}
      />
    </>
  );
}
