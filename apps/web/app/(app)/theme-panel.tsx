'use client';
import {
  DEFAULT_APPEARANCE, PALETTE_SWATCHES, THEME_PRESETS, THEME_TEMPLATES, buildTheme,
  type Appearance, type AppearancePatch, type ThemePresetKey,
} from '@crew/contracts';
import { Button, cn } from '@crew/ui';
import { Check, LayoutTemplate, Monitor, Moon, Palette, PanelLeft, Sun, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { applyAppearance } from '@/lib/appearance-client';

/**
 * Themes & Templates: a side panel to try a look on the live app before keeping it. Every pick previews at once;
 * Apply saves the changes to the member's preferences (the same record the Theme Studio and the mobile app use);
 * closing without applying puts the saved look back.
 */

type Tab = 'themes' | 'templates' | 'layouts';
type Update = (patch: AppearancePatch) => Promise<{ ok: boolean; message?: string }>;

const BACKDROPS: { key: Appearance['backdrop']; label: string }[] = [
  { key: 'aurora', label: 'Aurora' }, { key: 'cosmos', label: 'Cosmos' }, { key: 'gradient', label: 'Gradient' }, { key: 'plain', label: 'Plain' },
];

/** A small picture of a look, drawn from the palette it would produce, so it is accurate for every preset. */
function Thumb({ a, mode, className }: { a: Appearance; mode: 'light' | 'dark'; className?: string }) {
  const t = buildTheme(a, mode);
  const neon = a.style === 'neon';
  const sky =
    a.backdrop === 'cosmos' ? `radial-gradient(circle at 20% 30%, ${t['glow-1']}55, transparent 55%), radial-gradient(1px 1px at 30% 40%, ${t.fg}88 50%, transparent 51%), radial-gradient(1px 1px at 70% 20%, ${t.fg}88 50%, transparent 51%), ${t.bg}`
      : a.backdrop === 'gradient' ? `linear-gradient(135deg, ${t['glow-1']}66, ${t['glow-3']}55, ${t['glow-2']}55), ${t.bg}`
      : a.backdrop === 'plain' || !neon ? t.bg
      : `linear-gradient(180deg, ${t['glow-1']}44, ${t['glow-3']}33 60%, ${t.bg})`;
  return (
    <span className={cn('relative block overflow-hidden rounded-lg border border-border', className)} style={{ background: sky }} aria-hidden>
      {neon && a.backdrop === 'aurora' && (
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="absolute inset-x-0 top-1 h-1/2 w-full opacity-60">
          <path d="M0 30 L15 18 L25 24 L40 10 L55 22 L70 12 L85 22 L100 16 V40 H0Z" fill={t['glow-1']} opacity="0.5" />
          <path d="M0 36 L20 26 L35 32 L50 22 L65 30 L80 24 L100 30 V40 H0Z" fill={t['glow-3']} opacity="0.5" />
        </svg>
      )}
      <span className="absolute inset-y-1.5 left-1.5 w-[18%] rounded" style={{ background: neon ? 'linear-gradient(180deg,#1a1240,#110b2b)' : t.surface, border: neon ? 'none' : `1px solid ${t.border}` }}>
        <span className="mx-auto mt-1.5 block h-1 w-3/5 rounded-full" style={{ background: t.accent }} />
      </span>
      <span className="absolute left-[24%] right-1.5 top-[42%] flex gap-1">
        {[t['chart-1'], t['chart-2'], t['chart-3']].map((c, i) => <span key={i} className="h-3 flex-1 rounded" style={{ background: neon ? c : t.surface, border: neon ? 'none' : `1px solid ${t.border}` }} />)}
      </span>
      <span className="absolute bottom-1.5 left-[24%] right-1.5 h-[28%] rounded" style={{ background: t.surface, opacity: 0.92 }} />
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-[0.8125rem] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Choice({ checked, onClick, label, children, className }: { checked: boolean; onClick: () => void; label: string; children: React.ReactNode; className?: string }) {
  return (
    <button type="button" role="radio" aria-checked={checked} aria-label={label} onClick={onClick} className={cn('group relative flex flex-col items-center gap-1 rounded-xl p-1 text-[0.75rem] text-fg-muted outline-offset-2 transition-colors hover:text-fg', checked && 'text-fg', className)}>
      <span className={cn('relative block w-full rounded-lg ring-2 ring-transparent ring-offset-2 ring-offset-surface-raised transition', checked && 'ring-accent')}>
        {children}
        {checked && <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-accent text-accent-fg"><Check className="size-3" aria-hidden /></span>}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function Segments<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; icon?: typeof Sun }[]; onChange: (v: T) => void }) {
  return (
    <div className="grid gap-1 rounded-xl bg-bg-subtle p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)} className={cn('flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium', value === o.value ? 'bg-surface text-fg shadow-card' : 'text-fg-muted hover:text-fg')}>
          {o.icon && <o.icon className="size-3.5" aria-hidden />}{o.label}
        </button>
      ))}
    </div>
  );
}

export function ThemePanel({ open, onClose, appearance, update }: { open: boolean; onClose: () => void; appearance: Appearance; update: Update }) {
  const [tab, setTab] = useState<Tab>('themes');
  const [draft, setDraft] = useState<Appearance>(appearance);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [systemDark, setSystemDark] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const saved = useRef(appearance);
  saved.current = appearance;

  useEffect(() => {
    if (!open) return;
    setDraft(appearance);
    setError(null);
    setSystemDark(window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
    const t = setTimeout(() => panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus(), 0);
    return () => clearTimeout(t);
    // Only when the panel opens: later saves update `appearance` and must not wipe an unsaved draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    applyAppearance(saved.current);
    onClose();
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stage = (patch: Partial<Appearance>) => {
    setDraft((d) => {
      const next = { ...d, ...patch };
      applyAppearance(next);
      return next;
    });
  };

  const changes = useMemo(() => {
    const out: AppearancePatch = {};
    for (const k of Object.keys(draft) as (keyof Appearance)[]) if (draft[k] !== appearance[k]) (out as Record<string, unknown>)[k] = draft[k];
    return out;
  }, [draft, appearance]);
  const dirty = Object.keys(changes).length > 0;

  const apply = async () => {
    if (!dirty) { onClose(); return; }
    setSaving(true);
    setError(null);
    const r = await update(changes);
    setSaving(false);
    if (!r.ok) { setError(r.message ?? 'Could not save your theme'); return; }
    onClose();
  };

  if (!open) return null;
  const mode: 'light' | 'dark' = draft.mode === 'system' ? (systemDark ? 'dark' : 'light') : draft.mode;
  const tabs: { key: Tab; label: string; icon: typeof Sun }[] = [{ key: 'themes', label: 'Themes', icon: Palette }, { key: 'templates', label: 'Templates', icon: LayoutTemplate }, { key: 'layouts', label: 'Layouts', icon: PanelLeft }];

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <div className="absolute inset-0 bg-black/20" onClick={close} aria-hidden />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="crew-themes-title" className="crew-card absolute inset-y-2 right-2 flex w-[min(24rem,calc(100vw-1rem))] flex-col rounded-2xl border border-border bg-surface-raised shadow-pop animate-slide-up" data-testid="theme-panel">
        <div className="flex items-center gap-2 px-5 pb-3 pt-5">
          <Palette className="size-5 text-accent" aria-hidden />
          <h2 id="crew-themes-title" className="flex-1 text-base font-semibold">Themes &amp; Templates</h2>
          <button type="button" onClick={close} className="rounded-md p-1.5 text-fg-subtle hover:bg-bg-subtle hover:text-fg" aria-label="Close without applying"><X className="size-4" /></button>
        </div>
        <div className="mx-5 grid grid-cols-3 gap-1 rounded-xl bg-bg-subtle p-1" role="tablist" aria-label="Theme options">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" id={`crew-tab-${t.key}`} aria-controls={`crew-tabpanel-${t.key}`} aria-selected={tab === t.key} tabIndex={tab === t.key ? 0 : -1} onClick={() => setTab(t.key)}
              onKeyDown={(e) => {
                const i = tabs.findIndex((x) => x.key === tab);
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!.key;
                  setTab(next);
                  setTimeout(() => document.getElementById(`crew-tab-${next}`)?.focus(), 0);
                }
              }}
              className={cn('flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-[0.8125rem] font-medium', tab === t.key ? 'crew-btn-primary bg-accent text-accent-fg shadow-card' : 'text-fg-muted hover:text-fg')}>
              <t.icon className="size-3.5" aria-hidden />{t.label}
            </button>
          ))}
        </div>

        <div id={`crew-tabpanel-${tab}`} role="tabpanel" aria-labelledby={`crew-tab-${tab}`} className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          {tab === 'themes' && (
            <>
              <Section title="Theme styles">
                <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme style">
                  {THEME_PRESETS.map((p) => (
                    <Choice key={p.key} checked={draft.preset === p.key} label={p.name.split(' ')[0]!} onClick={() => stage({ preset: p.key as ThemePresetKey })}>
                      <Thumb a={{ ...draft, preset: p.key, primary: null }} mode={mode} className="h-14" />
                    </Choice>
                  ))}
                </div>
              </Section>
              <Section title="Colour palette">
                <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Primary colour">
                  <button type="button" role="radio" aria-checked={draft.primary === null} aria-label="Theme's own colour" title="Theme's own colour" onClick={() => stage({ primary: null })}
                    className={cn('size-8 rounded-full ring-2 ring-transparent ring-offset-2 ring-offset-surface-raised', draft.primary === null && 'ring-accent')}
                    style={{ background: 'conic-gradient(#7c3aed, #2563eb, #0d9488, #ea580c, #db2777, #7c3aed)' }} />
                  {PALETTE_SWATCHES.map((c) => (
                    <button key={c} type="button" role="radio" aria-checked={draft.primary === c} aria-label={`Primary colour ${c}`} title={c} onClick={() => stage({ primary: c })}
                      className={cn('size-8 rounded-full ring-2 ring-transparent ring-offset-2 ring-offset-surface-raised', draft.primary === c && 'ring-accent')} style={{ background: c }} />
                  ))}
                </div>
                <p className="text-[0.75rem] text-fg-subtle">CREW adjusts a colour where needed so text on it stays readable.</p>
              </Section>
              <Section title="UI mode">
                <Segments label="UI mode" value={draft.mode} onChange={(v) => stage({ mode: v })} options={[{ value: 'light', label: 'Light', icon: Sun }, { value: 'dark', label: 'Dark', icon: Moon }, { value: 'system', label: 'Auto', icon: Monitor }]} />
              </Section>
              <Section title="Visual style">
                <Segments label="Visual style" value={draft.style} onChange={(v) => stage({ style: v })} options={[{ value: 'neon', label: 'Neon' }, { value: 'classic', label: 'Classic' }]} />
              </Section>
              <Section title="Background style">
                <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Background style">
                  {BACKDROPS.map((b) => (
                    <Choice key={b.key} checked={draft.backdrop === b.key} label={b.label} onClick={() => stage({ backdrop: b.key, ...(draft.style === 'classic' && b.key !== 'plain' ? { style: 'neon' as const } : {}) })}>
                      <Thumb a={{ ...draft, style: 'neon', backdrop: b.key }} mode={mode} className="h-12" />
                    </Choice>
                  ))}
                </div>
              </Section>
            </>
          )}

          {tab === 'templates' && (
            <Section title="Ready-made looks">
              <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Template">
                {THEME_TEMPLATES.map((t) => {
                  const look = { ...draft, ...t.patch };
                  const on = (Object.keys(t.patch) as (keyof Appearance)[]).every((k) => draft[k] === look[k]);
                  const tMode = look.mode === 'system' ? mode : look.mode;
                  return (
                    <Choice key={t.key} checked={on} label={t.name} onClick={() => stage(t.patch)}>
                      <Thumb a={look} mode={tMode} className="h-20" />
                    </Choice>
                  );
                })}
              </div>
              <p className="text-[0.75rem] text-fg-subtle">A template sets the theme, mode, style and background together. You can change any part afterwards.</p>
            </Section>
          )}

          {tab === 'layouts' && (
            <>
              <Section title="Sidebar"><Segments label="Sidebar" value={draft.sidebar} onChange={(v) => stage({ sidebar: v })} options={[{ value: 'expanded', label: 'Expanded' }, { value: 'collapsed', label: 'Icons only' }]} /></Section>
              <Section title="Density"><Segments label="Density" value={draft.density} onChange={(v) => stage({ density: v })} options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'spacious', label: 'Spacious' }]} /></Section>
              <Section title="Corners"><Segments label="Corners" value={draft.radius} onChange={(v) => stage({ radius: v })} options={[{ value: 'sharp', label: 'Sharp' }, { value: 'default', label: 'Default' }, { value: 'round', label: 'Round' }]} /></Section>
              <Section title="Motion"><Segments label="Motion" value={draft.motion} onChange={(v) => stage({ motion: v })} options={[{ value: 'cinematic', label: 'Cinematic' }, { value: 'balanced', label: 'Balanced' }, { value: 'focus', label: 'None' }]} /></Section>
              <button type="button" onClick={() => stage({ ...DEFAULT_APPEARANCE })} className="self-start text-[0.8125rem] font-medium text-accent hover:underline">Back to the CREW default look</button>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-border px-5 py-4">
          {error && <p className="text-[0.8125rem] text-danger" role="alert">{error}</p>}
          <Button size="lg" className="w-full rounded-full" onClick={() => void apply()} loading={saving} data-testid="apply-theme">
            <Check className="size-4" aria-hidden /> {dirty ? 'Apply theme' : 'Done'}
          </Button>
          <Link href="/settings/appearance" onClick={close} className="text-center text-[0.75rem] font-medium text-fg-muted hover:text-accent">More options in the Theme Studio</Link>
        </div>
      </div>
    </div>
  );
}
