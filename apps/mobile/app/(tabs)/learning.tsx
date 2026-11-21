import { useState } from 'react';
import { View } from 'react-native';
import { useMobileApp } from '../../src/lib/mobile-app';
import { openUrl } from '../../src/lib/open';
import { useSession } from '../../src/lib/session';
import type { Course, LearningAssignment } from '../../src/lib/types';
import { Badge, Button, Card, Choice, errorText, fmt, Meter, Notice, Screen, Text, Tile, TileGrid, useLoad, useReloadOnFocus } from '../../src/ui';
import { EmptyState, Icon3D, ModuleGate, Section, SkeletonCard } from '../../src/ui/kit';

const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' }> = {
  assigned: { label: 'Not started', tone: 'neutral' }, in_progress: { label: 'In progress', tone: 'info' }, completed: { label: 'Completed', tone: 'ok' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** Courses assigned to the person with due dates and progress, starting and completing them, and the course library. */
function Learning() {
  const { api } = useSession();
  const { has } = useMobileApp();
  const progressOn = has('learning.progress');
  const catalogueOn = has('learning.catalogue');
  const [view, setView] = useState<'mine' | 'library'>('mine');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mine = useLoad(() => api.get<LearningAssignment[]>('/learning/assignments?view=mine'), [api], api.peek<LearningAssignment[]>('/learning/assignments?view=mine'));
  const library = useLoad(() => (catalogueOn && view === 'library' ? api.get<Course[]>('/learning/courses') : Promise.resolve(null)), [api, catalogueOn, view]);
  useReloadOnFocus(mine.reload);

  const act = async (key: string, run: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await run();
      setMsg({ tone: 'ok', text: done });
      await mine.reload();
      if (view === 'library') await library.reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };
  const list = mine.data ?? [];
  const open = list.filter((a) => a.status === 'assigned' || a.status === 'in_progress');
  const done = list.filter((a) => a.status === 'completed');
  const overdue = open.filter((a) => a.overdue).length;

  return (
    <Screen onRefresh={() => void mine.reload()} refreshing={mine.loading && !!mine.data}>
      {msg && <Notice tone={msg.tone} testID="learning-message">{msg.text}</Notice>}
      {mine.error && <Notice tone={mine.data ? 'warn' : 'danger'}>{mine.error}</Notice>}
      {mine.data && (
        <TileGrid>
          <Tile testID="tile-learning-open" tone="green" icon="school" value={String(open.length)} label="To do" hint={overdue ? `${overdue} overdue` : 'Assigned to you'} />
          <Tile testID="tile-learning-done" tone="teal" icon="ribbon" value={String(done.length)} label="Completed" hint="All time" />
        </TileGrid>
      )}
      {mine.data && list.length > 0 && <Meter label="Your progress" value={done.length} max={done.length + open.length || 1} caption={`${done.length} of ${done.length + open.length} courses completed`} />}
      {catalogueOn && <Choice<'mine' | 'library'> value={view} onChange={setView} options={[{ value: 'mine', label: 'My learning' }, { value: 'library', label: 'Course library' }]} />}

      {view === 'mine' && (
        <>
          {!mine.data && !mine.error && <SkeletonCard lines={4} />}
          {mine.data && open.length === 0 && done.length === 0 && <EmptyState icon="school" tone="green" title="No courses yet" body={catalogueOn ? 'Courses your manager or HR assigns show here. You can also enrol in one from the course library.' : 'Courses your manager or HR assigns show here.'} />}
          {open.length > 0 && <Section title="To do" />}
          {open.map((a) => (
            <Card key={a.id} testID={`assignment-${a.id}`}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                <Icon3D name="school" tone="green" size={44} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text weight="700">{a.courseTitle}</Text>
                  <Text muted size={13}>{[a.pathTitle, a.durationMinutes ? `${a.durationMinutes} min` : null, a.dueOn ? `due ${fmt.date(a.dueOn)}` : null].filter(Boolean).join(' · ') || 'No due date'}</Text>
                </View>
                <Badge tone={a.overdue ? 'danger' : STATUS[a.status]?.tone}>{a.overdue ? 'Overdue' : (STATUS[a.status]?.label ?? a.status)}</Badge>
              </View>
              {a.contentUrl && <Button title="Open the course" kind="secondary" onPress={() => void openUrl(a.contentUrl!)} />}
              {progressOn && a.status === 'assigned' && <Button title="Start" busy={busy === `start-${a.id}`} onPress={() => act(`start-${a.id}`, () => api.post(`/learning/assignments/${a.id}/start`), `Started ${a.courseTitle}.`)} testID="learning-start" />}
              {progressOn && a.status === 'in_progress' && <Button title="Mark complete" busy={busy === `done-${a.id}`} onPress={() => act(`done-${a.id}`, () => api.post(`/learning/assignments/${a.id}/complete`, { note: '' }), `Completed ${a.courseTitle}. Well done.`)} testID="learning-complete" />}
            </Card>
          ))}
          {done.length > 0 && <Section title="Completed" />}
          {done.length > 0 && (
            <Card testID="learning-done">
              {done.map((a) => (
                <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
                  <Icon3D name="checkmark" tone="teal" size={32} />
                  <View style={{ flex: 1 }}>
                    <Text weight="600">{a.courseTitle}</Text>
                    <Text muted size={13}>{`${a.completedOn ? `Completed ${fmt.date(a.completedOn)}` : 'Completed'}${a.expired ? ' · expired, take it again' : ''}`}</Text>
                  </View>
                </View>
              ))}
            </Card>
          )}
        </>
      )}

      {view === 'library' && (
        <>
          {library.error && <Notice tone="danger">{library.error}</Notice>}
          {!library.data && !library.error && <SkeletonCard lines={4} />}
          {library.data && library.data.length === 0 && <EmptyState icon="library" tone="green" title="The library is empty" body="HR has not added courses yet." />}
          {library.data?.map((c) => (
            <Card key={c.id} testID={`course-${c.id}`}>
              <Text weight="700">{c.title}</Text>
              {c.description ? <Text muted size={14} numberOfLines={3}>{c.description}</Text> : null}
              <Text muted size={13}>{[c.format, c.durationMinutes ? `${c.durationMinutes} min` : null].filter(Boolean).join(' · ')}</Text>
              {c.myStatus ? (
                <Badge tone={STATUS[c.myStatus]?.tone}>{STATUS[c.myStatus]?.label ?? c.myStatus}</Badge>
              ) : c.selfEnrol ? (
                <Button title="Enrol" busy={busy === `enrol-${c.id}`} onPress={() => act(`enrol-${c.id}`, () => api.post(`/learning/courses/${c.id}/enrol`), `Enrolled in ${c.title}. It is in My learning.`)} testID="learning-enrol" />
              ) : (
                <Text muted size={13}>Assigned by your manager or HR.</Text>
              )}
            </Card>
          ))}
        </>
      )}
    </Screen>
  );
}

export default function LearningScreen() {
  return (
    <ModuleGate module="learning">
      <Learning />
    </ModuleGate>
  );
}
