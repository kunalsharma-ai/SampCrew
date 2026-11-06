import { useState } from 'react';
import { ApiError } from '../src/lib/api';
import { useSession } from '../src/lib/session';
import type { InboxItem } from '../src/lib/types';
import { Button, Card, Empty, Field, fmt, Loading, Notice, Row, Screen, Text, useLoad, CardTitle } from '../src/ui';

/** Requests waiting for my decision: leave, corrections, overtime, expenses and the rest. */
export default function Approvals() {
  const { api } = useSession();
  const { data, error, reload, loading } = useLoad(() => api.get<InboxItem[]>('/approvals/inbox'), [api]);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  const decide = async (item: InboxItem, decision: 'approve' | 'reject') => {
    const comment = comments[item.id]?.trim();
    setBusy(`${item.id}:${decision}`);
    setMsg(null);
    try {
      await api.post(`/approvals/${item.id}/${decision}`, comment ? { comment } : {});
      setMsg({ tone: 'ok', text: `${decision === 'approve' ? 'Approved' : 'Rejected'}: ${item.label.toLowerCase()} from ${item.requestedBy}.` });
      await reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : 'Could not record the decision.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      {error && <Notice tone="danger">{error}</Notice>}
      {msg && <Notice tone={msg.tone} testID="approval-message">{msg.text}</Notice>}
      {!data && !error && <Loading />}
      {data?.length === 0 && <Empty>Nothing is waiting for you.</Empty>}
      {data?.map((i) => (
        <Card key={i.id} testID="approval-item">
          <CardTitle>{i.label}</CardTitle>
          <Text>{i.summary}</Text>
          <Text muted size={13}>{`${i.requestedBy} · ${fmt.dateTime(i.createdAt)}${i.stepCount > 1 ? ` · step ${i.stepSeq} of ${i.stepCount}` : ''}`}</Text>
          <Field label="Comment" help="field.comment" value={comments[i.id] ?? ''} onChangeText={(v) => setComments((c) => ({ ...c, [i.id]: v }))} maxLength={1000} placeholder="Optional, shown to the person" />
          <Row>
            <Button title="Approve" busy={busy === `${i.id}:approve`} onPress={() => decide(i, 'approve')} />
            <Button title="Reject" kind="secondary" busy={busy === `${i.id}:reject`} onPress={() => decide(i, 'reject')} />
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
