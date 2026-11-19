import { useRouter } from 'expo-router';
import { appraisalStage } from '../../src/lib/labels';
import { useSession } from '../../src/lib/session';
import type { AppraisalBrief } from '../../src/lib/types';
import { Badge, Card, CardTitle, Empty, fmt, ListItem, Loading, Meter, Notice, Screen, Text, useLoad, useReloadOnFocus } from '../../src/ui';

/** My appraisals: the current one first, with what I need to do. */
export default function AppraisalsScreen() {
  const { api } = useSession();
  const router = useRouter();
  const { data, error, loading, reload } = useLoad(() => api.get<AppraisalBrief[]>('/appraisals/mine'), [api]);
  useReloadOnFocus(reload);
  const current = data?.find((a) => a.stage === 'self');

  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      {error && <Notice tone="danger">{error}</Notice>}
      {!data && !error && <Loading />}
      {current && (
        <Card testID="appraisal-current">
          <CardTitle right={current.overdue ? <Badge tone="danger">Overdue</Badge> : undefined} help="appraisal.list">Your self-appraisal</CardTitle>
          <Text weight="600">{current.cycleName}</Text>
          <Text muted size={13}>{`${fmt.date(current.periodStart)} to ${fmt.date(current.periodEnd)}${current.selfDue ? ` · due ${fmt.date(current.selfDue)}` : ''}`}</Text>
          <Meter label="Answered" value={current.selfCompletion} max={100} caption={`${current.selfCompletion}%`} />
          <ListItem title={current.selfCompletion ? 'Continue' : 'Start'} subtitle={current.formTitle} onPress={() => router.push(`/appraisal/${current.id}`)} testID="appraisal-open-current" />
        </Card>
      )}
      <Card testID="appraisal-list">
        <CardTitle>All appraisals</CardTitle>
        {data?.length === 0 && <Empty>No appraisals yet. HR opens one for you when a cycle starts.</Empty>}
        {data?.map((a) => (
          <ListItem
            key={a.id}
            testID={`appraisal-${a.id}`}
            title={a.cycleName}
            subtitle={a.stage === 'published' && a.finalPercent !== null ? `${a.finalPercent}% · ${a.band ?? ''}` : appraisalStage[a.stage] ?? a.stage}
            right={<Badge tone={a.stage === 'published' ? 'ok' : a.stage === 'self' ? 'warn' : 'info'}>{a.stage === 'published' ? 'Result' : appraisalStage[a.stage] ?? a.stage}</Badge>}
            onPress={() => router.push(`/appraisal/${a.id}`)}
          />
        ))}
      </Card>
    </Screen>
  );
}
