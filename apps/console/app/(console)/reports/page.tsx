import { REPORT_KINDS, REPORT_LABEL, type ReportKind, type ReportResult } from '@crew/contracts';
import { Alert, Card, CardBody, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR, cn } from '@crew/ui';
import { Download } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { BarChart, TrendChart } from '@/components/charts';
import { api, load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { ReportFilters } from './report-filters';

export const metadata: Metadata = { title: 'Reports' };

const MONEY: ReportKind[] = ['business', 'subscriptions', 'payments'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Business, workspace, subscription and payment reports for a date range, with CSV, Excel and PDF downloads. */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const me = await load<Admin>('/platform/auth/me');
  const money = hasCap(me, 'billing:read');
  const kinds = REPORT_KINDS.filter((k) => money || !MONEY.includes(k));
  const kind = (kinds as readonly string[]).includes(sp.kind ?? '') ? (sp.kind as ReportKind) : kinds[0]!;
  const f: Record<string, string> = {};
  if (sp.from && DATE.test(sp.from)) f.from = sp.from;
  if (sp.to && DATE.test(sp.to)) f.to = sp.to;
  if (sp.currency && /^[A-Z]{3}$/.test(sp.currency)) f.currency = sp.currency;
  if (sp.clientId && /^[0-9a-f-]{36}$/i.test(sp.clientId)) f.clientId = sp.clientId;
  if (sp.plan && /^[a-z0-9_-]{1,60}$/i.test(sp.plan)) f.plan = sp.plan;
  const [report, clients] = await Promise.all([
    api<ReportResult>(`/platform/reports/${kind}?${new URLSearchParams(f)}`).then((r) => ({ ok: true as const, r })).catch((e: Error) => ({ ok: false as const, message: e.message })),
    load<{ id: string; name: string }[]>('/platform/clients/options').catch(() => []),
  ]);
  const canExport = hasCap(me, 'reports:export');
  const file = (format: string) => `/export/reports/${kind}?${new URLSearchParams({ ...f, format })}`;
  const isMoney = MONEY.includes(kind);
  return (
    <>
      <PageHeader title="Reports" description="Pick a report and a date range. Figures come from the live records; downloads are recorded in the audit log." />
      <nav className="mb-4 flex gap-1 border-b border-border" aria-label="Reports" data-testid="report-tabs">
        {kinds.map((k) => <Link key={k} href={`/reports?${new URLSearchParams({ ...f, kind: k })}`} aria-current={k === kind ? 'page' : undefined} className={cn('-mb-px border-b-2 px-3 py-2 text-[13px]', k === kind ? 'border-accent font-medium text-accent' : 'border-transparent text-fg-muted hover:text-fg')}>{REPORT_LABEL[k]}</Link>)}
      </nav>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <ReportFilters kind={kind} filters={f} clients={clients} money={isMoney} />
        {canExport && report.ok && (
          <span className="flex items-center gap-1" data-testid="report-export">
            <Download className="size-4 text-fg-subtle" aria-hidden />
            {(['csv', 'xlsx', 'pdf'] as const).map((x) => <a key={x} href={file(x)} className="rounded px-2 py-1 text-[12.5px] text-accent hover:bg-bg-subtle">{x === 'xlsx' ? 'Excel' : x.toUpperCase()}</a>)}
          </span>
        )}
      </div>
      {!report.ok ? <Alert tone="danger" title="This report could not be built">{report.message}</Alert> : (
        <div className="grid gap-5" data-testid="report">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {report.r.summary.map((s) => <Card key={s.label}><CardBody><div className="text-[12px] text-fg-subtle">{s.label}</div><div className="text-[20px] font-semibold tabular">{s.value}</div>{s.hint && <div className="text-[11.5px] text-fg-muted">{s.hint}</div>}</CardBody></Card>)}
          </div>
          {report.r.series.length > 0 && (
            <Card>
              <CardHeader title={report.r.title} description={`${report.r.from} to ${report.r.to}${isMoney ? ` · ${report.r.currency}` : ''}`} />
              <CardBody>
                {kind === 'payments' || kind === 'subscriptions'
                  ? <BarChart points={report.r.series} keys={report.r.seriesKeys} testId="report-chart" />
                  : <TrendChart points={report.r.series} keys={report.r.seriesKeys} testId="report-chart" />}
              </CardBody>
            </Card>
          )}
          <Card>
            {!report.r.table.rows.length ? <EmptyState title="Nothing in this range" /> : (
              <Table aria-label={report.r.title}>
                <THead><TR>{report.r.table.columns.map((c) => <TH key={c.key} className={c.align === 'right' ? 'text-right' : undefined}>{c.label}</TH>)}</TR></THead>
                <TBody>
                  {report.r.table.rows.map((row, i) => <TR key={i}>{report.r.table.columns.map((c) => <TD key={c.key} className={c.align === 'right' ? 'text-right tabular' : undefined}>{row[c.key] ?? '—'}</TD>)}</TR>)}
                </TBody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
