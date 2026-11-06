'use client';
import { DEFAULT_APPEARANCE, THEME_PRESETS, buildTheme, contrast, type Appearance, type AppearancePatch, type ThemePreset } from '@crew/contracts';
import { Badge, Button, Card, CardBody, CardHeader, cn } from '@crew/ui';
import { Check, Monitor, Moon, RotateCcw, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useExperience } from '../../shell';

type Option<T extends string> = { value: T; label: string; hint?: string };

function Segmented<T extends string>({ label, value, options, onChange, describe }: { label: string; value: T; options: Option<T>[]; onChange: (v: T) => void; describe?: string }) {
  return (
    <div>
      <div className="mb-1.5 text-[0.8125rem] font-medium">{label}</div>
      <div className="inline-flex flex-wrap gap-1 rounded-lg bg-bg-subtle p-1" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.hint} onClick={() => onChange(o.value)}
            className={cn('rounded-md px-3 py-1.5 text-[0.8125rem] font-medium transition-colors', value === o.value ? 'bg-surface text-fg shadow-card' : 'text-fg-muted hover:text-fg')}>
            {o.label}
          </button>
        ))}
      </div>
      {describe && <p className="mt-1 text-xs text-fg-subtle">{describe}</p>}
    </div>
  );
}

function Toggle({ label, checked, onChange, describe }: { label: string; checked: boolean; onChange: (v: boolean) => void; describe?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-[0.8125rem] font-medium">{label}</span>
        {describe && <span className="block text-xs text-fg-subtle">{describe}</span>}
      </span>
      <input type="checkbox" role="switch" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span aria-hidden className={cn('mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--ring)]', checked ? 'bg-accent' : 'bg-border-strong')}>
        <span className={cn('block size-4 rounded-full bg-white shadow transition-transform', checked && 'translate-x-4')} />
      </span>
    </label>
  );
}

/** A small rendering of the app in a preset's own colours, so every card previews itself regardless of the current theme. */
function PresetCard({ p, mode, selected, onPick }: { p: ThemePreset; mode: 'light' | 'dark'; selected: boolean; onPick: () => void }) {
  const t = buildTheme({ ...DEFAULT_APPEARANCE, preset: p.key }, mode);
  return (
    <button type="button" role="radio" aria-checked={selected} aria-label={p.name} onClick={onPick}
      className={cn('group overflow-hidden rounded-xl border text-left transition-shadow', selected ? 'border-accent ring-2 ring-accent' : 'border-border hover:shadow-pop')}>
      <div className="relative h-24 p-2.5" style={{ background: `radial-gradient(120% 90% at 0% 0%, ${t['glow-1']}33, transparent 60%), radial-gradient(90% 80% at 100% 0%, ${t['glow-2']}2b, transparent 60%), ${t.bg}` }}>
        <div className="flex h-full gap-2">
          <div className="flex w-8 flex-col gap-1.5 rounded-md p-1.5" style={{ background: t.surface, border: `1px solid ${t.border}` }}>
            <span className="h-1.5 rounded" style={{ background: t.accent }} />
            <span className="h-1.5 rounded" style={{ background: t.border }} />
            <span className="h-1.5 rounded" style={{ background: t.border }} />
          </div>
          <div className="flex flex-1 flex-col gap-1.5 rounded-md p-2" style={{ background: t.surface, border: `1px solid ${t.border}` }}>
            <span className="h-2 w-2/3 rounded" style={{ background: t.fg, opacity: 0.85 }} />
            <span className="h-1.5 w-1/2 rounded" style={{ background: t['fg-subtle'] }} />
            <div className="mt-auto flex items-end gap-1">
              {[60, 85, 45, 70].map((h, i) => <span key={i} className="w-2 rounded-sm" style={{ height: `${h * 0.28}px`, background: t[`chart-${i + 1}` as 'chart-1'] }} />)}
              <span className="ml-auto rounded px-1.5 py-0.5 text-[0.5625rem] font-semibold" style={{ background: t.accent, color: t['accent-fg'] }}>Save</span>
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-border bg-surface px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.8125rem] font-medium">{p.name}</span>
          <span className="block truncate text-[0.6875rem] text-fg-subtle">{p.description}</span>
        </span>
        {selected && <Check className="size-4 shrink-0 text-accent" aria-hidden />}
      </div>
    </button>
  );
}

function ColourField({ label, value, fallback, onChange }: { label: string; value: string | null; fallback: string; onChange: (v: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? fallback);
  useEffect(() => setDraft(value ?? fallback), [value, fallback]);
  return (
    <div className="flex items-center gap-3">
      <input type="color" aria-label={`${label} colour`} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== (value ?? fallback) && onChange(draft)} className="size-9 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5" />
      <div className="min-w-0 flex-1">
        <div className="text-[0.8125rem] font-medium">{label}</div>
        <div className="font-mono text-xs text-fg-subtle">{value ? value : `${fallback} (from theme)`}</div>
      </div>
      {draft !== (value ?? fallback) && <Button size="sm" onClick={() => onChange(draft)}>Apply</Button>}
      {value && <Button size="sm" variant="secondary" onClick={() => onChange(null)}>Use theme colour</Button>}
    </div>
  );
}

export function ThemeStudio() {
  const { appearance: a, update, reset, saving } = useExperience();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    const m = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(m.matches);
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  const mode = a.mode === 'system' ? (systemDark ? 'dark' : 'light') : a.mode;
  const seed = THEME_PRESETS.find((p) => p.key === a.preset)![mode];
  const live = buildTheme(a, mode);

  const set = async (patch: AppearancePatch) => {
    const r = await update(patch);
    setMessage(r.ok ? { ok: true, text: 'Saved' } : { ok: false, text: r.message ?? 'Could not save' });
  };
  const adjusted = a.primary && live.accent.toLowerCase() !== a.primary.toLowerCase();

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="Theme" description="Thirteen presets, each with a light and a dark palette checked for readable contrast." action={
            <div className="inline-flex gap-1 rounded-lg bg-bg-subtle p-1" role="radiogroup" aria-label="Colour mode">
              {([['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'System', Monitor]] as const).map(([m, label, Icon]) => (
                <button key={m} type="button" role="radio" aria-checked={a.mode === m} onClick={() => void set({ mode: m })} className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium', a.mode === m ? 'bg-surface text-fg shadow-card' : 'text-fg-muted hover:text-fg')}>
                  <Icon className="size-3.5" /> {label}
                </button>
              ))}
            </div>
          } />
          <CardBody className="pt-1">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" role="radiogroup" aria-label="Theme preset">
              {THEME_PRESETS.map((p) => <PresetCard key={p.key} p={p} mode={mode} selected={a.preset === p.key} onPick={() => void set({ preset: p.key })} />)}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Style and background" description="Neon is the glass and gradient design; Classic is the flat original look." />
          <CardBody className="grid gap-5 pt-1 md:grid-cols-2">
            <Segmented label="Visual style" value={a.style} onChange={(v) => void set({ style: v })} options={[{ value: 'neon', label: 'Neon' }, { value: 'classic', label: 'Classic' }]} />
            <Segmented label="Background" value={a.backdrop} onChange={(v) => void set({ backdrop: v })} options={[{ value: 'aurora', label: 'Aurora' }, { value: 'cosmos', label: 'Cosmos' }, { value: 'gradient', label: 'Gradient' }, { value: 'plain', label: 'Plain' }]} describe="Shown in the Neon style. High contrast and focus mode always use a plain background." />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Your colours" description="Override the theme's colours. SampCrew adjusts them where needed so text stays readable." />
          <CardBody className="flex flex-col gap-4 pt-1">
            <ColourField label="Primary" value={a.primary} fallback={seed.primary} onChange={(v) => void set({ primary: v })} />
            <ColourField label="Secondary" value={a.secondary} fallback={seed.secondary} onChange={(v) => void set({ secondary: v })} />
            <ColourField label="Accent" value={a.accent} fallback={seed.tertiary} onChange={(v) => void set({ accent: v })} />
            {adjusted && <p className="text-xs text-fg-muted">Your primary colour is shown as <span className="font-mono">{live.accent}</span> in {mode} mode so buttons and links meet WCAG AA contrast ({contrast(live.accent, live.surface).toFixed(1)}:1).</p>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Comfort and accessibility" description="For long working days." />
          <CardBody className="grid gap-5 pt-1 md:grid-cols-2">
            <Segmented label="Density" value={a.density} onChange={(v) => void set({ density: v })} options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'spacious', label: 'Spacious' }]} describe="Spacing across every screen." />
            <Segmented label="Text size" value={a.fontSize} onChange={(v) => void set({ fontSize: v })} options={[{ value: 'small', label: 'Small' }, { value: 'default', label: 'Default' }, { value: 'large', label: 'Large' }]} />
            <Segmented label="Contrast" value={a.contrast} onChange={(v) => void set({ contrast: v })} options={[{ value: 'standard', label: 'Standard' }, { value: 'high', label: 'High' }]} describe="High contrast uses stronger text, borders and focus rings." />
            <Segmented label="Corners" value={a.radius} onChange={(v) => void set({ radius: v })} options={[{ value: 'sharp', label: 'Sharp' }, { value: 'default', label: 'Default' }, { value: 'round', label: 'Round' }]} />
            <Segmented label="Tables" value={a.tableDensity} onChange={(v) => void set({ tableDensity: v })} options={[{ value: 'compact', label: 'Compact rows' }, { value: 'comfortable', label: 'Comfortable rows' }]} />
            <Segmented label="Chart colours" value={a.chartPalette} onChange={(v) => void set({ chartPalette: v })} options={[{ value: 'theme', label: 'Theme' }, { value: 'colorblind', label: 'Colour-blind safe' }, { value: 'monochrome', label: 'Single colour' }]} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Motion and focus" />
          <CardBody className="grid gap-5 pt-1 md:grid-cols-2">
            <Segmented label="Motion" value={a.motion} onChange={(v) => void set({ motion: v })} options={[{ value: 'cinematic', label: 'Cinematic', hint: 'Adds slow ambient light' }, { value: 'balanced', label: 'Balanced', hint: 'Short transitions (default)' }, { value: 'focus', label: 'Focus', hint: 'No animation' }]} describe="Your device's reduce-motion setting is always respected." />
            <Toggle label="Focus mode" checked={a.focusMode} onChange={(v) => void set({ focusMode: v })} describe="Removes ambient light, glass and animation so only the task is in view. Shortcut: Ctrl + ." />
            <Segmented label="Sidebar" value={a.sidebar} onChange={(v) => void set({ sidebar: v })} options={[{ value: 'expanded', label: 'Expanded' }, { value: 'collapsed', label: 'Icons only' }]} describe="Shortcut: Ctrl + B" />
            <Segmented label="Sidebar style" value={a.sidebarStyle} onChange={(v) => void set({ sidebarStyle: v })} options={[{ value: 'glass', label: 'Glass' }, { value: 'solid', label: 'Solid' }]} />
          </CardBody>
        </Card>
      </div>

      <div className="flex flex-col gap-4 xl:sticky xl:top-20 xl:self-start">
        <Card className="crew-edge">
          <CardHeader title="Preview" description="This panel uses your current settings." action={saving ? <Badge tone="info">Saving…</Badge> : message && <Badge tone={message.ok ? 'success' : 'danger'}>{message.text}</Badge>} />
          <CardBody className="flex flex-col gap-3 pt-1">
            <div className="flex gap-2"><Button size="sm">Primary</Button><Button size="sm" variant="secondary">Secondary</Button></div>
            <div className="flex flex-wrap gap-1.5"><Badge tone="success">Approved</Badge><Badge tone="warning">Pending</Badge><Badge tone="danger">Rejected</Badge><Badge tone="info">New</Badge></div>
            <div className="rounded-lg border border-border">
              {[['Asha Rao', 'Operations', 'Present'], ['Vikram Shah', 'Finance', 'On leave']].map(([n, d, s]) => (
                <div key={n} className="flex items-center justify-between border-b border-border px-3 py-2 text-[0.8125rem] last:border-0"><span><span className="font-medium">{n}</span> <span className="text-fg-subtle">· {d}</span></span><span className="text-fg-muted">{s}</span></div>
              ))}
            </div>
            <div className="flex h-14 items-end gap-1.5" aria-hidden>{[40, 75, 55, 90, 65].map((h, i) => <span key={i} className="flex-1 rounded-t" style={{ height: `${h}%`, background: `var(--chart-${i + 1})` }} />)}</div>
            <p className="text-xs text-fg-subtle">Sample rows for the preview only.</p>
          </CardBody>
        </Card>
        <Button variant="secondary" onClick={() => void reset().then((r) => setMessage(r.ok ? { ok: true, text: 'Reset' } : { ok: false, text: r.message ?? 'Could not reset' }))}><RotateCcw className="size-4" /> Reset to default</Button>
        <p className="text-xs text-fg-subtle">Default: Midnight Intelligence, Neon style with the Aurora background, system mode, comfortable density, balanced motion.</p>
      </div>
    </div>
  );
}
