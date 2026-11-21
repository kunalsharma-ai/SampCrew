import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useMobileApp } from '../src/lib/mobile-app';
import { useSession } from '../src/lib/session';
import type { Announcement, EmployeeDocument, LearningAssignment } from '../src/lib/types';
import { Card, Field, fmt, Notice, Screen, Text, useLoad } from '../src/ui';
import { EmptyState, IconRow, MODULE_TONE, ModuleGate, Section, SkeletonCard, useDebounced } from '../src/ui/kit';

type Hit = { key: string; module: string; icon: string; title: string; subtitle?: string; route: string };
const match = (text: string | null | undefined, q: string) => (text ?? '').toLowerCase().includes(q);

/**
 * One search box over what the person can see in the modules they have in the app: people, their messages,
 * documents, learning and announcements. Each source is asked only while its module is on, and a source that fails
 * is left out instead of failing the search.
 */
function Search() {
  const { api, me } = useSession();
  const { has, module } = useMobileApp();
  const router = useRouter();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim().toLowerCase(), 350);
  const employeeId = me?.employee?.id;
  const { data, loading } = useLoad(async (): Promise<Hit[] | null> => {
    if (term.length < 2) return null;
    const enc = encodeURIComponent(term);
    const safe = <T,>(p: Promise<T>, empty: T) => p.catch(() => empty);
    const [people, messages, docs, learning, news] = await Promise.all([
      has('directory') ? safe(api.get<{ items: { id: string; displayName: string; departmentName: string | null; designationName: string | null }[] }>(`/employees?limit=8&q=${enc}`), { items: [] }) : { items: [] },
      has('chat.search') ? safe(api.get<{ items: { messageId: string; conversationId: string; conversationTitle: string; senderName: string | null; body: string; createdAt: string }[] }>(`/communication/search?q=${enc}`), { items: [] }) : { items: [] },
      has('documents.mine') && employeeId ? safe(api.get<EmployeeDocument[]>(`/employees/${employeeId}/documents`), []) : [],
      has('learning.assigned') ? safe(api.get<LearningAssignment[]>('/learning/assignments?view=mine'), []) : [],
      has('announcements') ? safe(api.get<Announcement[]>('/announcements'), []) : [],
    ]);
    return [
      ...people.items.map((p) => ({ key: `p-${p.id}`, module: 'directory', icon: 'person', title: p.displayName, subtitle: [p.designationName, p.departmentName].filter(Boolean).join(' · ') || undefined, route: '/directory' })),
      ...messages.items.slice(0, 8).map((m) => ({ key: `m-${m.messageId}`, module: 'chat', icon: 'chatbubble-ellipses', title: m.conversationTitle || m.senderName || 'Message', subtitle: `${m.body.slice(0, 80)} · ${fmt.date(m.createdAt)}`, route: `/chat/${m.conversationId}` })),
      ...docs.filter((d) => match(d.title, term) || match(d.fileName, term)).slice(0, 8).map((d) => ({ key: `d-${d.id}`, module: 'documents', icon: 'document-text', title: d.title, subtitle: d.fileName, route: '/documents' })),
      ...learning.filter((a) => match(a.courseTitle, term)).slice(0, 8).map((a) => ({ key: `l-${a.id}`, module: 'learning', icon: 'school', title: a.courseTitle, subtitle: a.dueOn ? `Due ${fmt.date(a.dueOn)}` : undefined, route: '/learning' })),
      ...news.filter((a) => match(a.title, term) || match(a.body, term)).slice(0, 8).map((a) => ({ key: `a-${a.id}`, module: 'announcements', icon: 'megaphone', title: a.title, subtitle: fmt.date(a.publishedAt), route: `/announcements/${a.id}` })),
    ];
  }, [api, term, employeeId, has]);
  const groups = [...new Set((data ?? []).map((h) => h.module))];

  return (
    <Screen>
      <Field label="Search" value={q} onChangeText={setQ} placeholder="People, messages, documents, courses, news" autoFocus autoCapitalize="none" testID="search-input" />
      {term.length < 2 && <Text muted size={13}>Type at least two letters.</Text>}
      {term.length >= 2 && loading && !data && <SkeletonCard lines={4} />}
      {data && data.length === 0 && <EmptyState icon="search" tone="blue" title="Nothing found" body={`Nothing you can see matches “${q.trim()}”.`} />}
      {groups.map((g) => (
        <Card key={g} testID={`search-${g}`}>
          <Section title={module(g)?.name ?? g} />
          {data!.filter((h) => h.module === g).map((h) => (
            <IconRow key={h.key} icon={h.icon} tone={MODULE_TONE[h.module]} title={h.title} subtitle={h.subtitle} onPress={() => router.push(h.route as never)} />
          ))}
        </Card>
      ))}
      {data && <Notice tone="info">Only what you are allowed to see is searched.</Notice>}
    </Screen>
  );
}

export default function SearchScreen() {
  return (
    <ModuleGate module="home" feature="search">
      <Search />
    </ModuleGate>
  );
}
