import { useState } from 'react';
import { FlatList, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { dayStatus } from '../../src/lib/labels';
import { useSession } from '../../src/lib/session';
import type { TeamAttendance } from '../../src/lib/types';
import { Badge, Choice, fmt, Notice, Text, Tile, TileGrid, useLoad, useTheme } from '../../src/ui';
import { IconRow, ModuleGate, SkeletonCard } from '../../src/ui/kit';

const FILTERS = [
  { value: 'all', label: 'Everyone' },
  { value: 'present', label: 'Present' },
  { value: 'late', label: 'Late' },
  { value: 'absent', label: 'Absent' },
  { value: 'on_leave', label: 'On leave' },
] as const;
type Filter = (typeof FILTERS)[number]['value'];

/** Today's attendance of the people the person may see (their permissions decide whom), with counts by status. */
function Team() {
  const { api, me } = useSession();
  const t = useTheme();
  const [filter, setFilter] = useState<Filter>('all');
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: me?.tenant.timezone }).format(new Date());
  const { data, error, loading, reload } = useLoad(() => api.get<TeamAttendance>(`/attendance/team?date=${date}`), [api, date]);
  const s = data?.summary ?? {};
  const rows = (data?.rows ?? []).filter((r) => filter === 'all' || (filter === 'late' ? r.lateMinutes > 0 : r.status === filter));

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.employeeId}
        refreshing={loading && !!data}
        onRefresh={reload}
        contentContainerStyle={{ padding: 16, gap: 4, paddingBottom: 40 }}
        initialNumToRender={20}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 8 }}>
            {error && <Notice tone="danger">{error}</Notice>}
            {!data && !error && <SkeletonCard lines={3} />}
            {data && (
              <TileGrid>
                <Tile testID="team-present" tone="green" icon="checkmark-circle" value={String((s.present ?? 0) + (s.in_progress ?? 0))} label="In today" hint={`${s.onSiteNow ?? 0} on site now`} />
                <Tile testID="team-late" tone="orange" icon="alarm" value={String(s.late ?? 0)} label="Late" hint={fmt.date(date)} />
                <Tile testID="team-absent" tone="pink" icon="close-circle" value={String((s.absent ?? 0) + (s.missing_punch ?? 0))} label="Absent or missing" hint={`${s.total ?? 0} people`} />
                <Tile testID="team-leave" tone="blue" icon="sunny" value={String(s.on_leave ?? 0)} label="On leave" hint="Approved leave" />
              </TileGrid>
            )}
            <Choice<Filter> value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
          </View>
        }
        ListEmptyComponent={data ? <Text muted style={{ textAlign: 'center' }}>Nobody to show.</Text> : null}
        renderItem={({ item: r }) => (
          <IconRow
            icon="person"
            tone="teal"
            title={r.employeeName}
            subtitle={[r.department, r.firstIn ? `in ${fmt.time(r.firstIn)}` : null, r.lastOut ? `out ${fmt.time(r.lastOut)}` : null, r.lateMinutes ? `${r.lateMinutes} min late` : null].filter(Boolean).join(' · ') || undefined}
            right={<Badge tone={r.status === 'present' || r.status === 'in_progress' ? 'ok' : r.status === 'absent' || r.status === 'missing_punch' ? 'danger' : 'neutral'}>{dayStatus[r.status] ?? r.status.replace(/_/g, ' ')}</Badge>}
          />
        )}
      />
    </SafeAreaView>
  );
}

export default function TeamAttendanceScreen() {
  return (
    <ModuleGate module="attendance" feature="team">
      <Team />
    </ModuleGate>
  );
}
