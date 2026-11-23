import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useSession } from '../../src/lib/session';
import type { Person } from '../../src/lib/types';
import { Card, errorText, Field, Notice, Screen, Text, useLoad } from '../../src/ui';
import { IconRow, ModuleGate, SkeletonCard, useDebounced } from '../../src/ui/kit';

/** Pick a colleague to message; opening the same person again returns the existing conversation. */
function NewConversation() {
  const { api } = useSession();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const term = useDebounced(q.trim());
  const { data, loading } = useLoad(() => api.get<{ items: Person[] }>(`/communication/people${term ? `?q=${encodeURIComponent(term)}` : ''}`), [api, term]);
  const start = async (p: Person) => {
    try {
      const c = await api.post<{ id: string }>('/communication/conversations', { kind: 'direct', membershipId: p.membershipId });
      router.replace(`/chat/${c.id}`);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Screen>
      <Field label="Who do you want to message?" value={q} onChangeText={setQ} placeholder="Name, department or designation" autoFocus testID="people-search" />
      {error && <Notice tone="danger">{error}</Notice>}
      {!data && loading && <SkeletonCard lines={5} />}
      {data && (
        <Card testID="people-list">
          {data.items.length === 0 && <Text muted>Nobody matches.</Text>}
          {data.items.map((p) => (
            <IconRow key={p.membershipId} icon="person" tone="blue" title={p.name} subtitle={[p.designation, p.department].filter(Boolean).join(' · ') || undefined} onPress={() => void start(p)} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

export default function NewConversationScreen() {
  return (
    <ModuleGate module="chat" feature="direct">
      <NewConversation />
    </ModuleGate>
  );
}
