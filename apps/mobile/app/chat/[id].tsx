import { COMM_FILE_MAX_BYTES, COMM_FILE_TYPES } from '@crew/contracts';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useBadges } from '../../src/lib/badges';
import { useMobileApp } from '../../src/lib/mobile-app';
import { openSigned } from '../../src/lib/open';
import { photoBytes, pickFile, type PickedPhoto } from '../../src/lib/photo';
import { useSession } from '../../src/lib/session';
import type { ChatMessage, CommFile, ConversationDetail } from '../../src/lib/types';
import { errorText, fmt, Notice, Text, useTheme } from '../../src/ui';
import { Icon, ModuleGate, Skeleton } from '../../src/ui/kit';

/** While a conversation is open it checks for new messages this often (and when the app comes back). */
const POLL_MS = 8_000;
const DELIVERY: Record<NonNullable<ChatMessage['delivery']>, string> = { sent: 'Sent', delivered: 'Delivered', read: 'Read' };

function Bubble({ m, mine, onOpen }: { m: ChatMessage; mine: boolean; onOpen: (f: CommFile) => void }) {
  const t = useTheme();
  if (m.system) return <Text muted size={12} style={{ textAlign: 'center', marginVertical: 6 }}>{m.body}</Text>;
  return (
    <View testID="chat-message" style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '82%', marginVertical: 4 }}>
      {!mine && m.senderName ? <Text muted size={12} style={{ marginLeft: 6 }}>{m.senderName}</Text> : null}
      <View style={{ backgroundColor: mine ? t.accent : t.card, borderRadius: 16, borderWidth: mine ? 0 : 1, borderColor: t.border, paddingHorizontal: 12, paddingVertical: 8, gap: 4 }}>
        {m.deleted ? (
          <Text size={14} style={{ fontStyle: 'italic', color: mine ? t.accentFg : t.muted }}>Message deleted</Text>
        ) : m.body ? (
          <Text size={15} style={{ color: mine ? t.accentFg : t.fg }}>{m.body}</Text>
        ) : null}
        {m.files.map((f) => (
          <Pressable key={f.id} accessibilityRole="link" accessibilityLabel={`Open ${f.name}`} onPress={() => onOpen(f)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="attach" size={16} color={mine ? t.accentFg : t.accent} />
            <Text size={14} weight="600" style={{ color: mine ? t.accentFg : t.accent }} numberOfLines={1}>{f.name}</Text>
          </Pressable>
        ))}
      </View>
      <Text muted size={11} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', marginHorizontal: 6 }}>
        {`${fmt.time(m.createdAt)}${mine && m.delivery ? ` · ${DELIVERY[m.delivery]}` : ''}`}
      </Text>
    </View>
  );
}

function Conversation() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, me } = useSession();
  const { has } = useMobileApp();
  const badges = useBadges();
  const t = useTheme();
  const [data, setData] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [file, setFile] = useState<PickedPhoto | null>(null);
  const [sending, setSending] = useState(false);
  const list = useRef<FlatList<ChatMessage>>(null);
  const attachOn = has('chat.attachments');

  useEffect(() => {
    let live = true;
    // Marks the conversation read on the first load, and again whenever new messages arrive while it is open.
    const cur = { current: false };
    const load = async () => {
      try {
        const d = await api.get<ConversationDetail>(`/communication/conversations/${id}?limit=50`);
        if (!live) return;
        setData((cur) => (cur && JSON.stringify(cur.messages) === JSON.stringify(d.messages) ? cur : d));
        setError(null);
        if (d.conversation.unread > 0 || !cur.current) {
          cur.current = true;
          await api.post(`/communication/conversations/${id}/read`).catch(() => undefined);
          badges.refresh();
        }
      } catch (e) {
        if (live) setError(errorText(e));
      }
    };
    void load();
    const timer = setInterval(() => AppState.currentState === 'active' && void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, id, badges]);

  const send = async () => {
    if (sending || (!body.trim() && !file)) return;
    setSending(true);
    setError(null);
    try {
      const fileIds: string[] = [];
      if (file) {
        const bytes = await photoBytes(file);
        const up = await api.uploadFile<{ id: string }>('POST', '/communication/files', { field: 'file', fileName: file.fileName, type: file.mimeType, bytes });
        fileIds.push(up.id);
      }
      const clientId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const m = await api.post<ChatMessage>(`/communication/conversations/${id}/messages`, { body: body.trim(), fileIds, clientId });
      setData((d) => (d ? { ...d, messages: [...d.messages.filter((x) => x.id !== m.id), m] } : d));
      setBody('');
      setFile(null);
      setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };

  const attach = async () => {
    const r = await pickFile(COMM_FILE_TYPES, COMM_FILE_MAX_BYTES, 'PDF, image, Word, Excel, PowerPoint, text or zip');
    if (r.ok) setFile(r.photo);
    else if (r.message) setError(r.message);
  };
  const open = (f: CommFile) => void openSigned(api, `/communication/files/${f.id}/link`).catch((e) => setError(errorText(e)));
  const myId = me?.membership.id;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{ title: data?.conversation.title ?? 'Conversation' }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        {error && <View style={{ padding: 12 }}><Notice tone="danger" testID="chat-error">{error}</Notice></View>}
        {!data && !error ? (
          <View style={{ padding: 16, gap: 10 }}>
            <Skeleton height={40} width="60%" />
            <Skeleton height={40} width="50%" style={{ alignSelf: 'flex-end' }} />
            <Skeleton height={40} width="70%" />
          </View>
        ) : (
          <FlatList
            ref={list}
            testID="conversation-messages"
            data={data?.messages ?? []}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => <Bubble m={item} mine={item.senderMembershipId === myId} onOpen={open} />}
            contentContainerStyle={{ padding: 12, flexGrow: 1, justifyContent: 'flex-end' }}
            onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
            ListEmptyComponent={<Text muted style={{ textAlign: 'center' }}>No messages yet. Say hello.</Text>}
            initialNumToRender={20}
            windowSize={7}
          />
        )}
        {file && (
          <View testID="chat-attachment" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 6 }}>
            <Icon name="document-attach" size={18} color={t.accent} />
            <Text size={13} style={{ flex: 1 }} numberOfLines={1}>{file.fileName}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Remove attachment" onPress={() => setFile(null)} hitSlop={8}>
              <Icon name="close-circle" size={20} color={t.muted} />
            </Pressable>
          </View>
        )}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.card }}>
          {attachOn && (
            <Pressable accessibilityRole="button" accessibilityLabel="Attach a file" onPress={attach} hitSlop={6} style={{ padding: 8 }} testID="chat-attach">
              <Icon name="attach" size={24} color={t.muted} />
            </Pressable>
          )}
          <TextInput
            testID="chat-input"
            value={body}
            onChangeText={setBody}
            placeholder="Write a message"
            placeholderTextColor={t.muted}
            multiline
            maxLength={4000}
            style={{ flex: 1, minHeight: 40, maxHeight: 120, color: t.fg, backgroundColor: t.bg, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 }}
          />
          <Pressable
            testID="chat-send"
            accessibilityRole="button"
            accessibilityLabel="Send"
            disabled={sending || (!body.trim() && !file)}
            onPress={send}
            style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accent, opacity: sending || (!body.trim() && !file) ? 0.5 : 1 }}
          >
            <Icon name="send" size={18} color={t.accentFg} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default function ConversationScreen() {
  return (
    <ModuleGate module="chat">
      <Conversation />
    </ModuleGate>
  );
}
