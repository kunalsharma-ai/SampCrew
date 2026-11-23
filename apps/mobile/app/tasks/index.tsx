import { useRouter } from 'expo-router';
import { useState } from 'react';
import { taskStatusLabel, taskTone } from '../../src/lib/labels';
import { useSession } from '../../src/lib/session';
import type { MyTask, TaskCounts } from '../../src/lib/types';
import { Badge, Card, CardTitle, Choice, Empty, fmt, ListItem, Loading, Notice, Screen, Text, Tile, TileGrid, useLoad, useReloadOnFocus } from '../../src/ui';
import { ModuleGate } from '../../src/ui/kit';


/** My HR Tasks and Manager Tasks, open ones first. */
function TasksScreenBody() {
  const { api } = useSession();
  const router = useRouter();
  const [category, setCategory] = useState<'hr' | 'manager'>('hr');
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const { data, error, loading, reload } = useLoad(async () => {
    const [counts, tasks] = await Promise.all([api.get<TaskCounts>('/tasks/counts'), api.get<MyTask[]>(`/tasks?scope=mine&category=${category}&status=${status === 'open' ? 'open' : 'all'}`)]);
    return { counts, tasks };
  }, [api, category, status]);
  useReloadOnFocus(reload);
  const c = data?.counts[category];

  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      <Choice value={category} onChange={setCategory} options={[{ value: 'hr', label: `HR tasks${data ? ` (${data.counts.hr.open})` : ''}` }, { value: 'manager', label: `Manager tasks${data ? ` (${data.counts.manager.open})` : ''}` }]} />
      {error && <Notice tone="danger">{error}</Notice>}
      {c && (
        <TileGrid>
          <Tile testID="tasks-open" tone="violet" icon="☰" value={String(c.open)} label="Open" />
          <Tile tone="orange" icon="!" value={String(c.overdue)} label="Overdue" />
          <Tile tone="blue" icon="★" value={String(c.new)} label="New" />
          <Tile tone="teal" icon="✓" value={String(c.review)} label="In review" />
        </TileGrid>
      )}
      <Card testID="tasks-list">
        <CardTitle help="tasks.list" right={<Choice value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]} />}>
          {category === 'hr' ? 'From HR' : 'From your manager'}
        </CardTitle>
        {!data && !error && <Loading />}
        {data?.tasks.length === 0 && <Empty>{status === 'open' ? 'Nothing open. Well done.' : 'No tasks yet.'}</Empty>}
        {data?.tasks.map((t) => (
          <ListItem
            key={t.id}
            testID={`task-${t.id}`}
            title={t.title}
            subtitle={`${t.kind === 'document' ? 'Upload a document' : t.kind === 'acknowledgement' ? 'Read and confirm' : 'Task'}${t.dueOn ? ` · due ${fmt.date(t.dueOn)}` : ''}${t.assignedBy ? ` · ${t.assignedBy}` : ''}`}
            right={<Badge tone={taskTone(t.displayStatus)}>{taskStatusLabel(t.displayStatus)}</Badge>}
            onPress={() => router.push(`/tasks/${t.id}`)}
          />
        ))}
      </Card>
      {data && <Text muted size={12}>Overdue tasks are open tasks past their due date.</Text>}
    </Screen>
  );
}

export default function TasksScreen() {
  return (
    <ModuleGate module="tasks">
      <TasksScreenBody />
    </ModuleGate>
  );
}
