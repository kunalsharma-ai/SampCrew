'use client';
import { Alert, Badge, Button, buttonClass, Card, CardBody, CardHeader, Field, Input, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { useRunner } from '../../recruitment/use-runner';
import { eraseAction, prepareExportAction, rejectPrivacyRequestAction } from '../actions';
import type { PrivacyRequest } from '../types';

const label = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function PrivacyDetail({ r }: { r: PrivacyRequest }) {
  const { pending, notice, run } = useRunner();
  const [note, setNote] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [reason, setReason] = useState('');
  const noteOk = note.trim().length >= 3;
  const isOpen = r.status === 'open';
  const left = r.employeeStatus === 'exited' && r.lastWorkingDay !== null && r.lastWorkingDay < new Date().toISOString().slice(0, 10);

  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader title="Request" />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-2 text-[0.8125rem] sm:grid-cols-[12rem_1fr]">
            <dt className="text-fg-muted">How it arrived</dt><dd>{r.source}</dd>
            <dt className="text-fg-muted">Employment</dt><dd>{label(r.employeeStatus)}{r.lastWorkingDay ? `, last working day ${r.lastWorkingDay}` : ''}</dd>
            {r.decidedBy && <><dt className="text-fg-muted">Closed by</dt><dd>{r.decidedBy}{r.completedAt ? ` on ${new Date(r.completedAt).toLocaleString()}` : ''}</dd></>}
            {r.decisionNote && <><dt className="text-fg-muted">Note</dt><dd>{r.decisionNote}</dd></>}
          </dl>
        </CardBody>
      </Card>

      {r.kind === 'access' && (
        <Card>
          <CardHeader title="Copy of their data" description="Everything SampCrew holds about this person in this workspace, as one JSON file. Passwords, keys, tokens and encrypted numbers are left out; bank, tax and ID numbers show only whether one is on file." />
          <CardBody className="grid gap-4">
            {r.hasExport && (
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <a className={buttonClass('primary', 'md')} href={`/privacy-exports/${r.id}`} data-testid="download-export"><Download className="size-4" /> Download export</a>
                  <span className="text-xs text-fg-muted">Every download is recorded in the audit trail. SHA-256 <span className="font-mono">{r.exportSha256?.slice(0, 16)}…</span></span>
                </div>
                {r.result?.records && (
                  <p className="text-[0.8125rem] text-fg-muted" data-testid="export-summary">
                    {Object.entries(r.result.records).filter(([, n]) => n > 0).map(([k, n]) => `${label(k)}: ${n}`).join(' · ')}
                  </p>
                )}
              </div>
            )}
            {isOpen && (
              <>
                <Field label="Note for the record" hint="For example how you will send it to them" required>
                  {(p) => <Input {...p} name="note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />}
                </Field>
                <div><Button loading={pending} disabled={!noteOk} onClick={() => run(() => prepareExportAction(r.id, note.trim()))}>Prepare export and complete</Button></div>
              </>
            )}
          </CardBody>
        </Card>
      )}

      {r.kind === 'erasure' && (
        <Card>
          <CardHeader title="What erasure does" description="Some records must be kept by law even after erasure. They stay, linked to a pseudonymous record instead of the person." />
          <Table>
            <THead><tr><TH>Records</TH><TH>Result</TH><TH>Detail</TH></tr></THead>
            <TBody>
              {r.erasureRules.map((x) => (
                <TR key={x.area}>
                  <TD className="font-medium">{x.area}</TD>
                  <TD><Badge tone={x.action === 'erased' ? 'danger' : 'neutral'}>{x.action === 'erased' ? 'Erased' : 'Kept'}</Badge></TD>
                  <TD className="text-[0.8125rem] text-fg-muted">{x.detail}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <CardBody className="grid gap-4 pt-4">
            <Alert tone="warning">Free text that colleagues wrote elsewhere (expense descriptions, goals, review comments) is not erased automatically. Check those by hand.</Alert>
            {r.result?.removed && (
              <p className="text-[0.8125rem] text-fg-muted" data-testid="erasure-summary">Removed: {Object.entries(r.result.removed).map(([k, n]) => `${label(k)} ${n}`).join(' · ')}</p>
            )}
            {isOpen && !left && <Alert tone="info">This person has not left yet, so they cannot be erased. Erasure is possible after their last working day; until then you can reject the request with a reason.</Alert>}
            {isOpen && left && (
              <>
                <Field label="Note for the record" required>
                  {(p) => <Input {...p} name="note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />}
                </Field>
                <Field label={`Type ${r.employeeCode} to confirm`} hint="Erasure cannot be undone." required>
                  {(p) => <Input {...p} name="confirm" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />}
                </Field>
                <div><Button variant="danger" loading={pending} disabled={!noteOk || confirmName.trim() !== r.employeeCode} onClick={() => run(() => eraseAction(r.id, note.trim()))}>Erase their data</Button></div>
              </>
            )}
          </CardBody>
        </Card>
      )}

      {isOpen && (
        <Card>
          <CardHeader title="Reject" description="If the request cannot be met (for example the identity could not be checked), close it with the reason. The reason is kept with the request." />
          <CardBody className="flex flex-wrap items-end gap-3">
            <Field label="Reason" className="min-w-[18rem] flex-1">
              {(p) => <Input {...p} name="reason" value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />}
            </Field>
            <Button variant="secondary" disabled={pending || reason.trim().length < 3} onClick={() => { if (confirm('Close this request as rejected?')) run(() => rejectPrivacyRequestAction(r.id, reason.trim())); }}>Reject request</Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
