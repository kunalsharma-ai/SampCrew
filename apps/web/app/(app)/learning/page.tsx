import { ModuleNotices } from '@/components/module-notices';
import { buttonClass, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { allowed, ModuleOverview } from '@/components/module-overview';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import { MyLearningView } from './my-learning';
import { MY_TABS, type LearningAccessView, type MyLearning, type MyTab } from './types';

export const metadata: Metadata = { title: 'My learning' };

export default async function LearningPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: t } = await searchParams;
  const tab: MyTab = (MY_TABS as readonly string[]).includes(t ?? '') ? (t as MyTab) : 'all';
  const [my, access, me] = await Promise.all([load<MyLearning>('/learning/my'), load<LearningAccessView>('/learning/access'), load<Me>('/me')]);
  return (
    <>
      <PageHeader
        title="My learning"
        description="Learning assigned to you and learning you chose, with your progress, scores, deadlines and certificates."
        actions={access.manager ? <Link className={buttonClass('secondary', 'sm')} href="/learning/manage" data-testid="learning-manage-link">Learning management</Link> : undefined}
      />
      {access.manager && <ModuleOverview module="learning" actions={allowed(me, [
        { label: 'Learning dashboard', href: '/learning/manage', icon: 'chart', permission: 'learning:manage' },
        { label: 'Learning library', href: '/learning/manage/library', icon: 'book-open', permission: 'learning:manage' },
        ...(access.caps.create ? [{ label: 'New module', href: '/learning/manage/new', icon: 'graduation-cap' }] : []),
        ...(access.caps.reports ? [{ label: 'Reports', href: '/learning/manage/reports', icon: 'file-text' }] : []),
      ])} />}
      <ModuleNotices category="learning" label="Learning" />
      <MyLearningView my={my} tab={tab} learner={access.learner} />
    </>
  );
}
