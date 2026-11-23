import { buttonClass, PageHeader } from '@crew/ui';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { load } from '@/lib/api';
import type { LearningAccessView } from '../types';
import { ManageNav } from './manage-nav';

/** Learning management: for the Super Workspace and HR Workspaces with Learning powers. Everyone else goes to their own learning. */
export default async function ManageLayout({ children }: { children: ReactNode }) {
  const access = await load<LearningAccessView>('/learning/access');
  if (!access.manager) redirect('/learning');
  return (
    <>
      <PageHeader
        title="Learning management"
        description={access.level === 'super' ? 'Super Workspace: every learning module, every employee, and what each HR Workspace may do.' : `HR Workspace: ${access.scopes.map((s) => s.name).join(', ')}. You see and manage only the people your HR Workspace looks after.`}
        actions={access.learner ? <Link href="/learning" className={buttonClass('ghost', 'sm')}>My learning</Link> : undefined}
      />
      <ManageNav access={access} />
      {children}
    </>
  );
}
