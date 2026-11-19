import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Stat, buttonClass } from '@crew/ui';
import { Inbox, Mail, MessagesSquare, Send } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { CommTabs } from './comm-tabs';
import { EMAIL_STATUS_LABEL, EMAIL_STATUS_TONE, type ConversationList, type Dashboard } from './types';

export const metadata: Metadata = { title: 'Communication' };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default async function CommunicationPage() {
  const me = await load<Me>('/me');
  if (!can(me, 'helpdesk:manage')) redirect('/communication/chat');
  const [d, chats] = await Promise.all([load<Dashboard>('/communication/dashboard'), load<ConversationList>('/communication/conversations')]);
  return (
    <>
      <PageHeader
        title="Communication"
        description="Email people, chat with employees and teams, and answer messages to HR. Help requests (Ask HR) are here too."
        actions={<><Link href="/communication/emails/new" className={buttonClass('primary', 'sm')}><Send className="size-3.5" /> New email</Link><Link href="/communication/chat?new=1" className={buttonClass('secondary', 'sm')}><MessagesSquare className="size-3.5" /> New chat</Link></>}
      />
      <CommTabs active="overview" isHr unread={chats.unread} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="comm-stats">
        <Stat label="Emails sent (30 days)" value={d.email.sent30} hint={`${d.email.recipients30} recipients`} icon={<Mail className="size-4" />} />
        <Stat label="Delivered" value={d.email.deliveryRate === null ? '—' : `${d.email.deliveryRate}%`} hint={d.email.failed30 ? `${d.email.failed30} not delivered` : 'None failed'} icon={<Send className="size-4" />} />
        <Stat label="Waiting for HR" value={d.chat.waitingForHr} hint="Messages to HR without a reply" icon={<Inbox className="size-4" />} />
        <Stat label="Chat messages (7 days)" value={d.chat.messages7} hint={`${d.chat.activeConversations7} active conversations`} icon={<MessagesSquare className="size-4" />} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Messages to HR waiting for a reply" description={`Anyone in the HR team (${d.hrTeamSize} people) can answer. Open help requests: ${d.helpdesk.openCases}.`} />
          <CardBody>
            {d.waiting.length ? (
              <ul className="grid gap-2" data-testid="waiting-for-hr">
                {d.waiting.map((w) => (
                  <li key={w.conversationId}>
                    <Link href={`/communication/chat/${w.conversationId}`} className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2 hover:bg-bg-subtle">
                      <span className="min-w-0"><span className="block text-[0.8125rem] font-semibold">{w.employeeName}</span><span className="block truncate text-xs text-fg-muted">{w.preview}</span></span>
                      <span className="shrink-0 text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{when(w.at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon={<Inbox className="size-5" />} title="Nothing waiting" description="Messages employees send to HR appear here until someone replies." />}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Recent emails" description={d.email.drafts ? `${d.email.drafts} draft${d.email.drafts === 1 ? '' : 's'} not sent yet.` : undefined} action={<Link href="/communication/emails" className="text-xs font-medium text-accent hover:underline">All emails</Link>} />
          <CardBody>
            {d.recentEmails.length ? (
              <ul className="grid gap-2">
                {d.recentEmails.map((e) => (
                  <li key={e.id}>
                    <Link href={`/communication/emails/${e.id}`} className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2 hover:bg-bg-subtle">
                      <span className="min-w-0">
                        <span className="block truncate text-[0.8125rem] font-semibold">{e.subject}</span>
                        <span className="block text-xs text-fg-muted">To {e.audienceLabel} · {e.sentCount} of {e.recipientCount} delivered</span>
                      </span>
                      <Badge tone={EMAIL_STATUS_TONE[e.status]}>{EMAIL_STATUS_LABEL[e.status]}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon={<Mail className="size-5" />} title="No emails yet" description="Write to everyone, a department, a designation, a group or chosen people." />}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
