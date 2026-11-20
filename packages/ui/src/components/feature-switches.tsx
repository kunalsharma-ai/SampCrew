'use client';
import { ChevronRight, Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { cn } from '../cn';
import { Button } from './button';
import { Dialog } from './dialog';
import { Input, Select, Switch } from './form';
import { Alert, Badge, type Tone } from './surface';

/** How a switch looks to the person managing it (see FeatureIndicator in @crew/contracts). */
export type SwitchIndicator = 'active' | 'inactive' | 'restricted' | 'inherited' | 'pending';

export interface SwitchCell {
  on: boolean;
  indicator: SwitchIndicator;
  restrictedBy?: string;
  setBy?: string;
  editable: boolean;
}

export interface SwitchRow {
  key: string;
  name: string;
  module: string;
  /** Null for a module, the module key for one of its pages. */
  parent: string | null;
  audience?: 'employee' | 'hr' | 'admin' | null;
  cells: Record<string, SwitchCell>;
  /** Extra text under the name (for example how many companies use it). */
  note?: ReactNode;
}

export interface SwitchColumn {
  key: string;
  label: string;
  /** Who the switch is for, used in the confirmation ("for the HR Workspace level"). */
  target: string;
}

const INDICATOR: Record<SwitchIndicator, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'success' },
  inherited: { label: 'Inherited', tone: 'info' },
  inactive: { label: 'Inactive', tone: 'warning' },
  restricted: { label: 'Restricted', tone: 'neutral' },
  pending: { label: 'Pending', tone: 'ember' },
};
const RESTRICTED_BY: Record<string, string> = {
  console: 'Switched off by SAMPLEDGE',
  plan: 'Not in the plan',
  company: 'Switched off for the whole company',
  super: 'Switched off by the Super Workspace',
  hr_workspace: 'Its module is switched off here',
};
const SET_BY: Record<string, string> = { super: 'Switched off by the Super Workspace', hr: 'Switched off by HR Workspace' };
const AUDIENCE: Record<string, string> = { employee: 'Employees', hr: 'HR', admin: 'Admins' };

export function IndicatorBadge({ cell }: { cell: SwitchCell }) {
  const i = INDICATOR[cell.indicator];
  const why = cell.indicator === 'restricted' ? RESTRICTED_BY[cell.restrictedBy ?? ''] : cell.indicator === 'inactive' ? SET_BY[cell.setBy ?? ''] : undefined;
  return <Badge tone={i.tone} className="cursor-default" dot><span title={why}>{i.label}</span></Badge>;
}

/**
 * Feature management board: every module with its pages under it, one switch per level (column), a label on each
 * (Active, Inherited, Inactive, Restricted, Pending), search and a status filter. Switching something off asks first.
 */
export function FeatureSwitchBoard({ rows, columns, onChange, busy, intro }: {
  rows: SwitchRow[];
  columns: SwitchColumn[];
  onChange: (key: string, column: string, on: boolean) => void;
  busy?: boolean;
  intro?: ReactNode;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | SwitchIndicator>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ row: SwitchRow; column: SwitchColumn } | null>(null);
  const modules = useMemo(() => rows.filter((r) => !r.parent), [rows]);
  const partsOf = useMemo(() => {
    const m = new Map<string, SwitchRow[]>();
    for (const r of rows) if (r.parent) m.set(r.parent, [...(m.get(r.parent) ?? []), r]);
    return m;
  }, [rows]);
  const needle = q.trim().toLowerCase();
  const matches = (r: SwitchRow) =>
    (!needle || `${r.name} ${r.module} ${r.key}`.toLowerCase().includes(needle)) && (status === 'all' || Object.values(r.cells).some((c) => c.indicator === status));
  const filtering = Boolean(needle) || status !== 'all';
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) for (const cell of Object.values(r.cells)) c[cell.indicator] = (c[cell.indicator] ?? 0) + 1;
    return c;
  }, [rows]);
  const flip = (row: SwitchRow, column: SwitchColumn, on: boolean) => (on ? onChange(row.key, column.key, true) : setConfirm({ row, column }));

  const line = (r: SwitchRow, depth: 0 | 1, hasParts: boolean) => (
    <div key={r.key} role="row" data-testid={`feature-${r.key}`} className={cn('grid items-center gap-x-3 gap-y-2 border-t border-border px-3 py-2', depth ? 'bg-bg-subtle/40 pl-8' : '')}
      style={{ gridTemplateColumns: `minmax(12rem,1fr) repeat(${columns.length}, minmax(9.5rem, 11rem))` }}>
      <div role="cell" className="flex min-w-0 items-center gap-2">
        {depth === 0 && (hasParts
          ? <button type="button" aria-expanded={open.has(r.key) || filtering} aria-label={`${open.has(r.key) ? 'Hide' : 'Show'} the pages of ${r.name}`} onClick={() => setOpen((s) => { const n = new Set(s); n.has(r.key) ? n.delete(r.key) : n.add(r.key); return n; })} className="rounded p-0.5 text-fg-subtle hover:bg-bg-subtle hover:text-fg"><ChevronRight className={cn('size-4 transition-transform', (open.has(r.key) || filtering) && 'rotate-90')} aria-hidden /></button>
          : <span className="w-5" aria-hidden />)}
        <div className="min-w-0">
          <p className={cn('truncate text-sm', depth === 0 ? 'font-medium' : '')} title={r.name}>{r.name}</p>
          <p className="truncate text-xs text-fg-subtle">{depth === 0 ? r.module : r.audience ? `Page · for ${AUDIENCE[r.audience]}` : 'Page'}{r.note ? <> · {r.note}</> : null}</p>
        </div>
      </div>
      {columns.map((c) => {
        const cell = r.cells[c.key];
        if (!cell) return <div key={c.key} role="cell" />;
        return (
          <div key={c.key} role="cell" className="flex items-center justify-between gap-2">
            <IndicatorBadge cell={cell} />
            <Switch label={`${r.name} for ${c.target}`} testId={`switch-${r.key}-${c.key}`} checked={cell.on} disabled={busy || !cell.editable} onChange={(next) => flip(r, c, next)} />
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {intro}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input aria-label="Search features" placeholder="Search modules and pages" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
        <Select aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="w-auto">
          <option value="all">All ({rows.length})</option>
          {(['active', 'inherited', 'inactive', 'restricted', 'pending'] as const).filter((s) => counts[s]).map((s) => <option key={s} value={s}>{INDICATOR[s].label} ({counts[s]})</option>)}
        </Select>
        <Button variant="ghost" size="sm" onClick={() => setOpen(open.size ? new Set() : new Set(modules.map((m) => m.key)))}>{open.size ? 'Collapse all' : 'Show all pages'}</Button>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <div role="table" aria-label="Features" className="min-w-fit text-sm">
          <div role="row" className="grid gap-x-3 bg-surface px-3 py-2 text-xs font-medium text-fg-subtle" style={{ gridTemplateColumns: `minmax(12rem,1fr) repeat(${columns.length}, minmax(9.5rem, 11rem))` }}>
            <div role="columnheader">Module or page</div>
            {columns.map((c) => <div key={c.key} role="columnheader">{c.label}</div>)}
          </div>
          {modules.flatMap((m) => {
            const parts = partsOf.get(m.key) ?? [];
            const shownParts = parts.filter(matches);
            if (!matches(m) && !shownParts.length) return [];
            return [line(m, 0, parts.length > 0), ...((open.has(m.key) || filtering) ? (filtering ? shownParts : parts).map((p) => line(p, 1, false)) : [])];
          })}
        </div>
      </div>
      <Dialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        title={confirm ? `Switch off ${confirm.row.name}?` : ''}
        description={confirm ? `For ${confirm.column.target}.` : undefined}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="danger" data-testid="confirm-switch-off" onClick={() => { if (confirm) onChange(confirm.row.key, confirm.column.key, false); setConfirm(null); }}>Switch off</Button>
        </>}
      >
        {confirm && (
          <Alert tone="warning">
            {confirm.row.parent ? 'This page' : 'This module and every page in it'} disappears at once for everyone it applies to, also in sessions that are open, and its routes are refused on the server. Nothing is deleted: its records come back when you switch it on again. The change is written to the audit trail.
          </Alert>
        )}
      </Dialog>
    </div>
  );
}
