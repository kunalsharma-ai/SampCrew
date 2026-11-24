'use client';
import type { DelegatedModule } from '@crew/contracts';
import { Badge, cn } from '@crew/ui';
import { Lock } from 'lucide-react';
import { useMemo } from 'react';

const LOCK_LABEL: Record<string, string> = {
  console: 'Not in the company’s plan, or kept at company level by SAMPLEDGE',
  super: 'Not given to this HR Workspace',
  hr: 'Not given to this HR Workspace',
};

/**
 * The delegation grid: every module, grouped by area, as given here, available to give, or locked because the
 * level above does not hold it. The API checks the same rule, so a locked module cannot be given by any route.
 */
export function ModulePicker({ modules, value, onChange, disabled, lockedHint }: {
  modules: DelegatedModule[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  lockedHint?: (m: DelegatedModule) => string;
}) {
  const groups = useMemo(() => [...new Set(modules.map((m) => m.module))], [modules]);
  const chosen = new Set(value);
  const open = modules.filter((m) => !m.core && m.state !== 'locked');
  const toggle = (key: string, on: boolean) => onChange(on ? [...new Set([...value, key])].sort() : value.filter((k) => k !== key));
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-fg-muted">
        <span>{open.filter((m) => chosen.has(m.key)).length} of {open.length} modules given</span>
        {!disabled && (
          <>
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => onChange([...new Set([...value, ...open.map((m) => m.key)])].sort())}>Select all</button>
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => onChange(value.filter((k) => !open.some((m) => m.key === k)))}>Clear</button>
          </>
        )}
      </div>
      {groups.map((g) => (
        <fieldset key={g} className="grid gap-2">
          <legend className="mb-1 flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-fg-subtle">
            {g}
            {!disabled && open.some((m) => m.module === g) && (
              <span className="flex gap-2 normal-case tracking-normal">
                <button type="button" className="font-medium text-accent hover:underline" aria-label={`Select all ${g} modules`} onClick={() => onChange([...new Set([...value, ...open.filter((m) => m.module === g).map((m) => m.key)])].sort())}>Select all</button>
                <button type="button" className="font-medium text-accent hover:underline" aria-label={`Clear ${g} modules`} onClick={() => onChange(value.filter((k) => !open.some((m) => m.module === g && m.key === k)))}>Clear</button>
              </span>
            )}
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {modules.filter((m) => m.module === g).map((m) => {
              const locked = m.state === 'locked';
              const on = m.core || chosen.has(m.key);
              return (
                <label
                  key={m.key}
                  title={locked ? (lockedHint?.(m) ?? LOCK_LABEL[m.lockedBy ?? 'console']) : undefined}
                  className={cn(
                    'flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors',
                    locked ? 'cursor-not-allowed border-dashed border-border bg-bg-subtle/60 text-fg-subtle' : on ? 'border-accent/50 bg-accent-subtle/40' : 'border-border hover:border-border-strong',
                  )}
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 rounded border-border-strong accent-[var(--accent)]"
                    checked={on && !locked}
                    disabled={disabled || locked || m.core}
                    onChange={(e) => toggle(m.key, e.target.checked)}
                    aria-describedby={locked ? `lock-${m.key}` : undefined}
                  />
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  {m.core && <Badge>Always on</Badge>}
                  {locked && (
                    <span id={`lock-${m.key}`} className="inline-flex items-center gap-1 text-xs">
                      <Lock className="size-3.5" aria-hidden />
                      {m.stale ? 'Inactive' : 'Locked'}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
