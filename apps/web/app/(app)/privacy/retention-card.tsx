'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { useState } from 'react';
import { useRunner } from '../recruitment/use-runner';
import { type RetentionRunResult, runRetentionAction, saveRetentionAction } from './actions';

export interface RetentionState {
  policy: { exitedErasureYears: number | null; exportDays: number; signInLogDays: number; updatedAt: string | null; updatedBy: string | null };
  isDefault: boolean;
  dueForErasure: number;
  runs: { id: string; ranAt: string; result: RetentionRunResult }[];
}

const summary = (r: RetentionRunResult) =>
  [
    `${r.erased} erased`,
    r.heldByPayroll ? `${r.heldByPayroll} waiting for payroll` : '',
    `${r.exportsDeleted} exports deleted`,
    `${r.signInStates + r.mobileHandoffs} sign-in records and ${r.provisioningCalls} provisioning calls deleted`,
  ].filter(Boolean).join(' · ');

/** The workspace's retention schedule. Saved settings apply from the next daily run, or straight away with "Run now". */
export function RetentionCard({ state }: { state: RetentionState }) {
  const p = state.policy;
  const { pending, notice, run } = useRunner();
  const [auto, setAuto] = useState(p.exitedErasureYears !== null);
  const [years, setYears] = useState(String(p.exitedErasureYears ?? 7));
  const [exportDays, setExportDays] = useState(String(p.exportDays));
  const [logDays, setLogDays] = useState(String(p.signInLogDays));
  const y = Number(years);
  const e = Number(exportDays);
  const l = Number(logDays);
  const valid = (!auto || (Number.isInteger(y) && y >= 1 && y <= 30)) && Number.isInteger(e) && e >= 1 && e <= 365 && Number.isInteger(l) && l >= 7 && l <= 3650;

  const save = () => {
    if (auto && !confirm(`Erase people automatically ${y} years after their last working day? Erasure cannot be undone. Payroll, attendance and the audit trail are kept.`)) return;
    run(() => saveRetentionAction({ exitedErasureYears: auto ? y : null, exportDays: e, signInLogDays: l }));
  };

  return (
    <Card>
      <CardHeader
        title="Retention schedule"
        description="How long SampCrew keeps personal data it no longer needs. It runs once a day. Raw attendance punches, payroll and the audit trail are never deleted by it."
        action={<Badge tone={state.isDefault ? 'neutral' : 'success'}>{state.isDefault ? 'Defaults' : `Set by ${p.updatedBy ?? 'an admin'}`}</Badge>}
      />
      <CardBody className="grid gap-4">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        <Checkbox
          label="Erase leavers automatically"
          description="Each erasure is logged as a privacy request from the retention schedule and does exactly what an erasure by HR does. Someone in a payroll run that is not finalised waits until it is."
          checked={auto}
          onChange={(ev) => setAuto(ev.target.checked)}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Years after the last working day" hint="Check how long the law where you employ people requires records to be kept." required={auto}>
            {(f) => <Input {...f} name="exitedErasureYears" type="number" min={1} max={30} disabled={!auto} value={years} onChange={(ev) => setYears(ev.target.value)} />}
          </Field>
          <Field label="Delete access exports after (days)" required>
            {(f) => <Input {...f} name="exportDays" type="number" min={1} max={365} value={exportDays} onChange={(ev) => setExportDays(ev.target.value)} />}
          </Field>
          <Field label="Delete sign-in and provisioning logs after (days)" required>
            {(f) => <Input {...f} name="signInLogDays" type="number" min={7} max={3650} value={logDays} onChange={(ev) => setLogDays(ev.target.value)} />}
          </Field>
        </div>
        {p.exitedErasureYears !== null && (
          <p className="text-[0.8125rem] text-fg-muted" data-testid="retention-due">{state.dueForErasure} {state.dueForErasure === 1 ? 'person is' : 'people are'} past the period and will be erased on the next run.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button loading={pending} disabled={!valid} onClick={save}>Save schedule</Button>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => { if (confirm('Apply the saved schedule now? People past the period are erased, which cannot be undone.')) run(async () => { const r = await runRetentionAction(); return r.ok ? { ...r, message: `Done: ${summary(r.data!)}.` } : r; }); }}
          >
            Run now
          </Button>
        </div>
      </CardBody>
      {state.runs.length > 0 && (
        <Table>
          <THead><tr><TH>When</TH><TH>Started by</TH><TH>Result</TH></tr></THead>
          <TBody>
            {state.runs.map((r) => (
              <TR key={r.id}>
                <TD className="whitespace-nowrap text-fg-muted">{new Date(r.ranAt).toLocaleString()}</TD>
                <TD>{r.result.trigger === 'schedule' ? 'Daily run' : 'Run now'}</TD>
                <TD className="text-[0.8125rem]" data-testid="retention-run">{summary(r.result)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
