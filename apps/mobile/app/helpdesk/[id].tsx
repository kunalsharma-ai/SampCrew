import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ApiError } from '../../src/lib/api';
import { caseStatus, caseStatusHandler, moveLabel, target } from '../../src/lib/labels';
import { useSession } from '../../src/lib/session';
import type { CaseDetail } from '../../src/lib/types';
import { Badge, Button, Card, Choice, Field, fmt, Loading, Notice, Row, Screen, Text, useLoad, useTheme, CardTitle } from '../../src/ui';

export default function CaseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const t = useTheme();
  const { data: c, error, reload } = useLoad(() => api.get<CaseDetail>(`/helpdesk/cases/${id}`), [api, id]);
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  const act = async (name: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(name);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'ok', text: done });
      await reload();
      return true;
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : 'Something went wrong.' });
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!c) return <Screen>{error ? <Notice tone="danger">{error}</Notice> : <Loading />}</Screen>;
  const labels = c.role === 'handler' ? caseStatusHandler : caseStatus;
  const resolving = reply.trim().length > 0;

  return (
    <Screen onRefresh={reload}>
      <Stack.Screen options={{ title: c.ref }} />
      {msg && <Notice tone={msg.tone} testID="case-message">{msg.text}</Notice>}
      <Card testID="case-header">
        <Text size={18} weight="700">{c.subject}</Text>
        <Row style={{ flexWrap: 'wrap' }}>
          <Badge tone={c.status === 'waiting_on_employee' ? 'warn' : c.status === 'resolved' || c.status === 'closed' ? 'ok' : 'info'}>{labels[c.status]}</Badge>
          <Badge>{c.categoryName}</Badge>
          {c.confidential && <Badge tone="warn">Confidential</Badge>}
          {c.priority !== 'normal' && <Badge tone={c.priority === 'urgent' || c.priority === 'high' ? 'danger' : 'neutral'}>{c.priority}</Badge>}
        </Row>
        <Text muted size={13}>{`${c.employeeName} · ${c.assigneeName ? `with ${c.assigneeName}` : 'not assigned yet'}`}</Text>
        {c.role === 'handler' && (
          <Text muted size={13}>{`First reply: ${target[c.firstResponse]?.label} · Resolution: ${target[c.resolution]?.label}`}</Text>
        )}
        {c.status === 'waiting_on_employee' && c.role === 'requester' && <Notice tone="warn">HR is waiting for your reply.</Notice>}
        {c.status === 'resolved' && c.role === 'requester' && <Notice tone="ok">HR has marked this as resolved. Confirm it is solved, or reopen it if not. It closes on its own after 7 days.</Notice>}
      </Card>

      <Card testID="conversation">
        <CardTitle>Conversation</CardTitle>
        <View style={{ gap: 4 }}>
          <Text muted size={12}>{`${c.employeeName} · ${fmt.dateTime(c.createdAt)}`}</Text>
          <Text>{c.description}</Text>
        </View>
        {c.messages.map((m) => (
          <View key={m.id} style={{ gap: 4, padding: 10, borderRadius: 10, backgroundColor: m.internal ? t.warnBg : m.fromHr ? t.infoBg : t.bg }}>
            <Text muted size={12}>{`${m.authorName}${m.fromHr ? ' (HR)' : ''}${m.internal ? ' · internal note' : ''} · ${fmt.dateTime(m.createdAt)}`}</Text>
            <Text>{m.body}</Text>
          </View>
        ))}
      </Card>

      {c.can.reply && (
        <Card>
          <Field label={internal ? 'Internal note (HR only)' : 'Reply'} value={reply} onChangeText={setReply} multiline maxLength={5000} />
          {c.can.internalNote && <Choice value={internal ? 'note' : 'reply'} onChange={(v) => setInternal(v === 'note')} options={[{ value: 'reply', label: 'Reply to employee' }, { value: 'note', label: 'Internal note' }]} />}
          <Button
            title="Send"
            disabled={!reply.trim()}
            busy={busy === 'reply'}
            testID="send-reply"
            onPress={async () => {
              if (await act('reply', () => api.post(`/helpdesk/cases/${c.id}/messages`, { body: reply.trim(), internal }), 'Sent.')) setReply('');
            }}
          />
        </Card>
      )}

      {c.moves.length > 0 && (
        <Card>
          <CardTitle>Next step</CardTitle>
          {c.moves.includes('resolved') && <Text muted size={13}>To resolve, write the answer in the reply box first; it is sent with the resolution.</Text>}
          {c.moves.map((s) => (
            <Button
              key={s}
              kind={s === 'closed' || s === 'resolved' ? 'primary' : 'secondary'}
              title={moveLabel[s] ?? s}
              busy={busy === s}
              disabled={s === 'resolved' && !resolving}
              testID={`move-${s}`}
              onPress={async () => {
                const body = s === 'resolved' || (s === 'open' && resolving) ? { status: s, message: reply.trim() } : { status: s };
                if (await act(s, () => api.post(`/helpdesk/cases/${c.id}/status`, body), s === 'closed' ? 'Thanks. The case is closed.' : s === 'open' ? 'Case reopened. HR has been told.' : 'Updated.')) setReply('');
              }}
            />
          ))}
        </Card>
      )}

      {c.can.rate && (
        <Card testID="rate-card">
          <CardTitle>How did HR handle this?</CardTitle>
          <Choice value={String(rating)} onChange={(v) => setRating(Number(v))} options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n}` }))} />
          <Field label="Comment (optional)" value={comment} onChangeText={setComment} maxLength={1000} />
          <Button title="Send rating" disabled={!rating} busy={busy === 'rate'} onPress={() => act('rate', () => api.post(`/helpdesk/cases/${c.id}/rating`, { rating, comment: comment.trim() }), 'Thanks for the feedback.')} />
        </Card>
      )}
      {c.satisfaction !== null && <Text muted size={13}>{`Rated ${c.satisfaction} out of 5.`}</Text>}
    </Screen>
  );
}
