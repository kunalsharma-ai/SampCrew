import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { BillingView, type Invoice, type Plan, type SubscriptionInfo } from './billing-view';

export const metadata: Metadata = { title: 'Plan & billing' };

export default async function BillingPage() {
  const [me, plans, sub, invoices] = await Promise.all([
    load<Me>('/me'),
    load<Plan[]>('/billing/plans'),
    load<SubscriptionInfo>('/billing/subscription'),
    load<Invoice[]>('/billing/invoices'),
  ]);
  return (
    <>
      <PageHeader title="Plan & billing" description="Your subscription, what you are using, and the plans you can move to." />
      <BillingView plans={plans} info={sub} invoices={invoices} canManage={can(me, 'billing:manage')} />
    </>
  );
}
