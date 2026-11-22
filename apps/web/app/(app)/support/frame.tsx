import type { SupportConversationView } from '@crew/contracts';
import { Card, EmptyState, PageHeader } from '@crew/ui';
import { Headset } from 'lucide-react';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { CommTabs } from '../communication/comm-tabs';

export interface SupportList { items: SupportConversationView[]; unread: number }

/** The page frame: header, Communication tabs (when the plan has Communication) and the "Super Workspace only" notice. */
export async function SupportFrame({ me, children }: { me: Me; children: React.ReactNode }) {
  const comm = me.features.includes('helpdesk') && can(me, 'helpdesk:use');
  return (
    <>
      <PageHeader
        title="SampCrew Support"
        description={`Chat privately with the SampCrew Console Admin team about questions, technical issues or your account. Only the Super Workspace of ${me.tenant.name} can see these conversations.`}
      />
      {comm && <CommTabs active="support" isHr={can(me, 'helpdesk:manage')} superWs />}
      {children}
    </>
  );
}

export function NotSuper() {
  return (
    <Card className="py-6" data-testid="support-not-super">
      <EmptyState icon={<Headset className="size-5" />} title="SampCrew Support is for the Super Workspace" description="Conversations with the Console Admin team are private to your company's Super Workspace. For help inside your company, message your HR team in Communication." />
    </Card>
  );
}
