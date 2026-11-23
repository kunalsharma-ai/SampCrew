'use client';
import { CRM_DEFAULT_EXPORT, CRM_LIST_COLUMNS, REFERENCE_TYPES, type SavedView, type ViewState } from '@crew/contracts';
import { Badge, Button, buttonClass, Card, type DataColumn, DataTable, EmptyState, Input, Select } from '@crew/ui';
import { Download, Filter, Search, UserSearch } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SavedViews } from '@/components/saved-views';
import { useRunner } from '../../use-runner';
import { bulkAction } from '../crm-actions';
import type { CrmContext, CrmField, CrmList, CrmRow } from '../crm-types';
import { NoticeBar, StageBadge, day, dueText } from '../crm-ui';
import { CRM_FILTERS, crmViewUrl, PAGE_SIZE } from '../crm-view-url';

const muted = (v: string | null | undefined) => <span className="text-fg-muted">{v || '—'}</span>;
const LABEL = Object.fromEntries(CRM_LIST_COLUMNS) as Record<string, string>;

function columns(selected: Set<string>, toggle: (id: string) => void): DataColumn<CrmRow>[] {
  const col = (key: string, render: (r: CrmRow) => React.ReactNode, sort?: string): DataColumn<CrmRow> => ({ key, label: LABEL[key] ?? key, render, sort, className: 'whitespace-nowrap' });
  return [
    {
      key: 'name', label: 'Candidate', sort: 'name', required: true,
      render: (r) => (
        <span className="flex items-start gap-3">
          <input type="checkbox" aria-label={`Select ${r.name}`} className="mt-1 size-4 accent-[var(--accent)]" checked={selected.has(r.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} />
          <span>
            <Link className="font-medium text-accent hover:underline" href={`/recruitment/crm/candidates/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.name}</Link>
            {r.archivedAt && <Badge tone="neutral" className="ml-2">Archived</Badge>}
            <span className="block text-xs text-fg-muted">{[r.email, r.phone].filter(Boolean).join(' · ')}</span>
          </span>
        </span>
      ),
    },
    col('candidateCode', (r) => <span className="font-mono text-xs">{r.candidateCode ?? '—'}</span>),
    col('profession', (r) => muted(r.profession ?? r.currentTitle)),
    col('currentCompany', (r) => muted(r.currentCompany)),
    col('experience', (r) => muted(r.experience), 'experience'),
    col('currentCtc', (r) => muted(r.currentCtcText)),
    col('expectedCtc', (r) => muted(r.expectedCtcText), 'expected_ctc'),
    col('notice', (r) => muted(r.notice)),
    col('location', (r) => muted(r.location)),
    col('reference', (r) => muted(r.reference)),
    col('stage', (r) => <StageBadge label={r.stageLabel} kind={r.stageKind} />, 'stage'),
    col('recruiter', (r) => muted(r.recruiter ?? 'Unassigned')),
    col('nextFollowUp', (r) => <span className={r.nextFollowUpAt && new Date(r.nextFollowUpAt) < new Date() ? 'text-danger' : 'text-fg-muted'}>{dueText(r.nextFollowUpAt)}</span>, 'follow_up'),
    col('lastActivity', (r) => muted(day(r.lastActivityAt)), 'updated'),
    col('source', (r) => muted(r.sourceLabel)),
    col('industry', (r) => muted(r.industry)),
    col('department', (r) => muted(r.department)),
    col('jobRole', (r) => muted(r.jobRole)),
    col('hrWorkspace', (r) => muted(r.hrWorkspace)),
  ];
}

export function CandidateList({ ctx, list, state, page, views, activeViewId, filterFields }: {
  ctx: CrmContext; list: CrmList; state: ViewState; page: number; views: SavedView[]; activeViewId: string | null; filterFields: CrmField[];
}) {
  const router = useRouter();
  const { pending, notice, run } = useRunner();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [more, setMore] = useState(false);
  const [bulk, setBulk] = useState<{ stage: string; recruiter: string; tag: string }>({ stage: '', recruiter: '', tag: '' });
  const filters = state.filters ?? {};
  const go = (patch: Partial<ViewState>) => router.push(crmViewUrl({ ...state, ...patch }, activeViewId));
  const filter = (patch: Record<string, string>) => go({ filters: Object.fromEntries(Object.entries({ ...filters, ...patch }).filter(([, v]) => v)) });
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOnPage = list.rows.length > 0 && list.rows.every((r) => selected.has(r.id));
  const filtered = Object.values(filters).some(Boolean);
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const ids = [...selected];
  const doBulk = (body: Record<string, unknown>) => run(() => bulkAction({ ...body, ids }), () => setSelected(new Set()));
  const exportQs = new URLSearchParams(Object.entries(filters).filter(([k]) => (CRM_FILTERS as readonly string[]).includes(k) || k.startsWith('cf.')));
  const submitFilters = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const patch: Record<string, string> = {};
    for (const [k, v] of fd.entries()) patch[k] = String(v).trim();
    filter(patch);
  };

  return (
    <div className="grid gap-4">
      <NoticeBar notice={notice} />
      {selected.size > 0 && (
        <Card className="flex flex-wrap items-center gap-3 px-5 py-3 text-[0.8125rem]" data-testid="crm-bulk-bar">
          <span className="font-medium">{selected.size} selected</span>
          <Select aria-label="Move selected to stage" className="sm:w-48" value={bulk.stage} onChange={(e) => setBulk({ ...bulk, stage: e.target.value })}>
            <option value="">Move to stage…</option>
            {ctx.stages.filter((s) => s.active).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </Select>
          <Button size="sm" variant="secondary" disabled={!bulk.stage || pending} onClick={() => doBulk({ action: 'stage', stage: bulk.stage })}>Move</Button>
          <Select aria-label="Assign selected to recruiter" className="sm:w-48" value={bulk.recruiter} onChange={(e) => setBulk({ ...bulk, recruiter: e.target.value })}>
            <option value="">Assign recruiter…</option>
            <option value="none">Remove recruiter</option>
            {ctx.recruiters.map((r) => <option key={r.membershipId} value={r.membershipId}>{r.name}</option>)}
          </Select>
          <Button size="sm" variant="secondary" disabled={!bulk.recruiter || pending} onClick={() => doBulk({ action: 'assign', membershipId: bulk.recruiter === 'none' ? null : bulk.recruiter })}>Assign</Button>
          <Input aria-label="Tag to add" placeholder="Add tag" className="sm:w-32" value={bulk.tag} onChange={(e) => setBulk({ ...bulk, tag: e.target.value })} />
          <Button size="sm" variant="secondary" disabled={!bulk.tag.trim() || pending} onClick={() => doBulk({ action: 'tag', tag: bulk.tag.trim() })}>Tag</Button>
          {ctx.caps.includes('archive') && <Button size="sm" variant="secondary" disabled={pending} onClick={() => doBulk({ action: 'archive' })}>Archive</Button>}
          {ctx.caps.includes('export') && (
            <form method="post" action="/crm-export" className="contents">
              <input type="hidden" name="payload" value={JSON.stringify({ scope: 'selected', ids, columns: CRM_DEFAULT_EXPORT, format: 'xlsx' })} />
              <button type="submit" className={buttonClass('secondary', 'sm')}><Download className="size-3.5" /> Export selected</button>
            </form>
          )}
          <button type="button" className="ml-auto text-accent hover:underline" onClick={() => setSelected(new Set())}>Clear selection</button>
        </Card>
      )}
        {more && (
          <Card><form onSubmit={submitFilters} className="grid gap-3 px-5 py-4 text-[0.8125rem] sm:grid-cols-2 lg:grid-cols-4" aria-label="More filters">
            <label className="grid gap-1">Source<Select name="source" defaultValue={filters.source ?? ''}><option value="">Any</option>{ctx.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select></label>
            <label className="grid gap-1">Reference<Select name="referenceType" defaultValue={filters.referenceType ?? ''}><option value="">Any</option>{REFERENCE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></label>
            <label className="grid gap-1">Next follow-up<Select name="followUp" defaultValue={filters.followUp ?? ''}><option value="">Any</option><option value="overdue">Overdue</option><option value="today">Due today</option><option value="any">Scheduled</option><option value="none">None scheduled</option></Select></label>
            {ctx.level === 'super' && <label className="grid gap-1">HR Workspace<Select name="hrWorkspace" defaultValue={filters.hrWorkspace ?? ''}><option value="">Any</option><option value="central">Super Workspace (company-wide)</option>{ctx.hrWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></label>}
            <label className="grid gap-1">Location<Input name="location" defaultValue={filters.location ?? ''} placeholder="City or state" /></label>
            <label className="grid gap-1">Skills<Input name="skills" defaultValue={filters.skills ?? ''} placeholder="Comma separated" /></label>
            <label className="grid gap-1">Tag<Input name="tag" defaultValue={filters.tag ?? ''} /></label>
            <label className="grid gap-1">Max notice (days)<Input name="maxNotice" inputMode="numeric" defaultValue={filters.maxNotice ?? ''} /></label>
            <label className="grid gap-1">Experience from (years)<Input name="minExp" inputMode="decimal" defaultValue={filters.minExp ?? ''} /></label>
            <label className="grid gap-1">Experience up to (years)<Input name="maxExp" inputMode="decimal" defaultValue={filters.maxExp ?? ''} /></label>
            <label className="grid gap-1">Expected CTC from<Input name="minExpected" inputMode="numeric" defaultValue={filters.minExpected ?? ''} /></label>
            <label className="grid gap-1">Expected CTC up to<Input name="maxExpected" inputMode="numeric" defaultValue={filters.maxExpected ?? ''} /></label>
            <label className="grid gap-1">Archived<Select name="archived" defaultValue={filters.archived ?? ''}><option value="">Hide archived</option><option value="include">Include archived</option><option value="only">Only archived</option></Select></label>
            {filterFields.map((f) => (
              <label key={f.key} className="grid gap-1">{f.label}
                {f.options.length ? (
                  <Select name={`cf.${f.key}`} defaultValue={filters[`cf.${f.key}`] ?? ''}><option value="">Any</option>{f.options.filter((o) => !o.archived).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
                ) : f.type === 'yes_no' || f.type === 'checkbox' ? (
                  <Select name={`cf.${f.key}`} defaultValue={filters[`cf.${f.key}`] ?? ''}><option value="">Any</option><option value="true">Yes</option><option value="false">No</option></Select>
                ) : (
                  <Input name={`cf.${f.key}`} defaultValue={filters[`cf.${f.key}`] ?? ''} />
                )}
              </label>
            ))}
            <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4"><Button type="submit" size="sm">Apply filters</Button><Button type="button" size="sm" variant="ghost" onClick={() => setMore(false)}>Close</Button></div>
          </form></Card>
        )}
      <Card>
        <DataTable
          label="Candidates"
          columns={columns(selected, toggle)}
          visible={state.columns ?? ['name']}
          onVisibleChange={(cols) => go({ columns: cols })}
          rows={list.rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => router.push(`/recruitment/crm/candidates/${r.id}`)}
          sort={state.sort}
          dir={state.dir ?? (state.sort === 'name' || state.sort === 'follow_up' ? 'asc' : 'desc')}
          onSort={(sort, dir) => go({ sort, dir })}
          density={state.density}
          onDensityChange={(density) => go({ density })}
          toolbar={
            <>
              <form className="relative min-w-48 flex-1" onSubmit={(e) => { e.preventDefault(); filter({ q: String(new FormData(e.currentTarget).get('q') ?? '').trim() }); }}>
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
                <Input key={filters.q ?? ''} name="q" defaultValue={filters.q ?? ''} placeholder="Search name, ID, email, phone, company or skill" className="pl-9" aria-label="Search candidates" />
              </form>
              <Select value={filters.stage ?? ''} onChange={(e) => filter({ stage: e.target.value })} className="sm:w-44" aria-label="Filter by stage">
                <option value="">Any stage</option>
                {ctx.stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </Select>
              <Select value={filters.recruiter ?? ''} onChange={(e) => filter({ recruiter: e.target.value })} className="sm:w-44" aria-label="Filter by recruiter">
                <option value="">Any recruiter</option>
                <option value="me">Assigned to me</option>
                <option value="none">Unassigned</option>
                {ctx.recruiters.map((r) => <option key={r.membershipId} value={r.membershipId}>{r.name}</option>)}
              </Select>
              <Button type="button" size="sm" variant="secondary" onClick={() => setMore(!more)} aria-expanded={more}><Filter className="size-3.5" /> More filters</Button>
            </>
          }
          actions={
            <>
              <SavedViews page="candidate_crm" allLabel="All candidates" views={views} activeId={activeViewId} current={state} onApply={(v) => router.push(v ? crmViewUrl(v.state, v.id) : '/recruitment/crm/candidates?view=all')} />
              {ctx.caps.includes('export') && <Link className={buttonClass('secondary', 'sm')} href={`/recruitment/crm/export?${exportQs}`}><Download className="size-3.5" /> Export</Link>}
            </>
          }
          empty={<EmptyState icon={<UserSearch className="size-5" />} title={filtered ? 'No one matches these filters' : 'No candidates yet'} description={filtered ? 'Change or clear the filters.' : 'Add a candidate or import a spreadsheet to get started.'} />}
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-[0.8125rem] text-fg-muted">
              <span className="flex items-center gap-3">
                <label className="flex items-center gap-1.5"><input type="checkbox" className="size-4 accent-[var(--accent)]" checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(list.rows.map((r) => r.id)))} /> Select this page</label>
                <span>{list.total.toLocaleString('en-IN')} candidate{list.total === 1 ? '' : 's'}{pages > 1 ? ` · page ${page} of ${pages}` : ''}</span>
              </span>
              <span className="flex items-center gap-3">
                {filtered && <button type="button" className="font-medium text-accent hover:underline" onClick={() => go({ filters: {} })}>Clear filters</button>}
                {page > 1 && <Link className="font-medium text-accent hover:underline" href={crmViewUrl(state, activeViewId, page - 1)}>Previous</Link>}
                {page < pages && <Link className="font-medium text-accent hover:underline" href={crmViewUrl(state, activeViewId, page + 1)}>Next</Link>}
              </span>
            </div>
          }
        />
      </Card>
    </div>
  );
}
