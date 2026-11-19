import { Badge, Card, EmptyState, PageHeader, buttonClass, cn } from '@crew/ui';
import { Mail, Paperclip, Send } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { RichTextView } from '@/components/rich-text';
import { CommTabs } from '../comm-tabs';
import { EMAIL_STATUS_LABEL, EMAIL_STATUS_TONE, type ConversationList, type EmailRow, type InboxEmail } from '../types';

export const metadata: Metadata = { title: 'Emails' };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const FILTERS = [[null, 'All'], ['draft', 'Drafts'], ['sending', 'Sending'], ['sent', 'Sent'], ['partly_failed', 'Partly failed'], ['failed', 'Failed']] as const;

export default async function EmailsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const { status, q } = await searchParams;
  const me = await load<Me>('/me');
  const isHr = can(me, 'helpdesk:manage');
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}) });
  const [list, inbox, chats] = await Promise.all([
    isHr ? load<{ items: EmailRow[] }>(`/communication/emails?${qs}`) : Promise.resolve(null),
    load<{ items: InboxEmail[] }>('/communication/emails/inbox'),
    load<ConversationList>('/communication/conversations'),
  ]);
  return (
    <>
      <PageHeader
        title="Communication"
        description={isHr ? 'Emails to everyone, departments, designations, groups or chosen people, sent through your email provider. Each person gets their own copy.' : 'Emails HR sent you, to read here too.'}
        actions={isHr ? <Link href="/communication/emails/new" className={buttonClass('primary', 'sm')}><Send className="size-3.5" /> New email</Link> : undefined}
      />
      <CommTabs active="emails" isHr={isHr} unread={chats.unread} />
      {list && (
        <section className="grid gap-3" aria-label="Emails from HR">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              {FILTERS.map(([k, label]) => (
                <Link key={label} href={`/communication/emails${k ? `?status=${k}` : ''}`} className={cn('rounded-md px-2.5 py-1 text-xs', (status ?? null) === k ? 'bg-accent-subtle font-semibold text-fg' : 'text-fg-muted hover:bg-bg-subtle')}>{label}</Link>
              ))}
            </div>
            <form className="flex gap-2"><input type="hidden" name="status" value={status ?? ''} /><input name="q" defaultValue={q} placeholder="Search subject or text" aria-label="Search emails" className="h-8 w-56 rounded-md border border-border bg-surface px-3 text-[0.8125rem]" /></form>
          </div>
          {list.items.length === 0 ? (
            <Card><EmptyState icon={<Mail className="size-5" />} title="No emails here" description="Write to everyone, a department, a designation, a group or chosen people." action={<Link href="/communication/emails/new" className={buttonClass('primary', 'sm')}>New email</Link>} /></Card>
          ) : (
            <Card className="divide-y divide-border p-0" data-testid="email-list">
              {list.items.map((e) => (
                <Link key={e.id} href={`/communication/emails/${e.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-bg-subtle" data-testid="email-row">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[0.8125rem] font-semibold">{e.subject || '(no subject)'}</span>
                      <Badge tone={EMAIL_STATUS_TONE[e.status]}>{EMAIL_STATUS_LABEL[e.status]}</Badge>
                      {e.fileCount > 0 && <Paperclip className="size-3.5 text-fg-subtle" aria-label={`${e.fileCount} attachments`} />}
                    </div>
                    <p className="truncate text-xs text-fg-muted">To {e.audienceLabel}{e.status !== 'draft' ? ` · ${e.sentCount} of ${e.recipientCount} delivered${e.failedCount ? `, ${e.failedCount} not delivered` : ''}` : ''}</p>
                  </div>
                  <span className="hidden text-xs text-fg-subtle sm:block" suppressHydrationWarning>{when(e.sentAt ?? e.updatedAt)}</span>
                </Link>
              ))}
            </Card>
          )}
        </section>
      )}
      <section className={cn('grid gap-3', list && 'mt-8')} aria-label="Emails to you">
        {list && <h2 className="text-sm font-semibold">Emails to you</h2>}
        {inbox.items.length === 0 ? (
          <Card><EmptyState icon={<Mail className="size-5" />} title="No emails from HR yet" description="Emails HR sends you appear here as well as in your mailbox." /></Card>
        ) : inbox.items.map((e) => (
          <details key={e.id} className="rounded-xl border border-border bg-surface shadow-card" data-testid="inbox-email">
            <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3">
              <span className="min-w-0"><span className="block truncate text-[0.8125rem] font-semibold">{e.subject}</span><span className="text-xs text-fg-muted">From {e.sentByName ?? 'HR'}</span></span>
              <span className="text-xs text-fg-subtle" suppressHydrationWarning>{when(e.sentAt)}</span>
            </summary>
            <div className="border-t border-border px-4 py-3">
              <RichTextView html={e.html} />
              {e.files.length > 0 && <ul className="mt-3 flex flex-wrap gap-2">{e.files.map((f) => <li key={f.id}><a href={f.href} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-bg-subtle"><Paperclip className="size-3" /> {f.name}</a></li>)}</ul>}
            </div>
          </details>
        ))}
      </section>
    </>
  );
}
