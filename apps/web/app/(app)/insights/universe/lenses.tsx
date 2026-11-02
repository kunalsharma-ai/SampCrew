'use client';
import {
  applyScenario, DEFAULT_ASSUMPTIONS, flowByStage, projectScenario, type ScenarioAssumptions, type ScenarioChange, FLOW_OUTCOMES, globeCentre, orthographic, type RecruitmentFlow, type Scenario, type ScenarioBaseline,
  SKILL_LEVEL_LABEL, skillsLayout, skillSummary, type SkillsNetwork, snapshot, timeline, type UniverseData,
} from '@crew/contracts';
import { Alert, Badge, Button, buttonClass, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, TBody, TD, TH, THead, TR, Textarea, cn } from '@crew/ui';
import { BriefcaseBusiness, Globe2, Minus, Plus, RotateCcw, RotateCw, Save, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { geoGraticule10, geoOrthographic, geoPath, type GeoPermissibleObjects } from 'd3-geo';
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { deleteScenarioAction, raiseScenarioRequisitionsAction, saveScenarioAction } from './lens-actions';

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

  // Land outlines (Natural Earth 1:110m, from world-atlas) load only when this lens opens.
  const [land, setLand] = useState<GeoPermissibleObjects | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([import('topojson-client'), import('world-atlas/land-110m.json')])
      .then(([topo, world]) => {
        const t = (world as { default?: unknown }).default ?? world;
        if (live) setLand(topo.feature(t as never, (t as { objects: { land: never } }).objects.land) as unknown as GeoPermissibleObjects);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  const projection = useMemo(() => geoOrthographic().rotate([-view.lng, -view.lat]).scale(R).translate([R, R]).clipAngle(90), [view]);
  const path = useMemo(() => geoPath(projection), [projection]);
  const graticule = useMemo(() => path(geoGraticule10()) ?? '', [path]);
  const landPath = useMemo(() => (land ? path(land) ?? '' : ''), [land, path]);

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
            <path d={graticule} fill="none" stroke="#a5b4fc" strokeOpacity={0.15} strokeWidth={0.6} />
            {landPath && <path d={landPath} fill="#4f46e5" fillOpacity={0.45} stroke="#a5b4fc" strokeOpacity={0.6} strokeWidth={0.6} data-land="" />}
            {mapped.map((l) => {
              const p = orthographic(l.latitude!, l.longitude!, view.lat, view.lng);
              if (!p.visible) return null;
              const r = l.n ? 4 + Math.sqrt(l.n / max) * 16 : 3;
              const [x, y] = projection([l.longitude!, l.latitude!]) ?? [R + p.x * R, R + p.y * R];
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
          <p className="absolute bottom-3 left-4 text-[0.6875rem] text-slate-400">Map data: Natural Earth</p>
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
                // The band carries the applications that moved on from this stage (to the next or a later one).
                const band = next && r.onward ? Math.min(h, bar(r.onward)) : 0;
                const bandIn = Math.min(nh, band);
                const nx = (k + 1) * colW + colW * 0.3;
                return (
                  <g key={r.id} data-stage={r.name}>
                    {next && band > 0 && (
                      <path d={`M${x + 18},${y} C${(x + nx) / 2},${y} ${(x + nx) / 2},${ny} ${nx},${ny} L${nx},${ny + bandIn} C${(x + nx) / 2},${ny + bandIn} ${(x + nx) / 2},${y + band} ${x + 18},${y + band} Z`} fill="#6366f1" fillOpacity={0.35} />
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

type Draft = {
  id: string | null; name: string; notes: string;
  delta: Record<string, string>; cost: Record<string, string>; month: Record<string, string>; role: Record<string, string>;
  a: { startMonth: string; horizonMonths: string; attritionPctYear: string; payRisePct: string; payRiseMonth: string };
  requisitions: Scenario['requisitions'];
};
const draftAssumptions = (a: ScenarioAssumptions): Draft['a'] => ({
  startMonth: a.startMonth ?? '', horizonMonths: String(a.horizonMonths), attritionPctYear: a.attritionPctYear ? String(a.attritionPctYear) : '',
  payRisePct: a.payRisePct ? String(a.payRisePct) : '', payRiseMonth: a.payRiseMonth ?? '',
});
const blank = (): Draft => ({ id: null, name: '', notes: '', delta: {}, cost: {}, month: {}, role: {}, a: draftAssumptions(DEFAULT_ASSUMPTIONS), requisitions: [] });
const fromScenario = (s: Scenario): Draft => ({
  id: s.id, name: s.name, notes: s.notes,
  delta: Object.fromEntries(s.changes.map((c) => [c.departmentId, String(c.delta)])),
  cost: Object.fromEntries(s.changes.filter((c) => c.monthlyCostPerHead != null).map((c) => [c.departmentId, String(c.monthlyCostPerHead)])),
  month: Object.fromEntries(s.changes.filter((c) => c.startMonth).map((c) => [c.departmentId, c.startMonth!])),
  role: Object.fromEntries(s.changes.filter((c) => c.role).map((c) => [c.departmentId, c.role!])),
  a: draftAssumptions(s.assumptions), requisitions: s.requisitions,
});
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });

export function ScenariosLens({ baseline, scenarios, canSave, canRaise }: { baseline: ScenarioBaseline; scenarios: Scenario[]; canSave: boolean; canRaise: boolean }) {
  const router = useRouter();
  const [d, setD] = useState<Draft>(() => (scenarios[0] ? fromScenario(scenarios[0]) : blank()));
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const money = (n: number | null) => (n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: baseline.currency ?? 'INR', maximumFractionDigits: 0 }).format(n));
  const changes: ScenarioChange[] = baseline.departments
    .map((x) => ({
      departmentId: x.id, delta: Number(d.delta[x.id] || 0), monthlyCostPerHead: d.cost[x.id] ? Number(d.cost[x.id]) : undefined,
      startMonth: d.month[x.id] || undefined, role: d.role[x.id]?.trim() || undefined,
    }))
    .filter((c) => Number.isInteger(c.delta) && (c.delta !== 0 || c.monthlyCostPerHead != null));
  const assumptions: ScenarioAssumptions = {
    startMonth: d.a.startMonth || null, horizonMonths: Math.min(36, Math.max(3, Number(d.a.horizonMonths) || 12)),
    attritionPctYear: Math.min(60, Number(d.a.attritionPctYear) || 0), payRisePct: Math.min(30, Number(d.a.payRisePct) || 0), payRiseMonth: d.a.payRiseMonth || null,
  };
  const result = applyScenario(baseline, changes);
  const projection = projectScenario(baseline, changes, assumptions);
  const setA = (k: keyof Draft['a'], v: string) => setD({ ...d, a: { ...d.a, [k]: v } });
  const raisedFor = new Set(d.requisitions.map((r) => r.departmentId));
  const saved = scenarios.find((s) => s.id === d.id);
  const toRaise = (saved?.changes ?? []).filter((c) => c.delta > 0 && !raisedFor.has(c.departmentId));

  const save = (asNew: boolean) => start(async () => {
    const r = await saveScenarioAction(asNew ? null : d.id, { name: d.name, notes: d.notes, changes, assumptions });
    setMsg({ tone: r.ok ? 'success' : 'danger', text: r.ok ? (r.message ?? 'Saved.') : [r.message, ...Object.values(r.fieldErrors ?? {})].filter(Boolean).join(' ') });
    if (r.ok && r.data) { setD(fromScenario(r.data)); router.refresh(); }
  });
  const remove = () => start(async () => {
    if (!d.id || !confirm(`Delete “${d.name}”?`)) return;
    const r = await deleteScenarioAction(d.id);
    setMsg({ tone: r.ok ? 'success' : 'danger', text: r.message ?? (r.ok ? 'Deleted.' : 'Could not delete') });
    if (r.ok) { setD(blank()); router.refresh(); }
  });
  const raise = () => start(async () => {
    if (!d.id) return;
    const r = await raiseScenarioRequisitionsAction(d.id);
    setMsg({ tone: r.ok ? 'success' : 'danger', text: r.ok ? `${r.data ? r.data.requisitions.length - d.requisitions.length : 0} draft requisition(s) raised. Submit them for approval from Recruitment.` : [r.message, ...Object.values(r.fieldErrors ?? {})].filter(Boolean).join(' ') });
    if (r.ok && r.data) { setD(fromScenario(r.data)); router.refresh(); }
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
              <THead><TR><TH>Department</TH><TH className="text-right">Today</TH><TH>Change</TH><TH>From</TH><TH>Role added</TH>{baseline.costs && <TH>Cost per added person / month</TH>}<TH className="text-right">After</TH>{baseline.costs && <TH className="text-right">Monthly cost after</TH>}</TR></THead>
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
                    <TD>
                      <Input aria-label={`Month of the change in ${r.name}`} type="month" className="!w-36" value={d.month[r.id] ?? ''} disabled={!canSave} onChange={(e) => setD({ ...d, month: { ...d.month, [r.id]: e.target.value } })} />
                      {projection.outside.includes(r.id) && <span className="mt-1 block text-xs text-warning">After the projection ends</span>}
                    </TD>
                    <TD>
                      <Input aria-label={`Role added in ${r.name}`} className="!w-40" value={d.role[r.id] ?? ''} maxLength={120} placeholder={Number(d.delta[r.id] || 0) > 0 ? `New role in ${r.name}` : ''} disabled={!canSave || !(Number(d.delta[r.id] || 0) > 0)} onChange={(e) => setD({ ...d, role: { ...d.role, [r.id]: e.target.value } })} />
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
            <p className="ml-auto text-xs text-fg-subtle">A plan only: nothing here changes headcount or pay. Requisitions are raised only when you ask.</p>
          </div>
        </Card>
        <Card aria-label="Assumptions">
          <CardHeader title="Over time" description="When the plan starts, how far ahead to look, and what happens to the people you have." />
          <div className="grid gap-3 p-4 pt-0 sm:grid-cols-3 lg:grid-cols-5">
            <Field label="First month" hint="Empty: this month">{(f) => <Input {...f} type="month" value={d.a.startMonth} disabled={!canSave} onChange={(e) => setA('startMonth', e.target.value)} />}</Field>
            <Field label="Months ahead">{(f) => <Select {...f} value={d.a.horizonMonths} disabled={!canSave} onChange={(e) => setA('horizonMonths', e.target.value)}>{[6, 12, 18, 24, 36].map((n) => <option key={n} value={n}>{n} months</option>)}</Select>}</Field>
            <Field label="Attrition per year (%)" hint="Leavers are not replaced">{(f) => <Input {...f} inputMode="decimal" value={d.a.attritionPctYear} placeholder="0" disabled={!canSave} onChange={(e) => setA('attritionPctYear', e.target.value.replace(/[^\d.]/g, ''))} />}</Field>
            <Field label="Pay rise (%)">{(f) => <Input {...f} inputMode="decimal" value={d.a.payRisePct} placeholder="0" disabled={!canSave} onChange={(e) => setA('payRisePct', e.target.value.replace(/[^\d.]/g, ''))} />}</Field>
            <Field label="Pay rise from" hint="Empty: the first month">{(f) => <Input {...f} type="month" value={d.a.payRiseMonth} disabled={!canSave} onChange={(e) => setA('payRiseMonth', e.target.value)} />}</Field>
          </div>
          <ProjectionChart p={projection} money={money} />
          <div className="grid grid-cols-2 gap-3 border-t border-border p-4 lg:grid-cols-4">
            <Stat label={`Expected headcount, ${monthLabel(projection.end)}`} value={projection.points.at(-1)!.expected} hint={`Planned ${projection.points.at(-1)!.planned}`} />
            <Stat label="Leavers to replace to hold the plan" value={projection.leavers} />
            <Stat label={`Cost over ${assumptions.horizonMonths} months`} value={money(projection.totalCost)} hint={baseline.costs ? 'Expected headcount, with the pay rise' : 'Needs payroll access to everyone'} />
            <Stat label="Against no changes" value={projection.difference == null ? '—' : `${projection.difference >= 0 ? '+' : ''}${money(projection.difference)}`} />
          </div>
        </Card>
        {d.id && (
          <Card aria-label="Requisitions from this scenario">
            <CardHeader
              title="Requisitions from this scenario"
              description="One draft per department the scenario adds people to, with the role, the number of people and the month. Drafts go through the usual approval."
              action={canRaise && canSave ? <Button size="sm" onClick={raise} loading={pending} disabled={!toRaise.length}><BriefcaseBusiness className="size-3.5" /> Raise draft requisitions{toRaise.length ? ` (${toRaise.length})` : ''}</Button> : undefined}
            />
            {d.requisitions.length ? (
              <ul className="divide-y divide-border">
                {d.requisitions.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-[0.8125rem]">
                    <Link href={`/recruitment/jobs/${r.id}`} className="font-medium text-accent hover:underline">{r.code} · {r.title}</Link>
                    <span className="text-fg-subtle">{baseline.departments.find((x) => x.id === r.departmentId)?.name} · {r.headcount} {r.headcount === 1 ? 'person' : 'people'}</span>
                    <Badge className="ml-auto">{r.status.replace('_', ' ')}</Badge>
                  </li>
                ))}
              </ul>
            ) : <p className="px-4 pb-4 text-[0.8125rem] text-fg-subtle">{canRaise ? (toRaise.length ? 'None raised yet. Save your changes first: drafts use the saved scenario.' : 'This scenario adds nobody, so there is nothing to raise.') : 'Raising requisitions needs recruitment access.'}</p>}
          </Card>
        )}
      </div>
    </div>
  );
}

/** Expected headcount month by month against the plan and against no changes, with the monthly cost under it. */
function ProjectionChart({ p, money }: { p: ReturnType<typeof projectScenario>; money: (n: number | null) => string }) {
  const W = 720; const H = 220; const L = 44; const R = 12; const T = 12; const B = 28;
  const all = p.points.flatMap((x) => [x.planned, x.expected, x.baseline]);
  const max = Math.max(1, ...all) * 1.1; const min = Math.max(0, Math.min(...all) * 0.85);
  const x = (i: number) => L + (i / Math.max(1, p.points.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - min) / (max - min || 1)) * (H - T - B);
  const line = (k: 'planned' | 'expected' | 'baseline') => p.points.map((pt, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pt[k]).toFixed(1)}`).join(' ');
  const ticks = [min, (min + max) / 2, max].map((v) => Math.round(v));
  const every = Math.ceil(p.points.length / 8);
  return (
    <figure className="px-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Projected headcount from ${monthLabel(p.start)} to ${monthLabel(p.end)}: ${p.points.at(-1)!.expected} expected against ${p.points.at(-1)!.baseline} with no changes`}>
        {ticks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-border" strokeDasharray="3 3" /><text x={L - 6} y={y(v) + 4} textAnchor="end" className="fill-fg-subtle text-[10px]">{v}</text></g>)}
        {p.points.map((pt, i) => (i % every === 0 || i === p.points.length - 1) && <text key={pt.month} x={x(i)} y={H - 8} textAnchor="middle" className="fill-fg-subtle text-[10px]">{monthLabel(pt.month)}</text>)}
        <path d={line('baseline')} fill="none" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="5 4" data-line="baseline" />
        <path d={line('planned')} fill="none" stroke="#a5b4fc" strokeWidth={1.5} data-line="planned" />
        <path d={line('expected')} fill="none" stroke="#4f46e5" strokeWidth={2.5} data-line="expected" />
        {p.points.map((pt, i) => <circle key={pt.month} cx={x(i)} cy={y(pt.expected)} r={2.5} fill="#4f46e5"><title>{`${monthLabel(pt.month)}: ${pt.expected} expected, ${pt.planned} planned, ${pt.baseline} with no changes${pt.cost != null ? `, ${money(pt.cost)} a month` : ''}`}</title></circle>)}
      </svg>
      <figcaption className="flex flex-wrap gap-4 pb-3 text-xs text-fg-subtle">
        <span><span className="mr-1 inline-block h-0.5 w-4 bg-[#4f46e5] align-middle" />Expected (after leavers)</span>
        <span><span className="mr-1 inline-block h-0.5 w-4 bg-[#a5b4fc] align-middle" />Planned</span>
        <span><span className="mr-1 inline-block h-0.5 w-4 border-t border-dashed border-[#94a3b8] align-middle" />No changes</span>
      </figcaption>
      <details className="pb-3 text-[0.8125rem]">
        <summary className="cursor-pointer text-fg-muted">Month by month</summary>
        <div className="overflow-x-auto">
          <Table aria-label="Projection by month">
            <THead><TR><TH>Month</TH><TH className="text-right">Planned</TH><TH className="text-right">Expected</TH><TH className="text-right">No changes</TH><TH className="text-right">Monthly cost</TH></TR></THead>
            <TBody>{p.points.map((pt) => <TR key={pt.month}><TD>{monthLabel(pt.month)}</TD><TD className="text-right tabular-nums">{pt.planned}</TD><TD className="text-right tabular-nums">{pt.expected}</TD><TD className="text-right tabular-nums">{pt.baseline}</TD><TD className="text-right tabular-nums">{money(pt.cost)}</TD></TR>)}</TBody>
          </Table>
        </div>
      </details>
    </figure>
  );
}
