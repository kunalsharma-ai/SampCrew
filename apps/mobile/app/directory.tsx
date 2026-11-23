import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMobileApp } from '../src/lib/mobile-app';
import { useSession } from '../src/lib/session';
import { errorText, Field, Notice, Text, useLoad, useTheme } from '../src/ui';
import { IconRow, ModuleGate, SkeletonCard, useDebounced } from '../src/ui/kit';

interface Colleague { id: string; displayName: string; employeeCode: string; departmentName: string | null; designationName: string | null; locationName: string | null; membershipId: string | null }
type Page = { items: Colleague[]; nextCursor: string | null; total: number };

/** Colleagues the person may see (their own access decides whom), searchable, loaded a page at a time. */
function Directory() {
  const { api, me } = useSession();
  const { has } = useMobileApp();
  const router = useRouter();
  const t = useTheme();
  const [q, setQ] = useState('');
  const [more, setMore] = useState<Colleague[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const term = useDebounced(q.trim());
  const path = `/employees?limit=40&sort=name${term ? `&q=${encodeURIComponent(term)}` : ''}`;
  const first = useLoad(async () => {
    const p = await api.get<Page>(path);
    setMore([]);
    setCursor(p.nextCursor);
    return p;
  }, [api, path]);
  const loadMore = useCallback(async () => {
    if (!cursor) return;
    try {
      const p = await api.get<Page>(`${path}&cursor=${encodeURIComponent(cursor)}`);
      setMore((m) => [...m, ...p.items]);
      setCursor(p.nextCursor);
    } catch (e) {
      setError(errorText(e));
    }
  }, [api, cursor, path]);
  const chatOn = has('chat.direct');
  const message = async (c: Colleague) => {
    if (!c.membershipId) return;
    try {
      const r = await api.post<{ id: string }>('/communication/conversations', { kind: 'direct', membershipId: c.membershipId });
      router.push(`/chat/${r.id}`);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const rows = [...(first.data?.items ?? []), ...more];

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        data={rows}
        keyExtractor={(c) => c.id}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.4}
        initialNumToRender={20}
        windowSize={9}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        ListHeaderComponent={
          <View style={{ gap: 10, marginBottom: 8 }}>
            <Field label="Search colleagues" value={q} onChangeText={setQ} placeholder="Name, code or email" autoCapitalize="none" testID="directory-search" />
            {(error || first.error) && <Notice tone="danger">{error ?? first.error}</Notice>}
            {first.data && <Text muted size={13}>{`${first.data.total} ${first.data.total === 1 ? 'person' : 'people'}`}</Text>}
            {!first.data && !first.error && <SkeletonCard lines={5} />}
          </View>
        }
        ListEmptyComponent={first.data ? <Text muted style={{ textAlign: 'center' }}>Nobody matches.</Text> : null}
        renderItem={({ item: c }) => (
          <IconRow
            testID="directory-row"
            icon="person"
            tone="violet"
            title={c.displayName}
            subtitle={[c.designationName, c.departmentName, c.locationName].filter(Boolean).join(' · ') || c.employeeCode}
            onPress={chatOn && c.membershipId && c.membershipId !== me?.membership.id ? () => void message(c) : undefined}
          />
        )}
      />
    </SafeAreaView>
  );
}

export default function DirectoryScreen() {
  return (
    <ModuleGate module="directory">
      <Directory />
    </ModuleGate>
  );
}
