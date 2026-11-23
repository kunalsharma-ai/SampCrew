import { IMPORT_JOB_STATUS_LABEL, type ImportJobView, type ImportTypeInfo, MASTER_LIST_INFO, VALUE_LISTS } from '@crew/contracts';
import { Badge, buttonClass, Card, CardBody, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Building2, Download, FileSpreadsheet, ListTree, Network, UserPlus, Users, BriefcaseBusiness, Contact } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { STATUS_TONE } from './status';

export const metadata: Metadata = { title: 'Data import' };

const ICON = { employees: Users, candidates: UserPlus, clients: Building2, contacts: Contact, departments: Network, job_titles: BriefcaseBusiness, master_values: ListTree } as const;

export default async function ImportsPage() {
  const [types, history] = await Promise.all([
    load<(ImportTypeInfo & { allowed: boolean; reason: string | null })[]>('/imports/types'),
    load<ImportJobView[]>('/imports?limit=100'),
  ]);
  const label = (t: string) => types.find((x) => x.key === t)?.label ?? t;
  return (
    <>
      <PageHeader title="Data import" description="Bring records in from Excel or CSV: upload, match the columns to SampCrew fields, check every row, decide what happens to records you already have, then import. Nothing is saved until you confirm." />
      <div className="grid gap-6">
        <Card>
          <CardHeader title="What do you want to import?" description="Each kind of record has a template with its columns and an instructions sheet. Your own file works too: you match its columns in the next step." />
          <CardBody>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {types.map((t) => {
                const Icon = ICON[t.key];
                return (
                  <li key={t.key} className="flex flex-col gap-3 rounded-lg border border-border p-4" data-testid={`import-type-${t.key}`}>
                    <div className="flex items-center gap-2">
                      <span className="flex size-8 items-center justify-center rounded-md bg-accent-subtle text-accent"><Icon className="size-4" aria-hidden /></span>
                      <span className="font-medium">{t.label}</span>
                    </div>
                    <p className="flex-1 text-[0.8125rem] text-fg-muted">{t.description}</p>
                    {t.allowed ? (
                      <div className="flex flex-wrap gap-2">
                        {t.key === 'master_values'
                          ? <Link className={buttonClass('primary', 'sm')} href="/imports/new?type=master_values&list=job_role">Choose a list</Link>
                          : <Link className={buttonClass('primary', 'sm')} href={`/imports/new?type=${t.key}`}><FileSpreadsheet className="size-3.5" aria-hidden /> Import</Link>}
                        {t.key !== 'master_values' && <a className={buttonClass('secondary', 'sm')} href={`/import-template/${t.key}`}><Download className="size-3.5" aria-hidden /> Template</a>}
                      </div>
                    ) : <Badge tone="neutral">{t.reason ?? 'Not available to you'}</Badge>}
                  </li>
                );
              })}
            </ul>
            {types.some((t) => t.key === 'master_values' && t.allowed) && (
              <p className="mt-4 text-xs text-fg-muted">Other lists: {VALUE_LISTS.map((l) => <Link key={l} className="mr-3 text-accent hover:underline" href={`/imports/new?type=master_values&list=${l}`}>{MASTER_LIST_INFO[l].label}</Link>)}</p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Import history" description="Every import with who ran it, when, and what happened. Open one to see its rows or download its report." />
          {history.length === 0 ? <EmptyState icon={<FileSpreadsheet className="size-5" />} title="No imports yet" description="Start one above." /> : (
            <Table aria-label="Import history">
              <THead><tr><TH>#</TH><TH>Type</TH><TH>File</TH><TH>Status</TH><TH>Rows</TH><TH>Added</TH><TH>Updated</TH><TH>Not imported</TH><TH>By</TH><TH>When</TH></tr></THead>
              <TBody>
                {history.map((j) => (
                  <TR key={j.id}>
                    <TD><Link className="font-medium text-accent hover:underline" href={`/imports/${j.id}`}>#{j.number}</Link></TD>
                    <TD>{label(j.type)}{j.list ? <div className="text-xs text-fg-muted">{MASTER_LIST_INFO[j.list as keyof typeof MASTER_LIST_INFO]?.label}</div> : null}</TD>
                    <TD className="max-w-[16rem] truncate">{j.fileName}</TD>
                    <TD><Badge tone={STATUS_TONE[j.status]} dot>{IMPORT_JOB_STATUS_LABEL[j.status]}</Badge></TD>
                    <TD>{j.rowCount}</TD>
                    <TD>{j.summary.imported}</TD>
                    <TD>{j.summary.updated}</TD>
                    <TD>{j.summary.failed}</TD>
                    <TD className="text-[0.8125rem]">{j.createdBy?.replace(/\s*<.*>$/, '')}{j.hrWorkspace ? <div className="text-xs text-fg-muted">{j.hrWorkspace}</div> : null}</TD>
                    <TD className="text-[0.8125rem] whitespace-nowrap">{new Date(j.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
