'use client';
import { CRM_DEFAULT_EXPORT } from '@crew/contracts';
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, Field, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { when } from '../crm-ui';

export interface ExportData {
  columns: { key: string; label: string; group: string }[];
  history: { id: string; scope: string; format: string; rows: number; columns: number; createdAt: string; by: string | null }[];
}

export function ExportForm({ data, filters, matching }: { data: ExportData; filters: Record<string, string>; matching: number }) {
  const filtered = Object.keys(filters).length > 0;
  const [scope, setScope] = useState<'filtered' | 'all'>(filtered ? 'filtered' : 'all');
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [cols, setCols] = useState<string[]>(CRM_DEFAULT_EXPORT.filter((k) => data.columns.some((c) => c.key === k)));
  const groups = [...new Set(data.columns.map((c) => c.group))];
  const payload = JSON.stringify({ scope, filters: scope === 'filtered' ? filters : {}, ids: [], columns: data.columns.map((c) => c.key).filter((k) => cols.includes(k)), format });
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader title="What to export" />
        <CardBody className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Candidates">{(p) => (
              <Select {...p} value={scope} onChange={(e) => setScope(e.target.value as 'all')}>
                {filtered && <option value="filtered">The {matching} candidates matching the list filters</option>}
                <option value="all">Every candidate I can see</option>
              </Select>
            )}</Field>
            <Field label="File type">{(p) => <Select {...p} value={format} onChange={(e) => setFormat(e.target.value as 'csv')}><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV</option></Select>}</Field>
          </div>
          {filtered && (
            <p className="text-[0.8125rem] text-fg-muted">Filters from the list: {Object.entries(filters).map(([k, v]) => <Badge key={k} tone="neutral" className="mr-1">{k}: {v}</Badge>)} <Link href={`/recruitment/crm/candidates?${new URLSearchParams(filters)}`} className="text-accent hover:underline">Change</Link></p>
          )}
          <p className="text-[0.8125rem] text-fg-muted">To export a hand-picked set, select candidates on <Link className="text-accent hover:underline" href="/recruitment/crm/candidates">All Candidates</Link> and choose Export selected.</p>
          {groups.map((g) => (
            <fieldset key={g} className="grid gap-2">
              <legend className="mb-1 flex items-center gap-3 text-[0.8125rem] font-medium">{g}
                <button type="button" className="text-xs font-normal text-accent hover:underline" onClick={() => setCols([...new Set([...cols, ...data.columns.filter((c) => c.group === g).map((c) => c.key)])])}>Select all</button>
                <button type="button" className="text-xs font-normal text-accent hover:underline" onClick={() => setCols(cols.filter((k) => !data.columns.some((c) => c.group === g && c.key === k)))}>Clear</button>
              </legend>
              <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {data.columns.filter((c) => c.group === g).map((c) => (
                  <Checkbox key={c.key} label={c.label} checked={cols.includes(c.key)} onChange={(e) => setCols(e.target.checked ? [...cols, c.key] : cols.filter((k) => k !== c.key))} />
                ))}
              </div>
            </fieldset>
          ))}
          <form method="post" action="/crm-export">
            <input type="hidden" name="payload" value={payload} />
            <Button type="submit" disabled={!cols.length}><Download className="size-3.5" /> Download {format === 'xlsx' ? 'Excel' : 'CSV'} ({cols.length} column{cols.length === 1 ? '' : 's'})</Button>
          </form>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Export log" description="Who exported candidates, when, and how many." />
        {data.history.length === 0 ? <EmptyState title="No exports yet" /> : (
          <Table aria-label="Export log">
            <THead><TR><TH>When</TH><TH>By</TH><TH>Candidates</TH><TH>Scope</TH><TH>Columns</TH><TH>Format</TH></TR></THead>
            <TBody>{data.history.map((h) => <TR key={h.id}><TD>{when(h.createdAt)}</TD><TD>{h.by ?? '—'}</TD><TD>{h.rows}</TD><TD>{h.scope}</TD><TD>{h.columns}</TD><TD>{h.format.toUpperCase()}</TD></TR>)}</TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
