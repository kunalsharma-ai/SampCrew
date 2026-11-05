import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Connection } from '../types';
import { SlackView } from './slack-view';

export const metadata: Metadata = { title: 'Slack' };

export default async function SlackPage() {
  const connections = (await load<Connection[]>('/integrations/connections')).filter((c) => c.provider === 'slack');
  return (
    <>
      <PageHeader eyebrow="Integrations" title="Slack" description="Post messages to Slack channels from Automation Studio workflows. Each channel is connected with an incoming webhook that you create in your own Slack workspace." />
      <SlackView connections={connections} />
    </>
  );
}
