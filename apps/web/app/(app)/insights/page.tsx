import { EmptyState, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { allowed, ModuleOverview } from '@/components/module-overview';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';

export const metadata: Metadata = { title: 'HR analytics' };

export default async function InsightsPage() {
  const me = await load<Me>('/me');
  const scope = me.permissions['employees:read'];
  if (!scope || scope === 'own') {
    return (
      <>
        <PageHeader title="HR analytics" />
        <EmptyState title="Analytics covers more than your own record" description="Ask an administrator for access to employee records for your team, department or organization to see workforce analytics." />
      </>
    );
  }
  return (
    <>
      <PageHeader title="HR analytics" description="Workforce numbers turned into people insights, for everyone your access covers. Every figure is calculated from live records when you open the page." />
      <ModuleOverview module="analytics" actions={allowed(me, [
        { label: 'Attrition risk', href: '/insights/attrition', icon: 'trending-down', permission: 'insights:attrition', feature: 'workforce_analytics' },
        { label: 'Workforce Universe', href: '/insights/universe', icon: 'orbit', permission: 'employees:read', feature: 'workforce_universe' },
        { label: 'Survey results', href: '/surveys/manage', icon: 'chart', permission: 'engagement:manage', feature: 'engagement' },
        { label: 'Automation Studio', href: '/automation', icon: 'workflow', permission: 'automation:manage', feature: 'automation' },
      ])} />
    </>
  );
}
