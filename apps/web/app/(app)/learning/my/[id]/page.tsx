import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { PlayerView } from '../../types';
import { Player } from './player';

export const metadata: Metadata = { title: 'Learning' };

export default async function LearningPlayerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ item?: string }> }) {
  const { id } = await params;
  const { item } = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const view = await load<PlayerView>(`/learning/my/${id}`);
  return (
    <>
      <PageHeader eyebrow={<Link href="/learning" className="hover:underline">My learning</Link>} title={view.title} description={view.category} />
      <Player initial={view} startAt={item} />
    </>
  );
}
