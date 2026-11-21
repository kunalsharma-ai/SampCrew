import { useRouter } from 'expo-router';
import { appraisalStage, reviewStage } from '../../src/lib/labels';
import { useSession } from '../../src/lib/session';
import type { AppraisalBrief, AppraisalReviewRow } from '../../src/lib/types';
import { Badge, Card, CardTitle, Empty, fmt, ListItem, Loading, Meter, Notice, Screen, Text, useLoad, useReloadOnFocus } from '../../src/ui';
import { ModuleGate } from '../../src/ui/kit';

/** My appraisals (the current one first, with what I need to do), then the ones I review as a manager or HR. */
function AppraisalsScreenBody() {
  const { api } = useSession();
  const router = useRouter();
  const { data, error, loading, reload } = useLoad(() => api.get<AppraisalBrief[]>('/appraisals/mine'), [api]);
  const reviews = useLoad(() => api.get<{ team: AppraisalReviewRow[]; hr: AppraisalReviewRow[]; isHr: boolean }>('/appraisals/reviews'), [api]);
  useReloadOnFocus(() => { reload(); reviews.reload(); });
  const team = reviews.data?.team ?? [];
  const hr = reviews.data?.hr ?? [];
  const reviewList = (rows: AppraisalReviewRow[], waiting: string, testID: string, title: string, help: 'appraisal.team' | 'appraisal.hr', empty: string) => (
    <Card testID={testID}>
      <CardTitle right={rows.some((r) => r.stage === waiting) ? <Badge tone="warn">{`${rows.filter((r) => r.stage === waiting).length} to do`}</Badge> : undefined} help={help}>{title}</CardTitle>
      {!rows.length && <Empty>{empty}</Empty>}
      {rows.map((r) => (
        <ListItem
          key={r.id}
          testID={`review-${r.id}`}
          title={r.employeeName ?? 'Employee'}
          subtitle={`${r.cycleName} · ${r.stage === 'published' && r.finalPercent !== null ? `${r.finalPercent}%` : reviewStage[r.stage] ?? r.stage}`}
          right={<Badge tone={r.stage === waiting ? 'warn' : r.stage === 'published' ? 'ok' : 'info'}>{r.stage === waiting ? 'Your turn' : reviewStage[r.stage] ?? r.stage}</Badge>}
          onPress={() => router.push(`/appraisal/${r.id}`)}
        />
      ))}
    </Card>
  );
  const current = data?.find((a) => a.stage === 'self');

  return (
    <Screen onRefresh={() => { reload(); reviews.reload(); }} refreshing={loading && !!data}>
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
      {team.length > 0 && reviewList(team, 'manager', 'appraisal-team', 'My team', 'appraisal.team', '')}
      {reviews.data?.isHr && reviewList(hr, 'hr', 'appraisal-hr', 'HR review', 'appraisal.hr', 'Appraisals reach HR after the manager submits.')}
    </Screen>
  );
}

export default function AppraisalsScreen() {
  return (
    <ModuleGate module="appraisal">
      <AppraisalsScreenBody />
    </ModuleGate>
  );
}
