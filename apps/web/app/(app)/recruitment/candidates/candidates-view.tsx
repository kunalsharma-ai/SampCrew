'use client';
import type { SavedView, ViewState } from '@crew/contracts';
import { Badge, Button, buttonClass, Card, type DataColumn, DataTable, EmptyState, Input, Select } from '@crew/ui';
import { Download, Plus, Search, UserSearch } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import { SavedViews } from '@/components/saved-views';
import type { Candidate } from '@/lib/types';
import { addCandidateAction } from '../actions';
import { APP_STATUS, opts, SOURCE } from '../labels';
import { candidateQuery, candidateViewUrl, DEFAULT_CANDIDATE_COLUMNS } from './view-url';

const SOURCES = Object.fromEntries(Object.entries(SOURCE).filter(([k]) => k !== 'career_site'));
const name = (c: Candidate) => (c.anonymizedAt ? 'Erased candidate' : `${c.firstName} ${c.lastName}`.trim());
const muted = (v: string | null | undefined) => <span className="text-fg-muted">{v || '—'}</span>;
const day = (d: string) => new Date(d).toLocaleDateString([], { dateStyle: 'medium' });

const COLUMNS: DataColumn<Candidate>[] = [
  {
    key: 'name', label: 'Candidate', sort: 'name', required: true,
    render: (c) => (
      <span>
        <Link className="font-medium text-accent hover:underline" href={`/recruitment/candidates/${c.id}`} onClick={(e) => e.stopPropagation()}>{name(c)}</Link>
        <span className="block text-xs text-fg-muted">{[c.currentTitle, c.currentCompany].filter(Boolean).join(' at ') || c.email}</span>
      </span>
    ),
  },
  { key: 'role', label: 'Current role', render: (c) => muted([c.currentTitle, c.currentCompany].filter(Boolean).join(' at ')) },
  { key: 'email', label: 'Email', render: (c) => muted(c.email) },
  { key: 'location', label: 'Location', render: (c) => muted(c.locationText) },
  {
    key: 'jobs', label: 'Jobs',
    render: (c) => (
      <span className="text-[0.8125rem]">
        {(c.applications ?? []).map((a, i) => <span key={i} className="block">{a.requisitionTitle} <span className="text-fg-muted">· {a.status === 'active' ? a.stage : (APP_STATUS[a.status] ?? a.status)}</span></span>)}
        {!c.applications?.length && <span className="text-fg-muted">Not in a job yet</span>}
      </span>
    ),
  },
  { key: 'source', label: 'Source', render: (c) => SOURCE[c.source] ?? c.source },
  { key: 'tags', label: 'Tags', render: (c) => (c.tags.length ? <span className="flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}</span> : muted(null)) },
  { key: 'added', label: 'Added', sort: 'added', className: 'whitespace-nowrap', render: (c) => muted(day(c.createdAt)) },
  { key: 'activity', label: 'Last activity', sort: 'activity', className: 'whitespace-nowrap', render: (c) => muted(day(c.lastActivityAt)) },
];

export function CandidatesView({ candidates, state, views, activeViewId, jobs, canAdd }: {
  candidates: Candidate[];
  state: ViewState;
  views: SavedView[];
  activeViewId: string | null;
  jobs: { id: string; label: string }[];
  canAdd: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const filters = state.filters ?? {};
  // Every change keeps the active view selected; the menu shows when it no longer matches what is saved.
  const go = (patch: Partial<ViewState>) => router.push(candidateViewUrl({ ...state, ...patch }, activeViewId));
  const filter = (patch: Record<string, string>) => go({ filters: { ...filters, ...patch } });
  const filtered = Object.values(filters).some(Boolean);
  const exportQs = candidateQuery(state).toString();
  return (
    <div className="grid gap-6">
      <Card>
        <DataTable
          label="Candidates"
          columns={COLUMNS}
          visible={state.columns ?? DEFAULT_CANDIDATE_COLUMNS}
          onVisibleChange={(columns) => go({ columns })}
          rows={candidates}
          rowKey={(c) => c.id}
          onRowClick={(c) => router.push(`/recruitment/candidates/${c.id}`)}
          sort={state.sort}
          dir={state.dir}
          onSort={(sort, dir) => go({ sort, dir })}
          density={state.density}
          onDensityChange={(density) => go({ density })}
          toolbar={
            <>
              <form className="relative min-w-48 flex-1" onSubmit={(e) => { e.preventDefault(); filter({ q: String(new FormData(e.currentTarget).get('q') ?? '').trim() }); }}>
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
                <Input key={filters.q ?? ''} name="q" defaultValue={filters.q ?? ''} placeholder="Search by name, email or company" className="pl-9" aria-label="Search candidates" />
              </form>
              {jobs.length > 0 && (
                <Select value={filters.requisitionId ?? ''} onChange={(e) => filter({ requisitionId: e.target.value })} className="sm:w-52" aria-label="Filter by job">
                  <option value="">Any job</option>
                  {jobs.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
                </Select>
              )}
              <Select value={filters.status ?? ''} onChange={(e) => filter({ status: e.target.value })} className="sm:w-40" aria-label="Filter by application status">
                <option value="">Any status</option>
                <option value="active">In process</option>
                <option value="hired">Hired</option>
                <option value="rejected">Rejected</option>
                <option value="withdrawn">Withdrew</option>
                <option value="none">Not in a job</option>
              </Select>
              <Select value={filters.source ?? ''} onChange={(e) => filter({ source: e.target.value })} className="sm:w-36" aria-label="Filter by source">
                <option value="">Any source</option>
                {Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
              <form className="sm:w-32" onSubmit={(e) => { e.preventDefault(); filter({ tag: String(new FormData(e.currentTarget).get('tag') ?? '').trim() }); }}>
                <Input key={filters.tag ?? ''} name="tag" defaultValue={filters.tag ?? ''} placeholder="Tag" aria-label="Filter by tag" />
              </form>
            </>
          }
          actions={
            <>
              <SavedViews
                page="candidates"
                allLabel="All candidates"
                views={views}
                activeId={activeViewId}
                current={state}
                onApply={(v) => router.push(v ? candidateViewUrl(v.state, v.id) : '/recruitment/candidates?view=all')}
              />
              <a className={buttonClass('secondary', 'sm')} href={`/candidates-export?${exportQs}`} download>
                <Download className="size-3.5" /> Export CSV
              </a>
              <a className={buttonClass('secondary', 'sm')} href={`/candidates-export?${exportQs}&format=xlsx`} download>
                <Download className="size-3.5" /> Export Excel
              </a>
              {canAdd && <Button size="sm" onClick={() => setOpen(true)}><Plus className="size-3.5" /> Add candidate</Button>}
            </>
          }
          empty={<EmptyState icon={<UserSearch className="size-5" />} title={filtered ? 'No one matches these filters' : 'No candidates yet'} description="Candidates come from your career site or are added by recruiters." />}
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-[0.8125rem] text-fg-muted">
              <span>{candidates.length} shown</span>
              {filtered && <button type="button" className="font-medium text-accent hover:underline" onClick={() => go({ filters: {} })}>Clear filters</button>}
            </div>
          }
        />
      </Card>
      <ResourceDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add candidate"
        description="Only add people who have shared their details with you to be considered for a job."
        fields={[
          { name: 'firstName', label: 'First name', required: true, half: true },
          { name: 'lastName', label: 'Last name', half: true },
          { name: 'email', label: 'Email', required: true, half: true },
          { name: 'phone', label: 'Phone', half: true },
          { name: 'currentTitle', label: 'Current title', half: true },
          { name: 'currentCompany', label: 'Current company', half: true },
          { name: 'source', label: 'Source', type: 'select', required: true, half: true, options: opts(SOURCES) },
          { name: 'tags', label: 'Tags', half: true, placeholder: 'Comma separated' },
          { name: 'lawfulBasisConfirmed', label: 'I may store this person’s details', type: 'select', required: true, options: [{ value: 'true', label: 'Yes, they shared them with us to be considered' }] },
        ]}
        initial={{ source: 'sourced', lawfulBasisConfirmed: 'true' }}
        submitLabel="Add candidate"
        onSubmit={async (v) => {
          const r = await addCandidateAction(v);
          if (r.ok && r.data) router.push(`/recruitment/candidates/${(r.data as { id: string }).id}`);
          return r;
        }}
      />
    </div>
  );
}
