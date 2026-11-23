import { RaiseQueryForm, type HelpQueryForm } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { WebHelp } from '../../help-centre';

export const metadata: Metadata = { title: 'Raise a Query' };

type Search = { page?: string; article?: string; category?: string; subject?: string };

export default async function RaiseQueryPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const form = await load<HelpQueryForm>('/help/queries/form');
  const uuid = /^[0-9a-f-]{36}$/;
  return <WebHelp><RaiseQueryForm form={form} preset={{ page: sp.page?.slice(0, 200), article: sp.article && uuid.test(sp.article) ? sp.article : undefined, category: sp.category, subject: sp.subject?.slice(0, 150) }} /></WebHelp>;
}
