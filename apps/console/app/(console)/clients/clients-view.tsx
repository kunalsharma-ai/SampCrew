'use client';
import { CLIENT_INDUSTRIES, CLIENT_INDUSTRY_LABEL, CLIENT_SIZES, CLIENT_STATUS_LABEL, CLIENT_STATUSES, type ClientRow, type ClientStatus } from '@crew/contracts';
import { Alert, Avatar, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR, buttonClass, cn, type Tone } from '@crew/ui';
import { ArrowDown, ArrowUp, Briefcase, Download, Filter, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { LocalTime } from '@/components/local-time';
import { fmtMoneyMap } from '@/lib/format';
import { clientBulkAction } from '../console-actions';

export type ClientFilters = Partial<Record<'q' | 'status' | 'plan' | 'industry' | 'size' | 'paid' | 'createdFrom' | 'createdTo' | 'renewalWithinDays' | 'sort' | 'dir' | 'offset' | 'demo', string>>;

export const CLIENT_TONE: Record<ClientStatus, Tone> = { active: 'success', trial: 'info', payment_due: 'warning', suspended: 'danger', inactive: 'neutral', setup_pending: 'accent', archived: 'neutral' };
const PAY: Record<ClientRow['paymentStatus'], { tone: Tone; label: string }> = { paid: { tone: 'success', label: 'Paid' }, due: { tone: 'warning', label: 'Due' }, overdue: { tone: 'danger', label: 'Overdue' }, none: { tone: 'neutral', label: '—' } };
const PAGE = 25;

export function ClientsView({ data, filters, canManage, canExport, money, managers }: {
  data: { items: ClientRow[]; total: number; counts: Record<string, number>; plans: { key: string; name: string }[] };
  filters: ClientFilters; canManage: boolean; canExport: boolean; money: boolean; managers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [more, setMore] = useState(!!(filters.plan || filters.industry || filters.size || filters.paid || filters.createdFrom || filters.createdTo || filters.renewalWithinDays || filters.demo));
  const [picked, setPicked] = useState<string[]>([]);
  const [bulk, setBulk] = useState<null | 'suspend' | 'activate' | 'tag' | 'assign_manager'>(null);
  const href = (extra: ClientFilters) => {
    const p = new URLSearchParams(Object.entries({ ...filters, offset: '', ...extra }).filter(([, v]) => v) as [string, string][]);
    return `/clients${p.size ? `?${p}` : ''}`;
  };
  const exportHref = (format: string) => {
    const p = new URLSearchParams(Object.entries(filters).filter(([k, v]) => v && k !== 'offset') as [string, string][]);
    p.set('format', format);
    return `/export/clients/export?${p}`;
  };
  const sortBy = (key: string) => href({ sort: key, dir: filters.sort === key && filters.dir !== 'asc' ? 'asc' : 'desc' });
  const SortHead = ({ k, children, className }: { k: string; children: React.ReactNode; className?: string }) => {
    const on = (filters.sort ?? 'created') === k;
    const Icon = on && filters.dir === 'asc' ? ArrowUp : ArrowDown;
    return <TH className={className} aria-sort={on ? (filters.dir === 'asc' ? 'ascending' : 'descending') : undefined}><Link href={sortBy(k)} className="inline-flex items-center gap-1 hover:text-fg">{children}<Icon className={cn('size-3', !on && 'opacity-0')} aria-hidden /></Link></TH>;
  };
  const offset = Number(filters.offset ?? 0);
  const allOnPage = data.items.length > 0 && data.items.every((c) => picked.includes(c.id));

  return (
    <div className="grid gap-4">
      <div role="tablist" aria-label="Status" className="flex flex-wrap gap-1.5" data-testid="client-status-tabs">
        {(['', ...CLIENT_STATUSES] as const).map((s) => {
          const n = s ? data.counts[s] ?? 0 : data.counts.all ?? 0;
          if (s && !n && filters.status !== s) return null;
          const on = (filters.status ?? '') === s;
          return <Link key={s || 'all'} role="tab" aria-selected={on} href={href({ status: s })} className={cn('rounded-full border px-3 py-1 text-[12.5px]', on ? 'border-accent bg-accent-subtle font-medium text-accent' : 'border-border text-fg-muted hover:bg-bg-subtle')}>{s ? CLIENT_STATUS_LABEL[s] : 'All'} <span className="tabular text-fg-subtle">{n}</span></Link>;
        })}
      </div>

      <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>; router.push(href(f)); }}>
        <div className="flex flex-wrap items-center gap-2">
          <Input name="q" defaultValue={filters.q} placeholder="Search company, legal name, website or workspace address" className="min-w-0 flex-1 sm:max-w-md" aria-label="Search clients" data-testid="clients-search" />
          <Button type="submit" variant="secondary">Search</Button>
          <Button type="button" variant="ghost" onClick={() => setMore(!more)} aria-expanded={more}><Filter className="size-4" aria-hidden />Filters</Button>
          {Object.keys(filters).some((k) => k !== 'sort' && k !== 'dir') && <Link href="/clients" className="inline-flex items-center gap-1 text-[12.5px] text-fg-muted hover:text-fg"><X className="size-3.5" aria-hidden />Clear</Link>}
          {canExport && (
            <span className="ml-auto flex items-center gap-1" data-testid="clients-export">
              <Download className="size-4 text-fg-subtle" aria-hidden />
              {(['csv', 'xlsx', 'pdf'] as const).map((f) => <a key={f} href={exportHref(f)} className="rounded px-2 py-1 text-[12.5px] text-accent hover:bg-bg-subtle">{f === 'xlsx' ? 'Excel' : f.toUpperCase()}</a>)}
            </span>
          )}
        </div>
        {more && (
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface p-3 sm:grid-cols-4 lg:grid-cols-8">
            <Field label="Plan">{(p) => <Select {...p} name="plan" defaultValue={filters.plan ?? ''}><option value="">Any</option>{data.plans.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</Select>}</Field>
            <Field label="Paid">{(p) => <Select {...p} name="paid" defaultValue={filters.paid ?? ''}><option value="">Any</option><option value="paid">Paying</option><option value="free">Free or trial</option><option value="enterprise">Enterprise</option></Select>}</Field>
            <Field label="Industry">{(p) => <Select {...p} name="industry" defaultValue={filters.industry ?? ''}><option value="">Any</option>{CLIENT_INDUSTRIES.map((x) => <option key={x} value={x}>{CLIENT_INDUSTRY_LABEL[x]}</option>)}</Select>}</Field>
            <Field label="Size">{(p) => <Select {...p} name="size" defaultValue={filters.size ?? ''}><option value="">Any</option>{CLIENT_SIZES.map((x) => <option key={x} value={x}>{x}</option>)}</Select>}</Field>
            <Field label="Created from">{(p) => <Input {...p} type="date" name="createdFrom" defaultValue={filters.createdFrom} />}</Field>
            <Field label="Created to">{(p) => <Input {...p} type="date" name="createdTo" defaultValue={filters.createdTo} />}</Field>
            <Field label="Renews within">{(p) => <Select {...p} name="renewalWithinDays" defaultValue={filters.renewalWithinDays ?? ''}><option value="">Any time</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></Select>}</Field>
            <Field label="Demo">{(p) => <Select {...p} name="demo" defaultValue={filters.demo ?? ''}><option value="">Include</option><option value="exclude">Hide demo</option><option value="only">Demo only</option></Select>}</Field>
          </div>
        )}
      </form>

      {canManage && picked.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-subtle/40 px-3 py-2 text-[13px]" data-testid="clients-bulk">
          <span className="font-medium">{picked.length} selected</span>
          <Button size="sm" variant="secondary" onClick={() => setBulk('tag')}>Add tag</Button>
          {managers.length > 0 && <Button size="sm" variant="secondary" onClick={() => setBulk('assign_manager')}>Assign account manager</Button>}
          <Button size="sm" variant="secondary" onClick={() => setBulk('activate')}>Activate</Button>
          <Button size="sm" variant="danger" onClick={() => setBulk('suspend')}>Suspend</Button>
          <button type="button" onClick={() => setPicked([])} className="ml-auto text-fg-muted hover:text-fg">Clear selection</button>
        </div>
      )}

      <Card>
        {data.items.length === 0 ? (
          <EmptyState icon={<Briefcase className="size-6" />} title={Object.keys(filters).length ? 'No companies match these filters' : 'No client companies yet'} description={canManage ? 'Create the first company with New company.' : undefined} />
        ) : (
          <Table aria-label="Clients">
            <THead>
              <TR>
                {canManage && <TH className="w-8"><input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={(e) => setPicked(e.target.checked ? [...new Set([...picked, ...data.items.map((c) => c.id)])] : picked.filter((id) => !data.items.some((c) => c.id === id)))} /></TH>}
                <SortHead k="name">Company</SortHead>
                <TH>Status</TH>
                <TH>Plan</TH>
                <SortHead k="users" className="text-right">Users</SortHead>
                <TH className="text-right">Workspaces</TH>
                {money && <SortHead k="revenue" className="text-right">Revenue</SortHead>}
                {money && <TH>Payment</TH>}
                <SortHead k="renewal">Next renewal</SortHead>
                <SortHead k="activity">Last activity</SortHead>
                <SortHead k="created">Created</SortHead>
              </TR>
            </THead>
            <TBody>
              {data.items.map((c) => (
                <TR key={c.id} data-testid="client-row">
                  {canManage && <TD><input type="checkbox" aria-label={`Select ${c.name}`} checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} /></TD>}
                  <TD>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={c.name} src={c.logoUrl} size={30} />
                      <div className="min-w-0">
                        <Link href={`/clients/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                        {c.isDemo && <Badge tone="ember" className="ml-2">Demo</Badge>}
                        <div className="truncate text-[11.5px] text-fg-subtle">{[c.industry ? CLIENT_INDUSTRY_LABEL[c.industry as keyof typeof CLIENT_INDUSTRY_LABEL] ?? c.industry : null, c.location, c.companySize].filter(Boolean).join(' · ') || 'No profile details yet'}</div>
                      </div>
                    </div>
                  </TD>
                  <TD><Badge tone={CLIENT_TONE[c.status]} dot>{CLIENT_STATUS_LABEL[c.status]}</Badge></TD>
                  <TD>{c.planName ?? '—'}{c.subscriptionStatus && c.subscriptionStatus !== 'active' && <span className="block text-[11px] text-fg-subtle">{c.subscriptionStatus.replace('_', ' ')}</span>}</TD>
                  <TD className="text-right tabular">{c.users}<span className="block text-[11px] text-fg-subtle">{c.employees} employees</span></TD>
                  <TD className="text-right tabular" title="Super / HR / Employee Workspaces">{c.superWorkspaces} / {c.hrWorkspaces} / {c.employeeWorkspaces}</TD>
                  {money && <TD className="text-right tabular">{fmtMoneyMap(c.revenue)}{Object.keys(c.mrr).length > 0 && <span className="block text-[11px] text-fg-subtle">MRR {fmtMoneyMap(c.mrr)}</span>}</TD>}
                  {money && <TD><Badge tone={PAY[c.paymentStatus].tone}>{PAY[c.paymentStatus].label}</Badge>{c.paymentStatus !== 'paid' && c.paymentStatus !== 'none' && <span className="block text-[11px] text-fg-subtle">{fmtMoneyMap(c.outstanding)}</span>}</TD>}
                  <TD className="whitespace-nowrap text-fg-muted">{c.nextRenewal ?? '—'}</TD>
                  <TD className="whitespace-nowrap text-fg-muted">{c.lastActivityAt ? <LocalTime value={c.lastActivityAt} relative /> : 'Never'}</TD>
                  <TD className="whitespace-nowrap text-fg-muted"><LocalTime value={c.createdAt} dateOnly /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <div className="flex items-center justify-between text-[12.5px] text-fg-muted">
        <span>{data.total ? `${offset + 1} to ${Math.min(offset + PAGE, data.total)} of ${data.total}` : ''}</span>
        <span className="flex gap-2">
          {offset > 0 && <Link className={buttonClass('secondary', 'sm')} href={href({ offset: String(Math.max(0, offset - PAGE)) })}>Previous</Link>}
          {offset + PAGE < data.total && <Link className={buttonClass('secondary', 'sm')} href={href({ offset: String(offset + PAGE) })}>Next</Link>}
        </span>
      </div>
      {bulk && <BulkDialog action={bulk} ids={picked} names={data.items.filter((c) => picked.includes(c.id)).map((c) => c.name)} managers={managers} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setPicked([]); router.refresh(); }} />}
    </div>
  );
}

const BULK_TITLE = { suspend: 'Suspend companies', activate: 'Activate companies', tag: 'Tag companies', assign_manager: 'Assign an account manager' } as const;

function BulkDialog({ action, ids, names, managers, onClose, onDone }: { action: keyof typeof BULK_TITLE; ids: string[]; names: string[]; managers: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [tag, setTag] = useState('');
  const [manager, setManager] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const ok = action === 'suspend' ? reason.trim().length >= 3 : action === 'tag' ? !!tag.trim() : true;
  const run = () => start(async () => {
    const r = await clientBulkAction({ action, ids, ...(action === 'suspend' || action === 'activate' ? { reason: reason.trim() || undefined } : {}), ...(action === 'tag' ? { tag: tag.trim() } : {}), ...(action === 'assign_manager' ? { accountManagerId: manager || null } : {}) });
    if (!r.ok) { setError(r.message ?? 'That did not work'); return; }
    const bad = r.data!.results.filter((x) => !x.ok);
    if (bad.length) { setFailed(bad.map((b) => b.detail ?? b.id)); return; }
    onDone();
  });
  return (
    <Dialog open onClose={onClose} title={BULK_TITLE[action]} description={`${ids.length} ${ids.length === 1 ? 'company' : 'companies'}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={action === 'suspend' ? 'danger' : 'primary'} disabled={!ok} loading={pending} onClick={run} data-testid="bulk-confirm">{action === 'suspend' ? 'Suspend all' : 'Confirm'}</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {failed.length > 0 && <Alert tone="warning" title="Some did not change">{failed.join('; ')}</Alert>}
        {action === 'suspend' && <Alert tone="warning">Every Super Workspace of these companies is suspended: their people cannot sign in until you activate them again. Nothing is deleted. The reason is saved in the audit log.</Alert>}
        {action === 'activate' && <p className="text-[13px] text-fg-muted">Suspended Super Workspaces of these companies are activated again. Closed workspaces stay closed.</p>}
        {(action === 'suspend' || action === 'activate') && <Field label="Reason" required={action === 'suspend'}>{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}</Field>}
        {action === 'tag' && <Field label="Tag" hint="Shown on the company and searchable">{(p) => <Input {...p} value={tag} onChange={(e) => setTag(e.target.value)} maxLength={40} />}</Field>}
        {action === 'assign_manager' && <Field label="Account manager">{(p) => <Select {...p} value={manager} onChange={(e) => setManager(e.target.value)}><option value="">Nobody (remove)</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}</Field>}
      </div>
    </Dialog>
  );
}
