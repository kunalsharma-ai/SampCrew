import type { HelpInsights } from '@crew/contracts';
import { PageHeader, buttonClass } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { HelpContentManager, type ManageData, type ManagerTab } from './manager';

export const metadata: Metadata = { title: 'Help content' };

const TABS: ManagerTab[] = ['articles', 'categories', 'queries', 'settings', 'insights'];

export default async function HelpContentPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const data = await load<ManageData>('/platform/help/manage');
  const insights = await load<HelpInsights>('/platform/help/manage/insights');
  return (
    <>
      <PageHeader
        title="Help content"
        description="Everything in Help & Support at every level: FAQs, guides, tutorials, troubleshooting and quick starts, their categories, who sees them (level, feature and permission), the Raise a Query categories and the settings."
        actions={<Link href="/help" className={buttonClass('secondary', 'sm')}>Open Help &amp; Support</Link>}
      />
      <HelpContentManager data={data} insights={insights} tab={TABS.includes(tab as ManagerTab) ? (tab as ManagerTab) : 'articles'} />
    </>
  );
}
