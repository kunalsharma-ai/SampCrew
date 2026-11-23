import type { HelpQueryList } from '@crew/contracts';
import { HelpQueryListView, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { ConsoleHelp } from '@/components/help-centre';
import { load } from '@/lib/api';

export const metadata: Metadata = { title: 'Help queries' };

type Search = { q?: string; status?: string; assigned?: string; tenant?: string };

export default async function HelpQueriesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const p = new URLSearchParams();
  if (sp.q) p.set('q', sp.q);
  if (sp.status) p.set('status', sp.status);
  if (sp.assigned) p.set('assigned', sp.assigned);
  if (sp.tenant) p.set('tenantId', sp.tenant);
  const list = await load<HelpQueryList>(`/platform/help/queries?${p}`);
  return (
    <>
      <PageHeader title="Help queries" description="Queries raised to SampCrew Support from Help & Support: by Super Workspaces, in SampCrew categories such as billing or a product problem, and escalations from each company. Assign them, reply, add internal notes and set the status." />
      <ConsoleHelp><HelpQueryListView list={list} mode="console" search={sp} /></ConsoleHelp>
    </>
  );
}
