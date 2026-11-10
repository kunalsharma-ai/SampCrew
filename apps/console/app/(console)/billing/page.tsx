import { PageHeader } from '@crew/ui';
import type { BillingSettingsInput } from '@crew/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { cn } from '@crew/ui';
import type { ConsoleInvoice } from '@/components/invoice-table';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { AddonsPanel, CouponsPanel, EventsPanel, InvoicesPanel, RevenuePanel, SettingsPanel, type ConsoleAddon, type ConsoleCoupon, type PaymentEvent, type Revenue } from './billing-view';

export const metadata: Metadata = { title: 'Billing & revenue' };

const TABS = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'addons', label: 'Add-ons' },
  { key: 'coupons', label: 'Coupons' },
  { key: 'settings', label: 'Settings' },
  { key: 'events', label: 'Payment events' },
] as const;
type Tab = (typeof TABS)[number]['key'];

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ tab?: string; status?: string }> }) {
  const sp = await searchParams;
  const tab: Tab = (TABS.find((t) => t.key === sp.tab)?.key ?? 'revenue') as Tab;
  const status = ['open', 'paid', 'void', 'overdue'].includes(sp.status ?? '') ? sp.status! : '';
  const me = await load<Admin>('/platform/auth/me');
  const canManage = hasCap(me, 'billing:manage');
  const canPlans = hasCap(me, 'plans:manage');
  let body: React.ReactNode;
  if (tab === 'revenue') body = <RevenuePanel revenue={await load<Revenue>('/platform/billing/revenue')} canManage={canManage} />;
  else if (tab === 'invoices') body = <InvoicesPanel invoices={await load<ConsoleInvoice[]>(`/platform/billing/invoices${status ? `?status=${status}` : ''}`)} status={status} canManage={canManage} />;
  else if (tab === 'addons') {
    const [addons, plans] = await Promise.all([load<ConsoleAddon[]>('/platform/billing/addons'), load<{ key: string; name: string }[]>('/platform/plans')]);
    body = <AddonsPanel addons={addons} plans={plans.map((p) => ({ key: p.key, name: p.name }))} canManage={canPlans} />;
  } else if (tab === 'coupons') {
    const [coupons, plans] = await Promise.all([load<ConsoleCoupon[]>('/platform/billing/coupons'), load<{ key: string; name: string }[]>('/platform/plans')]);
    body = <CouponsPanel coupons={coupons} plans={plans.map((p) => ({ key: p.key, name: p.name }))} canManage={canManage} />;
  } else if (tab === 'settings') body = <SettingsPanel settings={await load<BillingSettingsInput>('/platform/billing/settings')} canManage={canManage} />;
  else body = <EventsPanel events={await load<PaymentEvent[]>('/platform/billing/payment-events')} />;
  return (
    <>
      <PageHeader title="Billing & revenue" description="Money from every workspace: revenue, invoices, add-ons, coupons and how SAMPLEDGE bills. Payment keys for Razorpay and Stripe are set in Integrations." />
      <nav aria-label="Billing sections" className="crew-card mb-6 flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1">
        {TABS.map((t) => (
          <Link key={t.key} href={`/billing?tab=${t.key}`} aria-current={t.key === tab ? 'page' : undefined} data-testid={`billing-tab-${t.key}`}
            className={cn('crew-nav-link whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px]', t.key === tab ? 'crew-tab-active bg-accent font-medium text-accent-fg' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg')}>
            {t.label}
          </Link>
        ))}
      </nav>
      {body}
    </>
  );
}
