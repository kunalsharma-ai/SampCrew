import { htmlToText } from '@crew/contracts';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ApiError } from '../../src/lib/api';
import { openSigned } from '../../src/lib/open';
import { useSession } from '../../src/lib/session';
import type { CommFile, InboxEmail, SentEmail } from '../../src/lib/types';
import { Badge, Card, CardTitle, errorText, fmt, ListItem, Notice, Screen, Text, useLoad } from '../../src/ui';
import { IconRow, ModuleGate, SkeletonCard } from '../../src/ui/kit';

type Detail = SentEmail & { html: string; files: CommFile[]; recipients: { id: string; kind: string; address: string; name: string | null; status: string; error: string | null }[] };
const RECIPIENT: Record<string, string> = { queued: 'Waiting', sent: 'Delivered', failed: 'Failed', skipped: 'Skipped' };

/** One email: the message as text and its attachments; for a sent email also who it reached. */
function EmailDetail() {
  const { id, box } = useLocalSearchParams<{ id: string; box?: string }>();
  const { api } = useSession();
  const [error, setError] = useState<string | null>(null);
  const sent = box === 'sent';
  const { data, error: loadError } = useLoad(async () => {
    if (sent) return { kind: 'sent' as const, email: await api.get<Detail>(`/communication/emails/${id}`) };
    const found = (await api.get<{ items: InboxEmail[] }>('/communication/emails/inbox')).items.find((e) => e.id === id);
    if (!found) throw new ApiError(404, 'not_found', 'This email is no longer in your inbox.');
    return { kind: 'inbox' as const, email: found };
  }, [api, id, sent]);
  const open = (f: CommFile) => void openSigned(api, `/communication/files/${f.id}/link`).catch((e) => setError(errorText(e)));
  const e = data?.email;
  return (
    <Screen>
      <Stack.Screen options={{ title: e?.subject ?? 'Email' }} />
      {(loadError || error) && <Notice tone="danger">{error ?? loadError}</Notice>}
      {!data && !loadError && <SkeletonCard lines={6} />}
      {e && (
        <Card testID="email-body">
          <Text weight="700" size={18}>{e.subject}</Text>
          <Text muted size={13}>
            {data.kind === 'inbox' ? `From ${data.email.sentByName ?? 'HR'}` : `To ${data.email.audienceLabel}`}
            {e.sentAt ? ` · ${fmt.dateTime(e.sentAt)}` : ''}
          </Text>
          <Text>{htmlToText(e.html)}</Text>
        </Card>
      )}
      {e && e.files.length > 0 && (
        <Card>
          <CardTitle>Attachments</CardTitle>
          {e.files.map((f) => <IconRow key={f.id} icon="attach" tone="teal" title={f.name} subtitle={`${Math.max(1, Math.round(f.size / 1024))} KB`} onPress={() => open(f)} />)}
        </Card>
      )}
      {data?.kind === 'sent' && (
        <Card testID="email-recipients">
          <CardTitle>{`Recipients (${data.email.recipients.length})`}</CardTitle>
          {data.email.recipients.slice(0, 200).map((r) => (
            <ListItem key={r.id} title={r.name ?? r.address} subtitle={`${r.kind === 'to' ? '' : `${r.kind.toUpperCase()} · `}${r.address}${r.error ? ` · ${r.error}` : ''}`} right={<Badge tone={r.status === 'sent' ? 'ok' : r.status === 'failed' ? 'danger' : 'neutral'}>{RECIPIENT[r.status] ?? r.status}</Badge>} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

export default function EmailDetailScreen() {
  return (
    <ModuleGate module="email">
      <EmailDetail />
    </ModuleGate>
  );
}
