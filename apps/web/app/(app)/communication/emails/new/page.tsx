import { EMPTY_AUDIENCE } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { loadAudienceOptions } from '../../audience-options';
import { CommTabs } from '../../comm-tabs';
import { Compose } from '../compose';

export const metadata: Metadata = { title: 'New email' };

export default async function NewEmailPage({ searchParams }: { searchParams: Promise<{ to?: string; group?: string }> }) {
  const { to, group } = await searchParams;
  const me = await load<Me>('/me');
  if (!can(me, 'helpdesk:manage')) redirect('/communication/emails');
  const { options, knownNames } = await loadAudienceOptions();
  const uuid = (v?: string) => !!v && /^[0-9a-f-]{36}$/.test(v);
  const audience = uuid(to) ? { ...EMPTY_AUDIENCE, membershipIds: [to!] } : uuid(group) ? { ...EMPTY_AUDIENCE, groupIds: [group!] } : EMPTY_AUDIENCE;
  return (
    <>
      <PageHeader title="New email" description="Each person gets their own copy, so nobody sees the others' addresses. It goes out through your workspace's email provider." />
      <CommTabs active="emails" isHr />
      <Compose id={null} initial={{ subject: '', html: '', audience, cc: [], bcc: [] }} files={[]} options={options} knownNames={knownNames} />
    </>
  );
}
