'use client';
import { automation } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Input, Select } from '@crew/ui';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRunner } from '../../recruitment/use-runner';
import { testWorkflowAction, workflowStatusAction } from '../actions';
import { RUN_STATUS, STEP_STATUS, when } from '../labels';
import type { Catalogue, RunRow, TestResult, WorkflowDetail } from '../types';

export function WorkflowControls({ workflow, recentRuns }: { workflow: WorkflowDetail; catalogue: Catalogue; recentRuns: RunRow[] }) {
  const { pending, notice, run } = useRunner();
  const latest = workflow.latest;
  const live = workflow.versions.find((v) => v.id === workflow.activeVersionId);
  return (
    <div className="grid content-start gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader title="Status" />
        <CardBody className="grid gap-3 text-[13px]">
          {workflow.statusReason && <Alert tone="danger" title="Paused automatically">{workflow.statusReason}</Alert>}
          <p>
            {workflow.status === 'active' ? <>Version {live?.version} is live and runs with the permissions of {workflow.ownerName}.</> : workflow.status === 'paused' ? 'Paused. Nothing new starts; runs under way stop at their next step.' : workflow.status === 'archived' ? 'Archived. Its runs and versions are kept.' : 'Not active yet.'}
          </p>
          <p className="text-fg-muted">
            Latest is version {latest.version}{latest.testedAt ? `, tested ${when(latest.testedAt)}` : ', not tested yet'}.
            {workflow.status === 'active' && live && live.id !== latest.id && ' Activate it to replace the live version.'}
          </p>
          {workflow.status !== 'archived' && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" loading={pending} disabled={!workflow.canActivate} onClick={() => run(() => workflowStatusAction(workflow.id, 'activate'))}>
                Activate version {latest.version}
              </Button>
              {workflow.status === 'active' && <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => workflowStatusAction(workflow.id, 'pause'))}>Pause</Button>}
              <Button size="sm" variant="ghost" loading={pending} onClick={() => { if (confirm('Archive this workflow? It stops running; its history is kept.')) run(() => workflowStatusAction(workflow.id, 'archive')); }}>Archive</Button>
            </div>
          )}
          {!latest.testedAt && workflow.status !== 'archived' && <p className="text-xs text-fg-subtle">Run a test without errors to be able to activate this version. Activating makes you the person it runs as.</p>}
        </CardBody>
      </Card>
      {workflow.status !== 'archived' && <TestPanel workflow={workflow} />}
      <Card>
        <CardHeader title="Versions" description="Saved versions never change." />
        <CardBody className="grid gap-2 text-[13px]">
          {workflow.versions.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium tabular-nums">v{v.version}</span>
              {v.id === workflow.activeVersionId && <Badge tone="success">Live</Badge>}
              {v.testedAt ? <Badge tone="info">Tested</Badge> : <Badge>Not tested</Badge>}
              {v.aiDrafted && <Badge tone="ember">AI draft</Badge>}
              <span className="text-fg-muted">{v.byName}, {when(v.createdAt)}</span>
            </div>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Recent runs" action={<Link className="text-[13px] text-accent hover:underline" href={`/automation/runs?workflowId=${workflow.id}`}>All runs</Link>} />
        <CardBody className="grid gap-2 text-[13px]">
          {recentRuns.length === 0 && <p className="text-fg-muted">No runs yet.</p>}
          {recentRuns.map((r) => (
            <Link key={r.id} href={`/automation/runs/${r.id}`} className="flex items-center gap-2 hover:underline">
              <Badge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Badge>
              {r.mode === 'test' && <Badge tone="ember">Test</Badge>}
              <span className="truncate">{r.employeeName ?? 'Sample values'}</span>
              <span className="ml-auto whitespace-nowrap text-fg-muted">{when(r.createdAt)}</span>
            </Link>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

function TestPanel({ workflow }: { workflow: WorkflowDetail }) {
  const fields = automation.fieldsFor(workflow.latest.definition.trigger.event);
  const used = new Set<string>();
  for (const s of workflow.latest.definition.steps) {
    if (s.type === 'condition') used.add(s.field);
    const text = s.type === 'notify' ? `${s.title} ${s.body}` : s.type === 'approval' ? s.summary : s.type === 'slack' ? s.text : s.type === 'webhook' ? s.message : '';
    for (const p of automation.placeholders(text)) used.add(p);
  }
  const shown = fields.filter((f) => used.has(f.key) || f.key === 'employee.name');
  const [sample, setSample] = useState<Record<string, string>>({ 'employee.name': 'Sample Employee' });
  const [approvals, setApprovals] = useState<'approve' | 'reject'>('approve');
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const test = () =>
    start(async () => {
      setError(null);
      const values = Object.fromEntries(shown.map((f) => {
        const raw = sample[f.key] ?? '';
        return [f.key, raw === '' ? null : f.type === 'number' && !Number.isNaN(Number(raw)) ? Number(raw) : raw];
      }));
      const r = await testWorkflowAction(workflow.id, { sample: values, approvals });
      if (r.ok && r.data) setResult(r.data);
      else setError(r.ok ? 'No result came back.' : r.message);
    });
  return (
    <Card>
      <CardHeader title={`Test version ${workflow.latest.version}`} description="Runs the steps with sample values. Nobody is notified, nothing is assigned and waits are skipped." />
      <CardBody className="grid gap-3">
        {shown.map((f) => (
          <Field key={f.key} label={f.label} hint={f.type === 'date' ? 'YYYY-MM-DD' : undefined}>
            {(p) => <Input {...p} type={f.type === 'number' ? 'number' : 'text'} value={sample[f.key] ?? ''} onChange={(e) => setSample({ ...sample, [f.key]: e.target.value })} />}
          </Field>
        ))}
        <Field label="Approvers">{(p) => <Select {...p} value={approvals} onChange={(e) => setApprovals(e.target.value as 'approve' | 'reject')}><option value="approve">Assume they approve</option><option value="reject">Assume they reject</option></Select>}</Field>
        <div><Button variant="secondary" loading={pending} onClick={test}>Run test</Button></div>
        {error && <Alert tone="danger">{error}</Alert>}
        {result && (
          <div className="grid gap-2 rounded-lg border border-border p-3 text-[13px]">
            <Alert tone={result.passed ? 'success' : 'danger'} title={result.passed ? 'Test passed' : 'Test failed'}>
              {result.outcome}{result.passed && ' This version can now be activated.'}
            </Alert>
            {result.steps.map((s) => (
              <div key={s.index} className="flex gap-2">
                <span className="tabular-nums text-fg-subtle">{s.index + 1}.</span>
                <div className="min-w-0">
                  <Badge tone={STEP_STATUS[s.status]?.tone ?? 'neutral'}>{STEP_STATUS[s.status]?.label ?? s.status}</Badge>
                  <span className="ml-2">{s.detail}</span>
                  {s.error && <div className="text-danger">{s.error}</div>}
                </div>
              </div>
            ))}
            <Link className="text-accent hover:underline" href={`/automation/runs/${result.runId}`}>Open the test run</Link>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
