'use client';
import {
  applyScenario, flowByStage, FLOW_OUTCOMES, globeCentre, orthographic, type RecruitmentFlow, type Scenario, type ScenarioBaseline, type ScenarioInput,
  SKILL_LEVEL_LABEL, skillsLayout, skillSummary, type SkillsNetwork, snapshot, timeline, type UniverseData,
} from '@crew/contracts';
import { Alert, Badge, Button, buttonClass, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, TBody, TD, TH, THead, TR, Textarea, cn } from '@crew/ui';
import { Globe2, Minus, Plus, RotateCcw, RotateCw, Save, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useMemo, useRef, useState, useTransition } from 'react';
import { deleteScenarioAction, saveScenarioAction } from './lens-actions';

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899', '#84cc16', '#f97316', '#06b6d4', '#a855f7'];
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const SPACE = 'bg-[radial-gradient(ellipse_at_center,#1e1b4b_0%,#0b1020_70%)]';

// ---------------------------------------------------------------------------------------------------------------
// Locations: an orthographic globe with a dot per location, sized by headcount on the chosen date.
// ---------------------------------------------------------------------------------------------------------------

export function LocationsLens({ data }: { data: UniverseData }) {
  const stops = useMemo(() => timeline(data.start, data.asOf), [data.start, data.asOf]);
  const [i, setI] = useState(stops.length - 1);
  const on = stops[i]!;
  const yearAgo = `${Number(on.slice(0, 4)) - 1}${on.slice(4)}`;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of snapshot(data, on)) m.set(p.locationId ?? 'none', (m.get(p.locationId ?? 'none') ?? 0) + 1);
    return m;
  }, [data, on]);
  const before = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of snapshot(data, yearAgo)) m.set(p.locationId ?? 'none', (m.get(p.locationId ?? 'none') ?? 0) + 1);
    return m;
  }, [data, yearAgo]);
  const rows = data.locations.map((l) => ({ ...l, n: counts.get(l.id) ?? 0, was: before.get(l.id) ?? 0 })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const mapped = rows.filter((r) => r.latitude != null && r.longitude != null);
  const start = useMemo(() => globeCentre(mapped.map((r) => ({ lat: r.latitude!, lng: r.longitude!, weight: r.n }))), [mapped.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [view, setView] = useState(start);
  const [picked, setPicked] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; lat: number; lng: number } | null>(null);
  const R = 200;
  const max = Math.max(1, ...rows.map((r) => r.n));
  const unplaced = counts.get('none') ?? 0;

  const graticule = useMemo(() => {
    const lines: string[] = [];
    const path = (pts: { x: number; y: number; visible: boolean }[]) => {
      let d = ''; let pen = false;
      for (const p of pts) {
        if (!p.visible) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${(R + p.x * R).toFixed(1)},${(R + p.y * R).toFixed(1)}`;
        pen = true;
      }
      return d;
    };
    for (let lat = -60; lat <= 60; lat += 30) lines.push(path(Array.from({ length: 73 }, (_, k) => orthographic(lat, -180 + k * 5, view.lat, view.lng))));
    for (let lng = -180; lng < 180; lng += 30) lines.push(path(Array.from({ length: 37 }, (_, k) => orthographic(-90 + k * 5, lng, view.lat, view.lng))));
    return lines.filter(Boolean);
  }, [view]);

  const spin = (dLng: number, dLat = 0) => setView((v) => ({ lat: Math.max(-80, Math.min(80, v.lat + dLat)), lng: ((v.lng + dLng + 540) % 360) - 180 }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={`Headcount on ${fmt(on)}`} value={[...counts.values()].reduce((a, b) => a + b, 0)} />
        <Stat label="Locations with people" value={rows.filter((r) => r.n > 0).length} />
        <Stat label="Countries" value={new Set(rows.filter((r) => r.n > 0).map((r) => r.countryCode)).size} />
        <Stat label="Without a location" value={unplaced} />
      </div>
      <Card className="p-4">
        <label className="flex flex-col gap-2 text-[0.8125rem] font-medium">
          <span>Date: {fmt(on)}</span>
          <input type="range" min={0} max={stops.length - 1} value={i} onChange={(e) => setI(Number(e.target.value))} aria-label="Date" aria-valuetext={fmt(on)} className="w-full accent-[var(--accent)]" />
        </label>
      </Card>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_24rem]">
        <Card className={cn('relative overflow-hidden p-4', SPACE)} aria-label="Globe of locations">
          <svg
            viewBox={`-10 -10 ${2 * R + 20} ${2 * R + 20}`}
            className="mx-auto block h-[28rem] w-full max-w-[32rem] touch-none select-none"
            role="img"
            aria-label={`Globe showing ${mapped.filter((r) => r.n > 0).length} locations with people. Drag to turn it.`}
            onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ...view }; }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              setView({ lat: Math.max(-80, Math.min(80, d.lat + (e.clientY - d.y) * 0.4)), lng: ((d.lng - (e.clientX - d.x) * 0.4 + 540) % 360) - 180 });
            }}
            onPointerUp={() => { drag.current = null; }}
          >
            <defs>
              <radialGradient id="sea" cx="40%" cy="35%"><stop offset="0%" stopColor="#3730a3" /><stop offset="100%" stopColor="#0f172a" /></radialGradient>
            </defs>
            <circle cx={R} cy={R} r={R} fill="url(#sea)" stroke="#6366f1" strokeOpacity={0.5} />
            {graticule.map((d, k) => <path key={k} d={d} fill="none" stroke="#a5b4fc" strokeOpacity={0.18} strokeWidth={0.8} />)}
            {mapped.map((l) => {
              const p = orthographic(l.latitude!, l.longitude!, view.lat, view.lng);
              if (!p.visible) return null;
              const r = l.n ? 4 + Math.sqrt(l.n / max) * 16 : 3;
              const x = R + p.x * R; const y = R + p.y * R;
              const on2 = picked === l.id;
              return (
                <g key={l.id} onClick={() => setPicked(on2 ? null : l.id)} className="cursor-pointer" data-location={l.name}>
                  <circle cx={x} cy={y} r={r + 6} fill="#22d3ee" opacity={on2 ? 0.35 : 0.15} />
                  <circle cx={x} cy={y} r={r} fill={l.n ? '#22d3ee' : '#64748b'} stroke="#fff" strokeWidth={on2 ? 2 : 0.8} />
                  <text x={x + r + 4} y={y + 4} fill="#e2e8f0" fontSize={11}>{l.name} · {l.n}</text>
                </g>
              );
            })}
          </svg>
          <div className="absolute bottom-3 right-3 flex gap-1">
            <Button size="sm" variant="secondary" onClick={() => spin(-30)} aria-label="Turn the globe west"><RotateCcw className="size-3.5" /></Button>
            <Button size="sm" variant="secondary" onClick={() => spin(30)} aria-label="Turn the globe east"><RotateCw className="size-3.5" /></Button>
            <Button size="sm" variant="secondary" onClick={() => setView(start)} aria-label="Centre on our locations"><Globe2 className="size-3.5" /></Button>
          </div>
        </Card>
        <Card>
          <CardHeader title={`Locations on ${fmt(on)}`} description={`Change is against ${fmt(yearAgo)}.`} />
          {rows.length ? (
            <Table aria-label="Headcount by location">
              <THead><TR><TH>Location</TH><TH className="text-right">People</TH><TH className="text-right">Year</TH></TR></THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id} className={cn(picked === r.id && 'bg-accent/10')} onClick={() => setPicked(r.id)}>
                    <TD>
                      <span className="font-medium">{r.name}</span>
                      <span className="block text-xs text-fg-subtle">{[r.city, r.countryCode].filter(Boolean).join(', ')}{r.latitude == null && ' · No map position'}</span>
                    </TD>
                    <TD className="text-right tabular-nums">{r.n}</TD>
                    <TD className={cn('text-right tabular-nums', r.n > r.was ? 'text-success' : r.n < r.was ? 'text-danger' : 'text-fg-subtle')}>{r.n === r.was ? '0' : `${r.n > r.was ? '+' : ''}${r.n - r.was}`}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : <EmptyState title="No locations yet" description="Add locations under Structure to see where people work." />}
          {rows.some((r) => r.latitude == null) && <p className="px-4 pb-4 text-xs text-fg-subtle">Locations without a map position are counted but not drawn. Add latitude and longitude to the location to place it.</p>}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Skills network
// ---------------------------------------------------------------------------------------------------------------

const RISK = { single: { label: '1 strong', tone: 'danger' }, thin: { label: '2 strong', tone: 'warning' }, ok: { label: 'Covered', tone: 'success' } } as const;

export function SkillsLens({ net }: { net: SkillsNetwork }) {
  const [dept, setDept] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const shown = useMemo<SkillsNetwork>(() => {
    if (!dept) return net;
    const people = net.people.filter((p) => p.departmentId === dept);
    const ids = new Set(people.map((p) => p.id));
    const links = net.links.filter((l) => ids.has(l.employeeId));
    const used = new Set(links.map((l) => l.skillId));
    return { ...net, people, links, skills: net.skills.filter((s) => used.has(s.id)) };
  }, [net, dept]);
  const layout = useMemo(() => skillsLayout(shown, 600), [shown]);
  const summary = useMemo(() => skillSummary(shown), [shown]);
  const colour = useMemo(() => new Map(net.departments.map((d, k) => [d.id, PALETTE[k % PALETTE.length]!])), [net.departments]);
  const person = useMemo(() => new Map(net.people.map((p) => [p.id, p])), [net.people]);
  const pos = useMemo(() => new Map(layout.people.map((p) => [p.id, p])), [layout.people]);
  const skillPos = useMemo(() => new Map(layout.skills.map((s) => [s.id, s])), [layout.skills]);
  const holders = picked ? shown.links.filter((l) => l.skillId === picked).sort((a, b) => b.level - a.level) : [];
  const maxPeople = Math.max(1, ...summary.map((s) => s.people));
  const withSkills = new Set(shown.links.map((l) => l.employeeId)).size;

  if (!net.skills.length) {
    return <Card><EmptyState title="No skills recorded yet" description="Add skills on an employee’s profile (Overview, Skills). People can add their own." /></Card>;
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Skills" value={summary.length} />
        <Stat label="People with skills recorded" value={`${withSkills} of ${shown.people.length}`} />
        <Stat label="Skills with one strong holder" value={summary.filter((s) => s.risk === 'single').length} hint="Level Strong or Expert" />
        <Stat label="Average skills per person" value={withSkills ? (shown.links.length / withSkills).toFixed(1) : '0'} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Department" className="w-60">{(f) => (
          <Select {...f} value={dept} onChange={(e) => { setDept(e.target.value); setPicked(null); }}>
            <option value="">All departments</option>
            {net.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        )}</Field>
      </div>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[1fr_24rem]">
        <Card className={cn('overflow-hidden p-2', SPACE)} aria-label="Skills network">
          <svg viewBox="0 0 600 600" className="mx-auto block h-[34rem] w-full max-w-[40rem]" role="img" aria-label={`Network of ${summary.length} skills and ${withSkills} people. Select a skill to see who holds it.`}>
            {shown.links.map((l, k) => {
              const p = pos.get(l.employeeId); const s = skillPos.get(l.skillId);
              if (!p || !s) return null;
              const hot = picked === l.skillId;
              return <line key={k} x1={p.x} y1={p.y} x2={s.x} y2={s.y} stroke={hot ? '#fbbf24' : '#a5b4fc'} strokeOpacity={picked ? (hot ? 0.9 : 0.06) : 0.08 + l.level * 0.06} strokeWidth={hot ? 1.5 : 1} />;
            })}
            {layout.people.map((p) => {
              const hot = !picked || holders.some((h) => h.employeeId === p.id);
              return <circle key={p.id} cx={p.x} cy={p.y} r={3 + p.skills * 0.6} fill={colour.get(person.get(p.id)?.departmentId ?? '') ?? '#94a3b8'} opacity={hot ? 0.95 : 0.2}><title>{person.get(p.id)?.name}</title></circle>;
            })}
            {layout.skills.map((s) => {
              const r = 7 + Math.sqrt(s.people / maxPeople) * 16;
              const hot = picked === s.id;
              const left = s.x < 300;
              return (
                <g key={s.id} onClick={() => setPicked(hot ? null : s.id)} className="cursor-pointer" data-skill={s.name}>
                  <circle cx={s.x} cy={s.y} r={r} fill={RISK[s.risk].tone === 'danger' ? '#f43f5e' : RISK[s.risk].tone === 'warning' ? '#f59e0b' : '#22d3ee'} fillOpacity={hot ? 0.95 : 0.7} stroke="#fff" strokeWidth={hot ? 2 : 0.6} />
                  <text x={s.x + (left ? -r - 4 : r + 4)} y={s.y + 4} textAnchor={left ? 'end' : 'start'} fill="#e2e8f0" fontSize={11} fontWeight={hot ? 600 : 400}>{s.name}</text>
                </g>
              );
            })}
          </svg>
          <p className="px-3 pb-2 text-xs text-slate-300">Skill circles are sized by how many people hold them; red means one strong holder, amber two. People sit near the skills they hold, coloured by department.</p>
        </Card>
        <div className="space-y-4">
          {picked && (
            <Card aria-label={`Who holds ${shown.skills.find((s) => s.id === picked)?.name}`}>
              <CardHeader title={shown.skills.find((s) => s.id === picked)?.name ?? ''} description={`${holders.length} ${holders.length === 1 ? 'person' : 'people'}`} action={<Button size="sm" variant="ghost" onClick={() => setPicked(null)}>Clear</Button>} />
              <ul className="divide-y divide-border">
                {holders.map((h) => (
                  <li key={h.employeeId} className="flex items-center justify-between px-4 py-2 text-[0.8125rem]">
                    <Link href={`/employees/${h.employeeId}`} className="text-accent hover:underline">{person.get(h.employeeId)?.name}</Link>
                    <Badge tone={h.level >= 3 ? 'success' : 'neutral'}>{SKILL_LEVEL_LABEL[h.level]}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <CardHeader title="Skills" description="Strong means level 3 (Strong) or 4 (Expert)." />
            <div className="overflow-x-auto"><Table aria-label="Skills summary">
              <THead><TR><TH>Skill</TH><TH className="text-right">People</TH><TH className="text-right">Strong</TH><TH>Cover</TH></TR></THead>
              <TBody>
                {summary.map((s) => (
                  <TR key={s.id} className={cn('cursor-pointer', picked === s.id && 'bg-accent/10')} onClick={() => setPicked(s.id)}>
                    <TD className="font-medium">{s.name}</TD>
                    <TD className="text-right tabular-nums">{s.people}</TD>
                    <TD className="text-right tabular-nums">{s.experts}</TD>
                    <TD><Badge tone={RISK[s.risk].tone}>{RISK[s.risk].label}</Badge></TD>
                  </TR>
                ))}
              </TBody>
            </Table></div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Recruitment flow
// ---------------------------------------------------------------------------------------------------------------

const PERIOD_LABEL = { quarter: 'This quarter', year: 'This year', all: 'All time' } as const;

export function FlowLens({ flow }: { flow: RecruitmentFlow }) {
  const rows = flowByStage(flow);
  const max = Math.max(1, ...rows.map((r) => r.reached));
  const W = 1000; const H = 300; const colW = W / Math.max(1, rows.length);
  const bar = (n: number) => Math.max(n ? 6 : 2, (n / max) * (H - 70));
  const hired = rows.find((r) => r.kind === 'hired')?.reached ?? 0;
  const href = (p: string) => `/insights/universe?lens=flow&period=${p}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 text-[0.8125rem]" role="tablist" aria-label="Period">
          {(['quarter', 'year', 'all'] as const).map((p) => <Link key={p} role="tab" aria-selected={flow.period === p} href={href(p)} className={buttonClass(flow.period === p ? 'secondary' : 'ghost', 'sm')}>{PERIOD_LABEL[p]}</Link>)}
        </div>
        <p className="text-xs text-fg-subtle">Applications made {flow.from ? `from ${fmt(flow.from)} ` : ''}to {fmt(flow.to)}, on the jobs you can see.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Applications" value={flow.applications} />
        <Stat label="Hired" value={hired} hint={flow.applications ? `${Math.round((hired / flow.applications) * 100)}% of applications` : undefined} />
        <Stat label="Turned down" value={rows.reduce((a, r) => a + r.rejected, 0)} />
        <Stat label="Withdrew" value={rows.reduce((a, r) => a + r.withdrawn, 0)} />
      </div>
      {!flow.applications ? <Card><EmptyState title="No applications in this period" description="Try a longer period." /></Card> : (
        <>
          <Card className={cn('overflow-x-auto p-4', SPACE)} aria-label="Recruitment flow">
            <svg viewBox={`0 0 ${W} ${H + 40}`} className="block h-auto min-w-[44rem] w-full" role="img" aria-label={`Flow from ${rows[0]?.name} to ${rows.at(-1)?.name}: ${rows.map((r) => `${r.name} ${r.reached}`).join(', ')}`}>
              {rows.map((r, k) => {
                const x = k * colW + colW * 0.3;
                const h = bar(r.reached);
                const y = 30 + (H - 70 - h) / 2;
                const next = rows[k + 1];
                const nh = next ? bar(next.reached) : 0;
                const ny = 30 + (H - 70 - nh) / 2;
                // A funnel: the band into the next stage is as wide as the number who reached it.
                const band = next ? Math.min(h, nh) : 0;
                const nx = (k + 1) * colW + colW * 0.3;
                return (
                  <g key={r.id} data-stage={r.name}>
                    {next && next.reached > 0 && (
                      <path d={`M${x + 18},${y} C${(x + nx) / 2},${y} ${(x + nx) / 2},${ny} ${nx},${ny} L${nx},${ny + nh} C${(x + nx) / 2},${ny + nh} ${(x + nx) / 2},${y + band} ${x + 18},${y + band} Z`} fill="#6366f1" fillOpacity={0.35} />
                    )}
                    {r.rejected + r.withdrawn > 0 && (
                      <path d={`M${x + 18},${y + h - ((r.rejected + r.withdrawn) / Math.max(1, r.reached)) * h} q30,0 40,30 l0,${H - 40 - y - h + 10} l-8,0 l0,-${H - 40 - y - h + 10} q-6,-20 -32,-22 Z`} fill="#f43f5e" fillOpacity={0.3} />
                    )}
                    <rect x={x} y={y} width={18} height={h} rx={4} fill="#22d3ee" />
                    <text x={x + 9} y={18} textAnchor="middle" fill="#e2e8f0" fontSize={13} fontWeight={600}>{r.name}</text>
                    <text x={x + 9} y={y + h + 16} textAnchor="middle" fill="#cbd5e1" fontSize={12}>{r.reached}</text>
                    {r.conversion != null && next && <text x={(x + nx) / 2 + 9} y={ny - 6} textAnchor="middle" fill="#a5b4fc" fontSize={11}>{r.conversion}% on</text>}
                    {r.rejected + r.withdrawn > 0 && <text x={x + 52} y={H + 10} fill="#fda4af" fontSize={11}>{r.rejected + r.withdrawn} out</text>}
                  </g>
                );
              })}
            </svg>
          </Card>
          <Card>
            <CardHeader title="By stage" description="Reached counts each application once per stage. Moved on means to a later stage or hired." />
            <div className="overflow-x-auto">
              <Table aria-label="Recruitment flow by stage">
                <THead><TR><TH>Stage</TH><TH className="text-right">Reached</TH><TH className="text-right">Moved on</TH><TH className="text-right">Turned down</TH><TH className="text-right">Withdrew</TH><TH className="text-right">In it now</TH><TH className="text-right">Conversion</TH></TR></THead>
                <TBody>
                  {rows.map((r) => (
                    <TR key={r.id}>
                      <TD className="font-medium">{r.name}</TD>
                      {[r.reached, r.onward, r.rejected, r.withdrawn, r.now].map((v, k) => <TD key={k} className="text-right tabular-nums">{v}</TD>)}
                      <TD className="text-right tabular-nums">{r.kind === 'hired' || r.conversion == null ? '—' : `${r.conversion}%`}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
            <p className="px-4 pb-4 text-xs text-fg-subtle">{FLOW_OUTCOMES.rejected} and {FLOW_OUTCOMES.withdrawn.toLowerCase()} are counted at the stage the application was in when it closed.</p>
          </Card>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------------------

type Draft = { id: string | null; name: string; notes: string; delta: Record<string, string>; cost: Record<string, string> };
const blank = (): Draft => ({ id: null, name: '', notes: '', delta: {}, cost: {} });
const fromScenario = (s: Scenario): Draft => ({
  id: s.id, name: s.name, notes: s.notes,
  delta: Object.fromEntries(s.changes.map((c) => [c.departmentId, String(c.delta)])),
  cost: Object.fromEntries(s.changes.filter((c) => c.monthlyCostPerHead != null).map((c) => [c.departmentId, String(c.monthlyCostPerHead)])),
});

export function ScenariosLens({ baseline, scenarios, canSave }: { baseline: ScenarioBaseline; scenarios: Scenario[]; canSave: boolean }) {
  const router = useRouter();
  const [d, setD] = useState<Draft>(() => (scenarios[0] ? fromScenario(scenarios[0]) : blank()));
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const money = (n: number | null) => (n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: baseline.currency ?? 'INR', maximumFractionDigits: 0 }).format(n));
  const changes: ScenarioInput['changes'] = baseline.departments
    .map((x) => ({ departmentId: x.id, delta: Number(d.delta[x.id] || 0), monthlyCostPerHead: d.cost[x.id] ? Number(d.cost[x.id]) : undefined }))
    .filter((c) => Number.isInteger(c.delta) && (c.delta !== 0 || c.monthlyCostPerHead != null));
  const result = applyScenario(baseline, changes);

  const save = (asNew: boolean) => start(async () => {
    const r = await saveScenarioAction(asNew ? null : d.id, { name: d.name, notes: d.notes, changes });
    setMsg({ tone: r.ok ? 'success' : 'danger', text: r.ok ? (r.message ?? 'Saved.') : [r.message, ...Object.values(r.fieldErrors ?? {})].filter(Boolean).join(' ') });
    if (r.ok && r.data) { setD(fromScenario(r.data)); router.refresh(); }
  });
  const remove = () => start(async () => {
    if (!d.id || !confirm(`Delete “${d.name}”?`)) return;
    const r = await deleteScenarioAction(d.id);
    setMsg({ tone: r.ok ? 'success' : 'danger', text: r.message ?? (r.ok ? 'Deleted.' : 'Could not delete') });
    if (r.ok) { setD(blank()); router.refresh(); }
  });

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[18rem_1fr]">
      <Card aria-label="Saved scenarios">
        <CardHeader title="Scenarios" action={<Button size="sm" variant="secondary" onClick={() => { setD(blank()); setMsg(null); }}><Plus className="size-3.5" /> New</Button>} />
        {scenarios.length ? (
          <ul className="divide-y divide-border">
            {scenarios.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => { setD(fromScenario(s)); setMsg(null); }} className={cn('w-full px-4 py-2.5 text-left text-[0.8125rem] hover:bg-bg-subtle', d.id === s.id && 'bg-accent/10')} aria-current={d.id === s.id || undefined}>
                  <span className="block font-medium">{s.name}</span>
                  <span className="text-xs text-fg-subtle">{s.createdBy ? `${s.createdBy} · ` : ''}{fmt(s.updatedAt.slice(0, 10))}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="px-4 pb-4 text-[0.8125rem] text-fg-subtle">None saved yet.</p>}
      </Card>
      <div className="space-y-4">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={`Headcount today (${fmt(baseline.asOf)})`} value={result.before} />
          <Stat label="Headcount in this scenario" value={result.after} hint={`${result.after - result.before >= 0 ? '+' : ''}${result.after - result.before}`} />
          <Stat label="Monthly cost today" value={money(result.costBefore)} hint={baseline.costs ? 'Current salaries ÷ 12' : 'Needs payroll access to everyone'} />
          <Stat label="Monthly cost in this scenario" value={money(result.costAfter)} hint={result.costAfter != null && result.costBefore != null ? `${result.costAfter >= result.costBefore ? '+' : ''}${money(result.costAfter - result.costBefore)}` : undefined} />
        </div>
        <Card>
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <Field label="Scenario name" required>{(f) => <Input {...f} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} maxLength={80} placeholder="e.g. Second shift on line 2" disabled={!canSave} />}</Field>
            <Field label="Notes">{(f) => <Textarea {...f} rows={1} value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} maxLength={2000} disabled={!canSave} />}</Field>
          </div>
          <div className="overflow-x-auto">
            <Table aria-label="Scenario by department">
              <THead><TR><TH>Department</TH><TH className="text-right">Today</TH><TH>Change</TH>{baseline.costs && <TH>Cost per added person / month</TH>}<TH className="text-right">After</TH>{baseline.costs && <TH className="text-right">Monthly cost after</TH>}</TR></THead>
              <TBody>
                {result.rows.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-medium">{r.name}</TD>
                    <TD className="text-right tabular-nums">{r.before}</TD>
                    <TD>
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" aria-label={`One fewer in ${r.name}`} disabled={!canSave} onClick={() => setD({ ...d, delta: { ...d.delta, [r.id]: String(Number(d.delta[r.id] || 0) - 1) } })}><Minus className="size-3.5" /></Button>
                        <Input aria-label={`Change in ${r.name}`} className="!w-20 text-right" inputMode="numeric" value={d.delta[r.id] ?? ''} placeholder="0" disabled={!canSave} onChange={(e) => setD({ ...d, delta: { ...d.delta, [r.id]: e.target.value.replace(/[^\d-]/g, '') } })} />
                        <Button size="sm" variant="ghost" aria-label={`One more in ${r.name}`} disabled={!canSave} onClick={() => setD({ ...d, delta: { ...d.delta, [r.id]: String(Number(d.delta[r.id] || 0) + 1) } })}><Plus className="size-3.5" /></Button>
                      </div>
                    </TD>
                    {baseline.costs && (
                      <TD>
                        <Input aria-label={`Cost per added person in ${r.name}`} className="!w-32 text-right" inputMode="numeric" value={d.cost[r.id] ?? ''} disabled={!canSave}
                          placeholder={r.before && r.costBefore != null ? String(Math.round(r.costBefore / r.before)) : 'Enter'} onChange={(e) => setD({ ...d, cost: { ...d.cost, [r.id]: e.target.value.replace(/[^\d]/g, '') } })} />
                        {r.missingCost && <span className="mt-1 block text-xs text-warning">No one here yet: enter a cost</span>}
                      </TD>
                    )}
                    <TD className={cn('text-right tabular-nums', r.delta > 0 ? 'text-success' : r.delta < 0 ? 'text-danger' : '')}>{r.after}</TD>
                    {baseline.costs && <TD className="text-right tabular-nums">{money(r.costAfter)}</TD>}
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-border p-4">
            {canSave ? (
              <Fragment>
                <Button onClick={() => save(false)} loading={pending} disabled={!changes.length}><Save className="size-4" /> {d.id ? 'Save changes' : 'Save scenario'}</Button>
                {d.id && <Button variant="secondary" onClick={() => save(true)} disabled={pending || !changes.length}>Save as new</Button>}
                {d.id && <Button variant="ghost" onClick={remove} disabled={pending}><Trash2 className="size-4" /> Delete</Button>}
              </Fragment>
            ) : <p className="text-[0.8125rem] text-fg-subtle">You can try changes here; saving scenarios is for managers, HR and finance.</p>}
            <p className="ml-auto text-xs text-fg-subtle">A plan only: nothing here changes headcount, requisitions or pay.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
