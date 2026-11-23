'use client';
import { Badge, Card, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Columns3, List, Search, Table2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useRunner } from '../../use-runner';
import { stageAction } from '../crm-actions';
import type { CrmContext, CrmRow } from '../crm-types';
import { NoticeBar, StageBadge, day, dueText } from '../crm-ui';

export interface PipelineStage { key: string; label: string; kind: string; count: number }
const KIND_TOP: Record<string, string> = { open: 'border-t-info', won: 'border-t-success', lost: 'border-t-fg-subtle', paused: 'border-t-warning' };

export function PipelineBoard({ ctx, stages, layout, q, recruiter }: { ctx: CrmContext; stages: (PipelineStage & { candidates: CrmRow[] })[]; layout: 'board' | 'table' | 'list'; q: string; recruiter: string }) {
  const router = useRouter();
  const { pending, notice, run } = useRunner();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const url = (patch: Record<string, string>) => {
    const qs = new URLSearchParams(Object.entries({ q, recruiter, layout, ...patch }).filter(([k, v]) => v && !(k === 'layout' && v === 'board')));
    return `/recruitment/crm/pipeline?${qs}`;
  };
  const move = (candidateId: string, stage: string) => {
    const from = stages.find((s) => s.candidates.some((c) => c.id === candidateId));
    if (!from || from.key === stage) return;
    run(() => stageAction(candidateId, stage));
  };
  const all = stages.flatMap((s) => s.candidates);

  return (
    <div className="grid gap-4">
      <NoticeBar notice={notice} />
      <div className="flex flex-wrap items-center gap-3">
        <form className="relative min-w-48 flex-1" onSubmit={(e) => { e.preventDefault(); router.push(url({ q: String(new FormData(e.currentTarget).get('q') ?? '').trim() })); }}>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
          <Input name="q" defaultValue={q} placeholder="Search candidates" className="pl-9" aria-label="Search pipeline" />
        </form>
        <Select aria-label="Filter by recruiter" className="sm:w-48" value={recruiter} onChange={(e) => router.push(url({ recruiter: e.target.value }))}>
          <option value="">Every recruiter</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
          {ctx.recruiters.map((r) => <option key={r.membershipId} value={r.membershipId}>{r.name}</option>)}
        </Select>
        <div className="flex rounded-md border border-border" role="group" aria-label="Layout">
          {([['board', 'Board', Columns3], ['table', 'Table', Table2], ['list', 'List', List]] as const).map(([key, label, Icon]) => (
            <Link key={key} href={url({ layout: key })} aria-current={layout === key ? 'page' : undefined} className={`flex items-center gap-1.5 px-3 py-1.5 text-[0.8125rem] ${layout === key ? 'bg-bg-subtle text-fg' : 'text-fg-muted hover:text-fg'}`}>
              <Icon className="size-3.5" /> {label}
            </Link>
          ))}
        </div>
      </div>

      {layout === 'board' && (
        <div className="flex gap-3 overflow-x-auto pb-3" data-testid="crm-kanban">
          {stages.map((s) => (
            <section
              key={s.key}
              aria-label={s.label}
              data-stage={s.key}
              onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(s.key); } }}
              onDragLeave={() => setOver((o) => (o === s.key ? null : o))}
              onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain') || dragging; setOver(null); setDragging(null); if (id) move(id, s.key); }}
              className={`flex w-64 shrink-0 flex-col rounded-lg border border-t-4 border-border bg-bg-subtle/50 ${KIND_TOP[s.kind] ?? ''} ${over === s.key ? 'ring-2 ring-accent' : ''}`}
            >
              <header className="flex items-center justify-between px-3 py-2 text-[0.8125rem] font-medium"><span>{s.label}</span><Badge tone="neutral">{s.count}</Badge></header>
              <div className="grid max-h-[65vh] gap-2 overflow-y-auto px-2 pb-2">
                {s.candidates.map((c) => (
                  <article
                    key={c.id}
                    draggable={!pending}
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', c.id); setDragging(c.id); }}
                    onDragEnd={() => setDragging(null)}
                    className={`cursor-grab rounded-md border border-border bg-surface p-2.5 text-[0.8125rem] shadow-card ${dragging === c.id ? 'opacity-50' : ''}`}
                  >
                    <Link href={`/recruitment/crm/candidates/${c.id}`} className="font-medium text-accent hover:underline">{c.name}</Link>
                    <p className="text-xs text-fg-muted">{c.candidateCode} · {c.experience || 'Experience not given'}</p>
                    {(c.currentTitle || c.currentCompany) && <p className="truncate text-xs">{[c.currentTitle, c.currentCompany].filter(Boolean).join(' at ')}</p>}
                    <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-fg-subtle">
                      <span>{c.recruiter ?? 'Unassigned'}</span>
                      {c.nextFollowUpAt && <span className={new Date(c.nextFollowUpAt) < new Date() ? 'text-danger' : ''}>{dueText(c.nextFollowUpAt)}</span>}
                    </p>
                    <label className="sr-only" htmlFor={`move-${c.id}`}>Move {c.name}</label>
                    <select id={`move-${c.id}`} className="mt-1.5 w-full rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-fg-muted" value={s.key} disabled={pending} onChange={(e) => move(c.id, e.target.value)}>
                      {ctx.stages.filter((x) => x.active || x.key === s.key).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                    </select>
                  </article>
                ))}
                {s.count > s.candidates.length && <Link href={`/recruitment/crm/candidates?stage=${s.key}`} className="px-1 text-xs text-accent hover:underline">{s.count - s.candidates.length} more</Link>}
                {s.count === 0 && <p className="px-1 py-3 text-center text-xs text-fg-subtle">No candidates</p>}
              </div>
            </section>
          ))}
        </div>
      )}

      {layout === 'table' && (
        <Card>
          <Table aria-label="Pipeline">
            <THead><TR><TH>Candidate</TH><TH>Stage</TH><TH>Experience</TH><TH>Expected CTC</TH><TH>Notice</TH><TH>Recruiter</TH><TH>Next follow-up</TH><TH>In stage since</TH></TR></THead>
            <TBody>
              {all.map((c) => (
                <TR key={c.id}>
                  <TD><Link href={`/recruitment/crm/candidates/${c.id}`} className="font-medium text-accent hover:underline">{c.name}</Link><span className="block text-xs text-fg-muted">{c.candidateCode}</span></TD>
                  <TD><StageBadge label={c.stageLabel} kind={c.stageKind} /></TD><TD>{c.experience || '—'}</TD><TD>{c.expectedCtcText || '—'}</TD><TD>{c.notice || '—'}</TD>
                  <TD>{c.recruiter ?? 'Unassigned'}</TD><TD>{dueText(c.nextFollowUpAt)}</TD><TD>{day(c.stageEnteredAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      {layout === 'list' && (
        <div className="grid gap-4">
          {stages.filter((s) => s.count).map((s) => (
            <Card key={s.key}>
              <header className="flex items-center gap-2 border-b border-border px-5 py-3 text-sm font-medium"><StageBadge label={s.label} kind={s.kind} /><span className="text-fg-muted">{s.count}</span></header>
              <ul className="divide-y divide-border">
                {s.candidates.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5 text-[0.8125rem]">
                    <span><Link href={`/recruitment/crm/candidates/${c.id}`} className="font-medium text-accent hover:underline">{c.name}</Link> <span className="text-xs text-fg-muted">{c.candidateCode} · {[c.currentTitle, c.currentCompany].filter(Boolean).join(' at ')}</span></span>
                    <span className="text-xs text-fg-muted">{c.recruiter ?? 'Unassigned'} · {dueText(c.nextFollowUpAt)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
