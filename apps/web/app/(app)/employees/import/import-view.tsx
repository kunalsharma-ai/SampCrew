'use client';
import type { ImportResult } from '@crew/contracts';
import { Alert, Badge, Button, buttonClass, Card, CardBody, CardHeader, Field, Input, Stat, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Download, Upload } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { importEmployeesAction } from './actions';

const TONE = { ok: 'success', created: 'success', error: 'danger', duplicate: 'warning' } as const;
const LABEL = { ok: 'Ready', created: 'Added', error: 'Needs fixing', duplicate: 'Already in SampCrew' } as const;

export function ImportView({ columns, leavePrefix, assets }: { columns: { key: string; label: string; required: boolean; example: string }[]; leavePrefix: string; assets: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (dryRun: boolean) => {
    if (!file) return;
    const form = new FormData();
    form.set('file', file);
    setError(null);
    start(async () => {
      const r = await importEmployeesAction(form, dryRun);
      if (r.ok && r.data) setResult(r.data); else if (!r.ok) { setError(r.message); setResult(null); }
    });
  };
  const s = result?.summary;
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader title="1. Fill in the template" description="One row per person. Dates as 2021-04-05 or 05/04/2021 (day first). Leave columns hold the days each person has available today." />
        <CardBody className="grid gap-4">
          <div><a className={buttonClass('secondary')} href="/employee-import-template"><Download className="size-4" aria-hidden /> Download the Excel template</a></div>
          <details className="text-[0.8125rem]">
            <summary className="cursor-pointer font-medium">Columns</summary>
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {columns.filter((c) => assets || c.key !== 'assetCodes').map((c) => <li key={c.key}><span className="font-medium">{c.label}</span>{c.required ? ' (required)' : ''} <span className="text-fg-muted">e.g. {c.example}</span></li>)}
              <li><span className="font-medium">{leavePrefix}CODE</span> <span className="text-fg-muted">one column per leave type, e.g. {leavePrefix}CL = 6.5</span></li>
            </ul>
          </details>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="2. Check and import" description="Checking changes nothing. Import adds only the rows that are ready; fix the others and import them again." />
        <CardBody className="grid gap-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Filled-in file" hint="Excel (.xlsx) or CSV, up to 5 MB">{(p) => <Input {...p} type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }} />}</Field>
            <Button variant="secondary" disabled={!file} loading={pending} onClick={() => run(true)}>Check the file</Button>
            {result?.dryRun && s && s.ok > 0 && <Button loading={pending} onClick={() => run(false)}><Upload className="size-4" aria-hidden /> Import {s.ok} {s.ok === 1 ? 'person' : 'people'}</Button>}
          </div>
          {s && (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat label="Rows" value={s.total} />
              <Stat label={result!.dryRun ? 'Ready to import' : 'Added'} value={result!.dryRun ? s.ok : s.created} />
              <Stat label="Need fixing" value={s.errors} />
              <Stat label="Already in SampCrew" value={s.duplicates} />
            </div>
          )}
          {result && !result.dryRun && s && s.created > 0 && <Alert tone="success" title={`${s.created} ${s.created === 1 ? 'person was' : 'people were'} added`}>Their leave balances and assets are set. Give them a SampCrew login from <Link className="underline" href="/employees">Employees</Link> when they need one.</Alert>}
          {result?.dryRun && result.creates.designations.length > 0 && <Alert tone="info">New designations will be added: {result.creates.designations.join(', ')}.</Alert>}
        </CardBody>
        {result && (
          <Table aria-label="Import results">
            <THead><tr><TH>Row</TH><TH>Employee</TH><TH>Result</TH><TH>Details</TH></tr></THead>
            <TBody>
              {result.rows.map((r) => (
                <TR key={r.row}>
                  <TD>{r.row}</TD>
                  <TD>{r.employeeId ? <Link className="text-accent hover:underline" href={`/employees/${r.employeeId}`}>{r.name}</Link> : r.name}<div className="font-mono text-xs text-fg-muted">{r.employeeCode}</div></TD>
                  <TD><Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge></TD>
                  <TD className="text-[0.8125rem]">
                    {r.errors.map((e, i) => <div key={i} className="text-danger"><span className="font-medium">{e.column}:</span> {e.message}</div>)}
                    {r.warnings.map((w, i) => <div key={`w${i}`} className="text-fg-muted">{w}</div>)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
