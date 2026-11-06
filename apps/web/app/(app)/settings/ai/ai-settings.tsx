'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Stat, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { useState } from 'react';
import { useRunner } from '../../recruitment/use-runner';
import { saveAiSettingsAction } from '../../ai/actions';
import { FEATURE } from '../../ai/labels';
import type { AiFeature, AiSettings, AiUsage } from '../../ai/types';

const FEATURES: AiFeature[] = ['assistant', 'helpdesk_draft', 'workflow_draft'];

export function AiSettingsForm({ settings, usage }: { settings: AiSettings; usage: AiUsage }) {
  const { pending, notice, run } = useRunner();
  const [features, setFeatures] = useState(settings.features);
  const [days, setDays] = useState(String(settings.promptLogDays));
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 7 && n <= 730;
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {settings.configured ? (
        <Alert tone="info" title={`AI provider: ${settings.provider === 'anthropic' ? 'Anthropic Claude API' : settings.provider} (${settings.model})`}>
          Connected for every workspace by SAMPLEDGE. Personal identifiers such as email addresses, phone numbers, bank and national ID numbers are removed from everything sent. Pay, bank, tax and health fields are never included.
        </Alert>
      ) : (
        <Alert tone="warning" title="AI is not set up for this SampCrew installation">
          SAMPLEDGE has not connected an AI provider yet, so no AI feature works and no data is sent to any AI service. The switches below are kept for when it is.
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="AI credits used this month" value={`${usage.used}${usage.limit === -1 ? '' : ` of ${usage.limit}`}`} hint="One credit per thousand tokens. Renews on the 1st." />
        <Stat label="AI calls this month" value={usage.byFeature.reduce((s, f) => s + f.calls, 0)} />
        <Stat label="Marked helpful" value={usage.byFeature.reduce((s, f) => s + f.helpful, 0)} hint={`${usage.byFeature.reduce((s, f) => s + f.notHelpful, 0)} marked not helpful`} />
      </div>
      <Card>
        <CardHeader title="Features" />
        <CardBody>
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); run(() => saveAiSettingsAction({ features, promptLogDays: n })); }}>
            {FEATURES.map((f) => (
              <Checkbox key={f} label={FEATURE[f].name} description={FEATURE[f].description} checked={features[f]} onChange={(e) => setFeatures({ ...features, [f]: e.target.checked })} />
            ))}
            <Field label="Keep prompts and answers for (days)" hint="After this, the text is removed from the AI activity log. Usage numbers are kept." error={valid ? undefined : 'Between 7 and 730 days'}>
              {(p) => <Input {...p} type="number" min={7} max={730} className="max-w-[10rem]" value={days} onChange={(e) => setDays(e.target.value)} />}
            </Field>
            <div><Button type="submit" loading={pending} disabled={!valid}>Save AI settings</Button></div>
          </form>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Usage this month" description="Calls and credits by feature. Auditors can read every prompt and answer in the AI activity log." />
        <Table>
          <THead><tr><TH>Feature</TH><TH className="text-right">Calls</TH><TH className="text-right">Credits</TH><TH className="text-right">Tokens in / out</TH><TH className="text-right">Average time</TH><TH>Feedback</TH></tr></THead>
          <TBody>
            {usage.byFeature.length === 0 && <TR><TD colSpan={6} className="text-fg-muted">No AI use this month.</TD></TR>}
            {usage.byFeature.map((f) => (
              <TR key={f.feature}>
                <TD className="font-medium">{FEATURE[f.feature]?.name ?? f.feature}</TD>
                <TD className="text-right tabular-nums">{f.calls}</TD>
                <TD className="text-right tabular-nums">{f.credits}</TD>
                <TD className="text-right tabular-nums">{f.inputTokens.toLocaleString()} / {f.outputTokens.toLocaleString()}</TD>
                <TD className="text-right tabular-nums">{f.avgLatencyMs ? `${(f.avgLatencyMs / 1000).toFixed(1)} s` : '–'}</TD>
                <TD><Badge tone="success">{f.helpful} helpful</Badge> <Badge tone="neutral">{f.notHelpful} not</Badge></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
