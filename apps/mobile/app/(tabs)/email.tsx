import { htmlToText } from '@crew/contracts';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useMobileApp } from '../../src/lib/mobile-app';
import { useSession } from '../../src/lib/session';
import type { InboxEmail, SentEmail } from '../../src/lib/types';
import { Badge, Button, Card, Choice, fmt, Notice, Screen, useLoad, useReloadOnFocus } from '../../src/ui';
import { EmptyState, IconRow, ModuleGate, SkeletonCard } from '../../src/ui/kit';

type Box = 'inbox' | 'sent' | 'drafts';
const STATUS: Record<SentEmail['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' }> = {
  draft: { label: 'Draft', tone: 'neutral' }, sending: { label: 'Sending', tone: 'info' }, sent: { label: 'Sent', tone: 'ok' },
  partly_failed: { label: 'Some failed', tone: 'warn' }, failed: { label: 'Failed', tone: 'danger' },
};

/** Emails HR sent the person; for people who email employees, also what they sent and their drafts. */
function Email() {
  const { api } = useSession();
  const { app, has } = useMobileApp();
  const router = useRouter();
  const sentOn = has('email.sent');
  const composeOn = has('email.compose');
  const [box, setBox] = useState<Box>('inbox');
  const ready = app?.setup?.email !== false;
  const { data, error, loading, reload } = useLoad(async () => {
    if (box === 'inbox') return { inbox: (await api.get<{ items: InboxEmail[] }>('/communication/emails/inbox')).items, sent: null };
    const r = await api.get<{ items: SentEmail[] }>(`/communication/emails?limit=50${box === 'drafts' ? '&status=draft' : ''}`);
    return { inbox: null, sent: r.items.filter((e) => (box === 'drafts' ? e.status === 'draft' : e.status !== 'draft')) };
  }, [api, box]);
  useReloadOnFocus(reload);

  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      {!ready && (
        <Card testID="email-setup">
          <EmptyState
            icon="mail-unread"
            tone="teal"
            title="Email is not set up yet"
            body={composeOn
              ? 'Your company has not connected an email server, so emails cannot be delivered. The Super Workspace adds one in Settings › Integrations on the Web Portal.'
              : 'Your company has not connected email to SampCrew yet. Emails HR sends you will show here once it is set up.'}
          />
        </Card>
      )}
      {composeOn && ready && <Button title="New email" onPress={() => router.push('/email/compose')} testID="email-compose" />}
      {sentOn && (
        <Choice<Box> value={box} onChange={setBox} options={[{ value: 'inbox', label: 'Inbox' }, { value: 'sent', label: 'Sent' }, { value: 'drafts', label: 'Drafts' }]} />
      )}
      {error && <Notice tone={data ? 'warn' : 'danger'}>{error}</Notice>}
      {!data && !error && <SkeletonCard lines={4} />}
      {data?.inbox && (data.inbox.length === 0 ? (
        ready && <EmptyState icon="mail" tone="teal" title="No emails yet" body="Emails HR sends you through SampCrew show here as well as in your mailbox." />
      ) : (
        <Card testID="email-inbox">
          {data.inbox.map((e) => (
            <IconRow key={e.id} icon="mail" tone="teal" title={e.subject} subtitle={`${e.sentByName ?? 'HR'} · ${e.sentAt ? fmt.dateTime(e.sentAt) : ''}\n${htmlToText(e.html).slice(0, 100)}`} onPress={() => router.push(`/email/${e.id}?box=inbox`)} />
          ))}
        </Card>
      ))}
      {data?.sent && (data.sent.length === 0 ? (
        <EmptyState icon={box === 'drafts' ? 'create' : 'send'} tone="teal" title={box === 'drafts' ? 'No drafts' : 'Nothing sent yet'} />
      ) : (
        <Card testID={`email-${box}`}>
          {data.sent.map((e) => (
            <IconRow
              key={e.id}
              icon={box === 'drafts' ? 'create' : 'send'}
              tone="teal"
              title={e.subject || '(No subject)'}
              subtitle={`${e.audienceLabel}${e.sentAt ? ` · ${fmt.dateTime(e.sentAt)}` : e.updatedAt ? ` · saved ${fmt.dateTime(e.updatedAt)}` : ''}${e.recipientCount ? ` · ${e.sentCount ?? 0} of ${e.recipientCount} delivered` : ''}`}
              right={<Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>}
              onPress={() => router.push(box === 'drafts' ? `/email/compose?draft=${e.id}` : `/email/${e.id}?box=sent`)}
            />
          ))}
        </Card>
      ))}
    </Screen>
  );
}

export default function EmailScreen() {
  return (
    <ModuleGate module="email">
      <Email />
    </ModuleGate>
  );
}
