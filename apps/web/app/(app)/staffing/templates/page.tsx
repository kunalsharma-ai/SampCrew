import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import type { BidTemplate } from '../types';
import { TemplatesView } from './templates-view';

export const metadata: Metadata = { title: 'Proposal templates' };

export default async function TemplatesPage() {
  const me = await load<Me>('/me');
  if (!can(me, 'bids:manage')) redirect('/staffing/bids');
  const templates = await load<BidTemplate[]>('/staffing/templates');
  return (
    <>
      <PageHeader title="Proposal templates" description="Cover note, terms, how long a proposal is valid and the pricing defaults a new bid starts from. The default template is what Quick Bid uses." />
      <TemplatesView templates={templates} />
    </>
  );
}
