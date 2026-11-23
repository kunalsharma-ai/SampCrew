import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useBadges } from '../../src/lib/badges';
import { useMobileApp } from '../../src/lib/mobile-app';
import { useSession } from '../../src/lib/session';
import type { Conversation } from '../../src/lib/types';
import { Button, Card, Field, fmt, Notice, Screen, Text, useLoad, useReloadOnFocus } from '../../src/ui';
import { EmptyState, IconRow, ModuleGate, Section, SkeletonCard, useDebounced } from '../../src/ui/kit';

const KIND_ICON: Record<Conversation['kind'], string> = { direct: 'person', group: 'people', department: 'business', hr: 'help-buoy' };

/** Conversations, newest first, with unread counts; search over the person's own messages when that is on. */
function ChatList() {
  const { api } = useSession();
  const { has } = useMobileApp();
  const badges = useBadges();
  const router = useRouter();
  const [q, setQ] = useState('');
  const searchOn = has('chat.search');
  const term = useDebounced(q.trim());
  const { data, error, loading, reload } = useLoad(
    () => api.get<{ items: Conversation[]; unread: number }>('/communication/conversations'),
    [api],
    api.peek<{ items: Conversation[]; unread: number }>('/communication/conversations'),
  );
  const found = useLoad(
    () => (searchOn && term.length >= 2 ? api.get<{ items: { messageId: string; conversationId: string; conversationTitle: string; senderName: string | null; body: string; createdAt: string }[] }>(`/communication/search?q=${encodeURIComponent(term)}`) : Promise.resolve(null)),
    [api, term, searchOn],
  );
  useReloadOnFocus(() => {
    badges.refresh();
    return reload();
  });
  const groupsOn = has('chat.groups');
  const items = (data?.items ?? []).filter((c) => (c.kind === 'direct' || c.kind === 'hr' ? has('chat.direct') : groupsOn));

  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      {error && <Notice tone={data ? 'warn' : 'danger'}>{data ? `Showing what was loaded earlier. ${error}` : error}</Notice>}
      {has('chat.direct') && <Button title="New conversation" onPress={() => router.push('/chat/new')} testID="chat-new" />}
      {searchOn && <Field label="Search messages" value={q} onChangeText={setQ} placeholder="At least two letters" autoCapitalize="none" testID="chat-search" />}
      {searchOn && term.length >= 2 && (
        <Card testID="chat-results">
          <Section title="Messages found" />
          {found.data?.items.length === 0 && <Text muted>No messages match.</Text>}
          {found.data?.items.slice(0, 20).map((m) => (
            <IconRow key={m.messageId} icon="chatbubble-ellipses" tone="blue" title={m.conversationTitle || m.senderName || 'Message'} subtitle={`${m.body} · ${fmt.dateTime(m.createdAt)}`} onPress={() => router.push(`/chat/${m.conversationId}`)} />
          ))}
        </Card>
      )}
      {!data && !error && <SkeletonCard lines={4} />}
      {data && items.length === 0 && (
        <EmptyState icon="chatbubbles" tone="blue" title="No conversations yet" body="Start one with a colleague. Group and department conversations you belong to show here too." />
      )}
      {items.length > 0 && (
        <Card testID="chat-list">
          {items.map((c) => (
            <IconRow
              key={c.id}
              testID={`conversation-${c.id}`}
              icon={KIND_ICON[c.kind]}
              tone={c.kind === 'hr' ? 'pink' : c.kind === 'direct' ? 'blue' : 'violet'}
              title={c.title}
              subtitle={c.lastMessage ? `${c.lastMessage.senderName ? `${c.lastMessage.senderName}: ` : ''}${c.lastMessage.body || 'Attachment'} · ${fmt.dateTime(c.lastMessage.at)}` : (c.subtitle ?? 'No messages yet')}
              badge={c.muted ? 0 : c.unread}
              onPress={() => router.push(`/chat/${c.id}`)}
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}

export default function ChatScreen() {
  return (
    <ModuleGate module="chat">
      <ChatList />
    </ModuleGate>
  );
}
