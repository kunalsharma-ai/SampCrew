import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import type { CompanyValue, Recognition } from '../talent/types';
import { RecognitionView } from './recognition-view';

export const metadata: Metadata = { title: 'Recognition' };

export default async function RecognitionPage() {
  const me = await load<Me>('/me');
  const moderator = Boolean(me.permissions['engagement:manage']);
  const [feed, values] = await Promise.all([load<Recognition[]>('/recognition'), load<CompanyValue[]>(`/company-values${moderator ? '?includeArchived=true' : ''}`)]);
  return (
    <>
      <PageHeader title="Recognition" description="Thank a colleague for something specific. Everyone in the workspace can see the wall; the person and their manager are notified." />
      <RecognitionView feed={feed} values={values} moderator={moderator} />
    </>
  );
}
