import { Alert, Badge, Card, CardBody, CardHeader, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { FEATURE, REDACTION, STATUS } from '../../../../ai/labels';
import type { AiInteraction } from '../../../../ai/types';

export const metadata: Metadata = { title: 'AI call' };

export default async function AiCallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const i = await load<AiInteraction>(`/ai/interactions/${id}`);
  const removed = Object.entries(i.redactions ?? {}).filter(([, n]) => n > 0);
  return (
    <>
      <PageHeader
        eyebrow={FEATURE[i.feature]?.name ?? i.feature}
        title={`AI call by ${i.byName ?? 'unknown'}`}
        description={`${new Date(i.createdAt).toLocaleString('en-IN')} · ${i.model || 'no model used'} · prompt ${i.promptVersion}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/settings/ai/activity">All AI activity</Link>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="grid content-start gap-6 lg:col-span-2">
          {i.purgedAt && <Alert tone="info">The prompt and answer were removed on {new Date(i.purgedAt).toLocaleDateString('en-IN')} under the workspace's retention setting.</Alert>}
          {i.error && <Alert tone="danger">{i.error}</Alert>}
          {i.request?.user !== undefined && (
            <Card>
              <CardHeader title="Question or request sent" description="As sent to the AI provider, after personal identifiers were removed." />
              <CardBody><pre className="whitespace-pre-wrap text-[0.8125rem]">{i.request.user}</pre></CardBody>
            </Card>
          )}
          {i.response && (
            <Card>
              <CardHeader title="Answer" />
              <CardBody><pre className="whitespace-pre-wrap text-[0.8125rem]" data-testid="ai-response">{i.response}</pre></CardBody>
            </Card>
          )}
          {i.request?.system && (
            <Card>
              <CardHeader title="Instructions and sources given to the AI" />
              <CardBody><pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs text-fg-muted">{i.request.system}</pre></CardBody>
            </Card>
          )}
        </div>
        <Card className="content-start">
          <CardHeader title="Details" />
          <CardBody className="grid gap-2 text-[0.8125rem]">
            <div className="flex justify-between"><span className="text-fg-muted">Result</span><Badge tone={STATUS[i.status]?.tone ?? 'neutral'}>{STATUS[i.status]?.label ?? i.status}</Badge></div>
            <div className="flex justify-between"><span className="text-fg-muted">Provider</span><span>{i.provider}</span></div>
            <div className="flex justify-between"><span className="text-fg-muted">Tokens in / out</span><span className="tabular-nums">{i.inputTokens} / {i.outputTokens}</span></div>
            <div className="flex justify-between"><span className="text-fg-muted">Credits</span><span className="tabular-nums">{i.credits}</span></div>
            <div className="flex justify-between"><span className="text-fg-muted">Time</span><span className="tabular-nums">{(i.latencyMs / 1000).toFixed(1)} s</span></div>
            <div className="flex justify-between"><span className="text-fg-muted">Feedback</span><span>{i.helpful === null ? 'None' : i.helpful ? 'Helpful' : 'Not helpful'}</span></div>
            <div>
              <div className="text-fg-muted">Removed before sending</div>
              <div>{removed.length ? removed.map(([k, n]) => `${n} ${REDACTION[k] ?? k}`).join(', ') : 'Nothing needed removing'}</div>
            </div>
            <div>
              <div className="text-fg-muted">Sources</div>
              {i.evidence.length ? <ul className="list-disc pl-5">{i.evidence.map((e) => <li key={e.id}>{e.title}</li>)}</ul> : <div>None</div>}
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
