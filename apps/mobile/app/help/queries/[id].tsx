import type { HelpQueryDetail } from '@crew/contracts';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { randomId } from '../../../src/lib/clock';
import { useSession } from '../../../src/lib/session';
import { Badge, Button, Card, CardTitle, Field, Notice, Row, Screen, Text, Title, errorText, fmt, useLoad, useTheme } from '../../../src/ui';

/** One query: the conversation, replying, closing, reopening and rating. */
export default function QueryScreen() {
  const { api } = useSession();
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: d, error, reload } = useLoad(() => api.get<HelpQueryDetail>(`/help/queries/${id}`), [api, id]);
  const [text, setText] = useState('');
  const [rating, setRating] = useState(0);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (what: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(what);
    try { await fn(); setMsg({ tone: 'ok', text: ok }); reload(); } catch (e) { setMsg({ tone: 'danger', text: errorText(e) }); } finally { setBusy(null); }
  };
  return (
    <Screen onRefresh={reload}>
      {error && <Notice tone="danger">{error}</Notice>}
      {msg && <Notice tone={msg.tone} testID="query-message">{msg.text}</Notice>}
      {d && (
        <>
          <Row style={{ gap: 6 }}><Badge tone="info">{d.ticketId}</Badge><Badge tone={d.status === 'resolved' ? 'ok' : 'neutral'}>{d.statusLabel}</Badge></Row>
          <Title>{d.subject}</Title>
          <Text muted size={13}>{`${d.category.label} · with ${d.hrWorkspace ? `${d.hrWorkspace.name} HR Workspace` : d.routeLabel}`}</Text>
          <Card><Text>{d.description}</Text>{d.files.map((f) => <Text key={f.id} muted size={13}>{`📎 ${f.name}`}</Text>)}</Card>
          <Card testID="query-messages">
            <CardTitle>Conversation</CardTitle>
            {d.messages.map((m) => m.kind === 'event'
              ? <Text key={m.id} muted size={12}>{`• ${m.body} · ${fmt.date(m.createdAt)}`}</Text>
              : (
                <View key={m.id} style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '88%', backgroundColor: m.mine ? t.accent : t.infoBg, borderRadius: 14, padding: 10, gap: 2 }}>
                  <Text size={12} weight="600" style={{ color: m.mine ? t.accentFg : t.fg }}>{m.mine ? 'You' : `${m.author?.name ?? 'SampCrew'} · ${m.author?.levelLabel ?? ''}`}</Text>
                  <Text style={{ color: m.mine ? t.accentFg : t.fg }}>{m.body}</Text>
                </View>
              ))}
          </Card>
          {d.can.reply && (
            <Card>
              <Field label="Reply" value={text} onChangeText={setText} multiline maxLength={5000} testID="query-reply" />
              <Button title="Send reply" disabled={!text.trim()} busy={busy === 'reply'} onPress={() => void run('reply', async () => { await api.post(`/help/queries/${d.id}/replies`, { body: text.trim(), clientId: randomId() }); setText(''); }, 'Reply sent.')} testID="query-reply-send" />
            </Card>
          )}
          {d.can.close && <Button title="Close query" kind="secondary" busy={busy === 'close'} onPress={() => void run('close', () => api.put(`/help/queries/${d.id}/status`, { status: 'closed' }), 'Query closed.')} testID="query-close" />}
          {d.can.reopen && <Button title="Reopen query" kind="secondary" busy={busy === 'reopen'} onPress={() => void run('reopen', () => api.put(`/help/queries/${d.id}/status`, { status: 'open' }), 'Query reopened.')} testID="query-reopen" />}
          {d.can.rate && (
            <Card testID="query-rate">
              <CardTitle>How did we do?</CardTitle>
              <Row style={{ gap: 4 }}>{[1, 2, 3, 4, 5].map((n) => <Button key={n} title={n <= rating ? '★' : '☆'} kind="secondary" onPress={() => setRating(n)} />)}</Row>
              <Button title="Send rating" disabled={!rating} busy={busy === 'rate'} onPress={() => void run('rate', () => api.post(`/help/queries/${d.id}/rating`, { rating }), 'Thanks for your rating.')} />
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}
