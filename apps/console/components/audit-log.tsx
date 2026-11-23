'use client';
import type { ConsoleAuditRow } from '@crew/contracts';
import { Badge, Button, Card, EmptyState, Field, Input, Select, buttonClass, cn } from '@crew/ui';
import { ChevronDown, Download, ScrollText } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useState } from 'react';
import { ACTOR, AREAS, type AuditFilters } from '@/lib/audit-filters';
import { LocalTime } from './local-time';

export type { AuditFilters };


const STATUS_TONE = { success: 'success', denied: 'danger', failed: 'warning' } as const;

const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * The audit log: who did what, when, from where, with before and after values. Filters live in the address so a view
 * can be shared; exports are audited too. Values of changes inside client workspaces need users:pii (the API hides them).
 */
export function AuditLogView({ data, filters, basePath, canExport, compact }: { data: { items: ConsoleAuditRow[]; next: string | null }; filters: AuditFilters; basePath: string; canExport: boolean; compact?: boolean }) {
  const router = useRouter();
  const [openRow, setOpenRow] = useState<string | null>(null);
  const href = (extra: AuditFilters) => {
    const p = new URLSearchParams(Object.entries({ ...filters, cursor: '', ...extra }).filter(([, v]) => v) as [string, string][]);
    return `${basePath}${p.size ? `?${p}` : ''}`;
  };
  const exportHref = (format: string) => {
    const p = new URLSearchParams(Object.entries(filters).filter(([k, v]) => v && k !== 'cursor') as [string, string][]);
    p.set('format', format);
    return `/export/audit-log/export?${p}`;
  };
  return (
    <div className="grid gap-4">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); router.push(href(Object.fromEntries(new FormData(e.currentTarget)) as AuditFilters)); }} data-testid="audit-filters">
        <Field label="Search" className="min-w-0 flex-1 sm:max-w-xs">{(p) => <Input {...p} name="q" defaultValue={filters.q} placeholder="Action, admin, IP or record id" />}</Field>
        <Field label="Area">{(p) => <Select {...p} name="area" defaultValue={filters.area ?? ''}><option value="">All</option>{AREAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        <Field label="Result">{(p) => <Select {...p} name="status" defaultValue={filters.status ?? ''}><option value="">All</option><option value="success">Done</option><option value="denied">Refused</option><option value="failed">Failed</option></Select>}</Field>
        {!compact && <Field label="Who">{(p) => <Select {...p} name="actorType" defaultValue={filters.actorType ?? ''}><option value="">Anyone</option>{Object.entries(ACTOR).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>}
        <Field label="From">{(p) => <Input {...p} type="date" name="from" defaultValue={filters.from} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" name="to" defaultValue={filters.to} />}</Field>
        <Field label="Events">{(p) => <Select {...p} name="scope" defaultValue={filters.scope ?? 'platform'}><option value="platform">Console actions</option><option value="all">Also inside client workspaces</option></Select>}</Field>
        <Button type="submit" variant="secondary">Apply</Button>
        {canExport && (
          <span className="ml-auto flex items-center gap-1 self-center" data-testid="audit-export">
            <Download className="size-4 text-fg-subtle" aria-hidden />
            {(['csv', 'xlsx', 'pdf'] as const).map((f) => <a key={f} href={exportHref(f)} className="rounded px-2 py-1 text-[12.5px] text-accent hover:bg-bg-subtle">{f === 'xlsx' ? 'Excel' : f.toUpperCase()}</a>)}
          </span>
        )}
      </form>
      <Card>
        {!data.items.length ? <EmptyState icon={<ScrollText className="size-6" />} title="Nothing recorded for these filters" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]" aria-label="Audit log">
              <thead className="bg-bg-subtle/50 text-xs text-fg-muted"><tr><th className="px-4 py-2.5 font-medium">When</th><th className="px-4 py-2.5 font-medium">Who</th><th className="px-4 py-2.5 font-medium">What</th><th className="px-4 py-2.5 font-medium">Company</th><th className="px-4 py-2.5 font-medium">Result</th><th className="px-4 py-2.5 font-medium">From</th><th /></tr></thead>
              <tbody className="divide-y divide-border">
                {data.items.map((r) => {
                  const open = openRow === r.id;
                  const keys = r.before && typeof r.before === 'object' ? Object.keys(r.before as object) : [];
                  return (
                    <Fragment key={r.id}>
                      <tr className="hover:bg-bg-subtle/60" data-testid="audit-row">
                        <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted"><LocalTime value={r.at} /></td>
                        <td className="px-4 py-2.5">{r.actor ?? ACTOR[r.actorType] ?? r.actorType}<span className="block text-[11px] text-fg-subtle">{ACTOR[r.actorType] ?? r.actorType}</span></td>
                        <td className="px-4 py-2.5"><span className="font-medium">{r.label}</span><span className="block font-mono text-[11px] text-fg-subtle">{r.action}</span></td>
                        <td className="px-4 py-2.5">{r.company ?? (r.tenantId ? 'Workspace' : '—')}</td>
                        <td className="px-4 py-2.5"><Badge tone={STATUS_TONE[r.status]}>{r.status === 'success' ? 'Done' : r.status === 'denied' ? 'Refused' : 'Failed'}</Badge></td>
                        <td className="px-4 py-2.5 text-[12px] text-fg-muted">{r.ip ?? '—'}{r.device && <span className="block text-[11px] text-fg-subtle">{r.device}</span>}</td>
                        <td className="px-2 py-2.5 text-right"><button type="button" aria-expanded={open} aria-label="Details" onClick={() => setOpenRow(open ? null : r.id)} className="rounded p-1 text-fg-muted hover:bg-bg-subtle"><ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} /></button></td>
                      </tr>
                      {open && (
                        <tr className="bg-bg-subtle/40">
                          <td colSpan={7} className="px-4 py-3">
                            {keys.length > 0 ? (
                              <table className="w-full text-[12px]" data-testid="audit-diff">
                                <thead className="text-fg-muted"><tr><th className="py-1 pr-3 font-medium">Field</th><th className="py-1 pr-3 font-medium">Before</th><th className="py-1 font-medium">After</th></tr></thead>
                                <tbody>{keys.map((k) => <tr key={k}><td className="py-1 pr-3 font-mono">{k}</td><td className="max-w-xs break-all py-1 pr-3 text-danger">{show((r.before as Record<string, unknown>)[k])}</td><td className="max-w-xs break-all py-1 text-success">{show((r.after as Record<string, unknown>)?.[k])}</td></tr>)}</tbody>
                              </table>
                            ) : r.changes ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11.5px]">{JSON.stringify(r.changes, null, 2)}</pre> : null}
                            {r.metadata ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11.5px] text-fg-muted">{JSON.stringify(r.metadata, null, 2)}</pre> : null}
                            {!keys.length && !r.changes && !r.metadata && <p className="text-[12px] text-fg-muted">No further details were recorded.</p>}
                            <p className="mt-2 text-[11px] text-fg-subtle">Record {r.resourceType}{r.resourceId ? ` · ${r.resourceId}` : ''}</p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="flex justify-end gap-2">
        {filters.cursor && <Link className={buttonClass('secondary', 'sm')} href={href({})}>Newest</Link>}
        {data.next && <Link className={buttonClass('secondary', 'sm')} href={href({ cursor: data.next })} data-testid="audit-older">Older</Link>}
      </div>
    </div>
  );
}
