'use client';
import { changes, crossLinks, headcount, snapshot, timeline, type UniverseChange, type UniverseData } from '@crew/contracts';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, Stat, Table, TBody, TD, TH, THead, TR, cn } from '@crew/ui';
import { Box, LayoutList, Orbit, Pause, Play, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

// three.js is loaded only here, and only when the 3D view is shown.
const Universe3D = dynamic(() => import('./universe-3d'), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-sm text-slate-300">Loading the 3D view…</div>,
});

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899', '#84cc16', '#f97316', '#06b6d4', '#a855f7'];
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const yearBefore = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
const KIND: Record<UniverseChange['kind'], { label: string; tone: 'success' | 'danger' | 'info' | 'warning' | 'neutral' }> = {
  joined: { label: 'Joined', tone: 'success' }, left: { label: 'Left', tone: 'danger' }, moved: { label: 'Moved', tone: 'info' },
  promoted: { label: 'Promoted', tone: 'warning' }, manager_changed: { label: 'New manager', tone: 'neutral' },
};

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

export function UniverseView({ data, initialOn, initialView, initialDept }: { data: UniverseData; initialOn: string | null; initialView: '2d' | '3d' | null; initialDept: string | null }) {
  const stops = useMemo(() => timeline(data.start, data.asOf), [data.start, data.asOf]);
  const [i, setI] = useState(() => {
    if (!initialOn) return stops.length - 1;
    const k = stops.findIndex((s) => s >= initialOn);
    return k < 0 ? stops.length - 1 : k;
  });
  const [view, setView] = useState<'2d' | '3d'>(initialView ?? '2d');
  const [playing, setPlaying] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [selected, setSelected] = useState<string | null>(initialDept);
  const [reduced, setReduced] = useState(false);
  const [no3d, setNo3d] = useState(false);

  // 3D is the default where the browser can draw it and the person has not asked for less motion.
  useEffect(() => {
    const r = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReduced(r);
    const gl = webglAvailable();
    setNo3d(!gl);
    if (!initialView && gl && !r) setView('3d');
  }, [initialView]);

  // Playing steps through the months and stops at today.
  useEffect(() => {
    if (!playing) return;
    if (i >= stops.length - 1) { setPlaying(false); return; }
    const t = setTimeout(() => setI((x) => Math.min(stops.length - 1, x + 1)), reduced ? 900 : 650);
    return () => clearTimeout(t);
  }, [playing, i, stops.length, reduced]);

  const on = stops[i]!;
  const prev = i > 0 ? stops[i - 1]! : data.start < on ? '0000-01-01' : on;
  // Keep the address shareable without adding history entries on every step.
  useEffect(() => {
    if (playing) return;
    const url = new URL(window.location.href);
    url.searchParams.set('on', on);
    url.searchParams.set('view', view);
    if (selected) url.searchParams.set('dept', selected); else url.searchParams.delete('dept');
    window.history.replaceState(window.history.state, '', url.pathname + url.search);
  }, [on, view, selected, playing]);

  const people = useMemo(() => snapshot(data, on), [data, on]);
  const before = useMemo(() => snapshot(data, prev), [data, prev]);
  const counts = useMemo(() => headcount(people), [people]);
  const prevCounts = useMemo(() => headcount(before), [before]);
  const links = useMemo(() => crossLinks(people), [people]);
  const step = useMemo(() => changes(data, prev, on), [data, prev, on]);
  const year = useMemo(() => changes(data, yearBefore(on), on), [data, on]);
  const recent = useMemo(() => changes(data, '0000-01-01', on).slice(-25).reverse(), [data, on]);
  const fresh = useMemo(() => new Set(step.filter((c) => c.kind !== 'left').map((c) => c.personId)), [step]);
  const deptName = useMemo(() => new Map(data.departments.map((d) => [d.id, d.name])), [data.departments]);
  // Departments that ever had someone, so archived ones still show their history.
  const departments = useMemo(() => {
    const used = new Set(data.records.map((r) => r.departmentId).filter(Boolean));
    return data.departments
      .filter((d) => !d.archived || used.has(d.id))
      .map((d, k) => ({ id: d.id, name: d.name, parentId: d.parentId, color: PALETTE[k % PALETTE.length]!, count: counts.get(d.id) ?? 0 }));
  }, [data.departments, data.records, counts]);
  const colorOf = (id: string | null) => departments.find((d) => d.id === id)?.color ?? '#94a3b8';
  const dn = (id: string | null | undefined) => (id ? deptName.get(id) ?? 'Unknown department' : 'No department');

  if (!data.people.length) {
    return <Card><EmptyState icon={<Orbit className="size-5" />} title="No one to show yet" description="People you can see in the directory appear here once they have joined." /></Card>;
  }

  const joinedYear = year.filter((c) => c.kind === 'joined').length;
  const leftYear = year.filter((c) => c.kind === 'left').length;
  const sel = selected ? departments.find((d) => d.id === selected) ?? null : null;
  const selPeople = selected ? people.filter((p) => (p.departmentId ?? 'none') === selected) : [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={`Headcount on ${fmt(on)}`} value={people.length} />
        <Stat label="Departments with people" value={[...counts.keys()].filter((k) => k !== 'none').length} />
        <Stat label="Joined in the year to this date" value={joinedYear} />
        <Stat label="Left in the year to this date" value={leftYear} />
      </div>

      <Card className="p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex gap-1" role="radiogroup" aria-label="View">
            {(['3d', '2d'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                disabled={v === '3d' && no3d}
                onClick={() => setView(v)}
                className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[0.8125rem] disabled:opacity-50', view === v ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-surface text-fg-muted hover:text-fg')}
              >
                {v === '3d' ? <Box className="size-3.5" /> : <LayoutList className="size-3.5" />} {v === '3d' ? '3D map' : '2D table'}
              </button>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={() => { if (!playing && i >= stops.length - 1) setI(0); setPlaying(!playing); }} aria-label={playing ? 'Pause timeline' : 'Play timeline'}>
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />} {playing ? 'Pause' : 'Play'}
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="hidden text-xs text-fg-subtle sm:inline">{fmt(stops[0]!)}</span>
            <input
              type="range"
              min={0}
              max={stops.length - 1}
              value={i}
              onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }}
              aria-label="Date"
              aria-valuetext={fmt(on)}
              className="min-w-0 flex-1 accent-[var(--color-accent)]"
            />
            <span className="whitespace-nowrap text-sm font-medium tabular-nums" aria-live="polite">{fmt(on)}</span>
          </div>
          {view === '3d' && <Checkbox label="Reporting lines" checked={reporting} onChange={(e) => setReporting(e.target.checked)} />}
        </div>
        {no3d && <p className="mt-2 text-xs text-fg-subtle">This browser cannot draw 3D graphics, so the 2D table is shown.</p>}
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_22rem]">
        <div className="min-w-0">
          {view === '3d' && !no3d ? (
            <Card className="h-[34rem] overflow-hidden bg-[radial-gradient(ellipse_at_center,#1e1b4b_0%,#0b1020_70%)] p-0" aria-label="3D organization map">
              <Universe3D
                departments={departments}
                people={people}
                links={links}
                showReporting={reporting}
                fresh={fresh}
                selected={selected}
                onSelect={setSelected}
                reducedMotion={reduced}
                onUnsupported={() => { setNo3d(true); setView('2d'); }}
              />
            </Card>
          ) : (
            <Card>
              <CardHeader title={`Departments on ${fmt(on)}`} description={`Change is against ${i > 0 ? fmt(prev) : 'the start'}. Select a department to see who is in it.`} />
              <div className="overflow-x-auto">
                <Table>
                  <THead><TR><TH>Department</TH><TH className="text-right">Headcount</TH><TH className="text-right">Change</TH><TH className="w-1/3">Share</TH></TR></THead>
                  <TBody>
                    {[...departments, ...(counts.get('none') ? [{ id: 'none', name: 'No department', parentId: null, color: '#94a3b8', count: counts.get('none')! }] : [])].map((d) => {
                      const delta = d.count - (prevCounts.get(d.id) ?? 0);
                      return (
                        <TR key={d.id} className={cn(selected === d.id && 'bg-accent/5')}>
                          <TD>
                            <button type="button" className="flex items-center gap-2 text-left font-medium hover:underline" onClick={() => setSelected(selected === d.id ? null : d.id)} aria-pressed={selected === d.id}>
                              <span className="size-2.5 rounded-full" style={{ background: d.color }} aria-hidden />
                              {d.name}
                            </button>
                          </TD>
                          <TD className="text-right tabular-nums">{d.count}</TD>
                          <TD className={cn('text-right tabular-nums', delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : 'text-fg-subtle')}>{delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '0'}</TD>
                          <TD>
                            <div className="h-2 rounded-full bg-bg-subtle" aria-hidden><div className="h-2 rounded-full" style={{ width: `${people.length ? (d.count / people.length) * 100 : 0}%`, background: d.color }} /></div>
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
              {links.length > 0 && (
                <div className="border-t border-border px-5 py-3 text-xs text-fg-muted">
                  Reporting across departments: {links.map((l) => `${dn(l.a)} and ${dn(l.b)} (${l.count})`).join('; ')}
                </div>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          {sel && (
            <Card aria-label={`${sel.name} on ${fmt(on)}`}>
              <CardHeader
                title={`${sel.name} · ${selPeople.length}`}
                description={`On ${fmt(on)}`}
                action={<Button size="sm" variant="ghost" aria-label="Close department" onClick={() => setSelected(null)}><X className="size-4" /></Button>}
              />
              <ul className="max-h-72 space-y-1.5 overflow-y-auto px-5 pb-4 text-sm">
                {selPeople.length ? selPeople.map((p) => (
                  <li key={p.id} className="flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ background: colorOf(p.departmentId) }} aria-hidden />
                    <Link href={`/employees/${p.id}`} className="truncate hover:underline">{p.name}</Link>
                    <span className="truncate text-xs text-fg-subtle">{p.designation ?? ''}</span>
                  </li>
                )) : <li className="text-fg-muted">No one on this date.</li>}
              </ul>
            </Card>
          )}
          <Card aria-label="Changes">
            <CardHeader
              title={`Recent changes up to ${fmt(on)}`}
              description={step.length ? `${step.length} in this step${i > 0 ? `, since ${fmt(prev)}` : ''}` : 'Nothing changed in this step.'}
            />
            {recent.length > 0 && (
              <ul className="max-h-96 space-y-2 overflow-y-auto px-5 pb-4 text-sm">
                {recent.map((c, k) => (
                  <li key={`${c.personId}-${c.kind}-${c.on}-${k}`} className={cn('flex items-start gap-2 rounded-md', c.on > prev && 'bg-accent/5 -mx-2 px-2 py-1')}>
                    <Badge tone={KIND[c.kind].tone}>{KIND[c.kind].label}</Badge>
                    <span className="min-w-0">
                      <span className="font-medium">{c.name}</span>{' '}
                      <span className="text-fg-muted">
                        {c.kind === 'joined' ? `in ${dn(c.toDepartmentId)}` : c.kind === 'left' ? `from ${dn(c.fromDepartmentId)}` : c.kind === 'moved' ? `${dn(c.fromDepartmentId)} to ${dn(c.toDepartmentId)}` : c.kind === 'promoted' ? `to ${c.designation ?? 'a new role'}` : `in ${dn(c.toDepartmentId)}`}
                      </span>
                      <span className="block text-xs text-fg-subtle">{fmt(c.on)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
