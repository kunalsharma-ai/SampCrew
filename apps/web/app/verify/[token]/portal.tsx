'use client';
import { BGV_STATUS_LABEL } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Input, Select, Textarea } from '@crew/ui';
import { Download, FileUp } from 'lucide-react';
import { useState, useTransition } from 'react';
import { sendFindingsAction, uploadReportAction } from '../actions';
import type { PortalCase } from '../types';

const day = (s: string | null) => (s ? new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
const TONE: Record<string, 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = { pending: 'neutral', in_progress: 'info', verified: 'success', failed: 'danger', on_hold: 'warning' };

/** What the agency sees: the checks with their details, the files shared with it, and the findings form. */
export function Portal({ token, initial }: { token: string; initial: PortalCase }) {
  const [c, setC] = useState(initial);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [statuses, setStatuses] = useState<Record<string, string>>(Object.fromEntries(c.checks.map((x) => [x.id, x.status === 'pending' ? 'in_progress' : x.status])));
  const done = (r: { ok: boolean; message?: string; data?: PortalCase }) => { setMsg({ tone: r.ok ? 'success' : 'danger', text: r.message ?? '' }); if (r.ok && r.data) setC(r.data); };

  return (
    <div className="grid gap-8">
      <header className="grid gap-2">
        <p className="text-sm font-medium text-accent">{c.workspace}</p>
        <h1 className="text-3xl font-semibold tracking-tight">Background verification for {c.employee.name}</h1>
        <p className="text-fg-muted">
          Request <span className="font-mono">{c.reference}</span>{c.agency ? ` for ${c.agency}` : ''}.{c.dueDate ? ` Please complete it by ${day(c.dueDate)}.` : ''} This link works until {day(c.expiresAt)}.
        </p>
      </header>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {c.closed && <Alert tone="info" title="This verification is finished">The workspace has recorded its result. Thank you for your help.</Alert>}
      {c.submittedAt && !c.closed && <Alert tone="success" title="Findings received">You sent findings on {new Date(c.submittedAt).toLocaleString('en-GB')}. You can send an update below.</Alert>}

      <Card>
        <CardHeader title="Shared documents" description="Documents the workspace has shared with you for this verification." />
        <CardBody className="grid gap-2">
          {c.files.length ? c.files.map((f) => (
            <a key={f.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[0.8125rem] hover:bg-bg-subtle" href={`/verify/${token}/files/${f.id}`}>
              <Download className="size-4 text-fg-muted" aria-hidden /><span className="font-medium">{f.title}</span><span className="text-xs text-fg-muted">{f.fileName}{f.kind === 'agency_report' ? ' · your report' : ''}</span>
            </a>
          )) : <p className="text-[0.8125rem] text-fg-muted">No documents have been shared yet.</p>}
        </CardBody>
      </Card>

      <form className="grid gap-6" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => done(await sendFindingsAction(token, {
          reporterName: String(f.get('reporterName') ?? ''), summary: String(f.get('summary') ?? '') || undefined, completedOn: String(f.get('completedOn') ?? '') || undefined,
          checks: c.checks.map((x) => ({ checkId: x.id, status: statuses[x.id], feedback: String(f.get(`feedback-${x.id}`) ?? '') || undefined })),
        })));
      }}>
        <Card>
          <CardHeader title="Checks to verify" description="Record your finding for each check." />
          <CardBody className="grid gap-4">
            {c.checks.map((x) => (
              <div key={x.id} className="grid gap-3 rounded-lg border border-border p-4">
                <div className="flex items-center gap-2"><h2 className="text-sm font-semibold">{x.label}</h2><Badge tone={TONE[x.status] ?? 'neutral'}>{BGV_STATUS_LABEL[x.status as keyof typeof BGV_STATUS_LABEL] ?? x.status}</Badge></div>
                {Object.keys(x.details).length > 0 && (
                  <dl className="grid gap-x-6 gap-y-1 text-[0.8125rem] sm:grid-cols-2">
                    {Object.entries(x.details).map(([k, v]) => <div key={k}><dt className="text-xs text-fg-subtle">{k.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())}</dt><dd>{v}</dd></div>)}
                  </dl>
                )}
                <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
                  <Field label="Your finding" help={false}>
                    {(p) => <Select {...p} value={statuses[x.id]} disabled={c.closed} onChange={(e) => setStatuses({ ...statuses, [x.id]: e.target.value })}><option value="in_progress">Still checking</option><option value="verified">Verified</option><option value="failed">Could not verify / discrepancy</option><option value="on_hold">On hold</option></Select>}
                  </Field>
                  <Field label="Details" help={false}>{(p) => <Textarea {...p} name={`feedback-${x.id}`} rows={2} defaultValue={x.agencyFeedback ?? ''} disabled={c.closed} maxLength={4000} />}</Field>
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
        {!c.closed && (
          <Card>
            <CardHeader title="Send your findings" />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Field label="Your name" required help={false}>{(p) => <Input {...p} name="reporterName" required minLength={2} maxLength={160} />}</Field>
              <Field label="Completed on" help={false}>{(p) => <Input {...p} name="completedOn" type="date" />}</Field>
              <Field label="Summary" className="sm:col-span-2" help={false}>{(p) => <Textarea {...p} name="summary" rows={3} maxLength={4000} />}</Field>
              <div><Button type="submit" loading={pending}>Send findings</Button></div>
            </CardBody>
          </Card>
        )}
      </form>

      {!c.closed && (
        <Card>
          <CardHeader title="Upload your report" description="PDF, image or Word, up to 10 MB." />
          <CardBody>
            <form className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = new FormData(form);
              start(async () => { const r = await uploadReportAction(token, f); if (r.ok) form.reset(); done(r); });
            }}>
              <Field label="Title" help={false}>{(p) => <Input {...p} name="title" defaultValue="Verification report" maxLength={200} />}</Field>
              <Field label="File" help={false}>{(p) => <Input {...p} name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.doc,.docx" />}</Field>
              <Button type="submit" loading={pending}><FileUp className="size-4" aria-hidden /> Upload report</Button>
            </form>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
