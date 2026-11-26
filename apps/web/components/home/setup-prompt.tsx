'use client';
import { Check, Rocket, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { cn } from '@crew/ui';
import { saveExperienceAction } from '@/app/(app)/experience-actions';

const LATER_KEY = 'crew-setup-prompt-later';

/**
 * "Set up your workspace" (issue #86): a pop-up on top of Home that stays until every step is done or the person
 * opens one of them. "Later" only hides it for this browser session; it comes back on the next sign-in.
 */
export function SetupPrompt({ steps }: { steps: { done: boolean; label: string; href: string }[] }) {
  const router = useRouter();
  const [hidden, setHidden] = useState(false);
  const [pending, start] = useTransition();
  useEffect(() => {
    try { if (sessionStorage.getItem(LATER_KEY)) setHidden(true); } catch {}
  }, []);
  if (hidden) return null;
  const done = steps.filter((s) => s.done).length;
  const open = (href: string) => start(async () => {
    await saveExperienceAction({ setupPromptSeen: true });
    router.push(href);
  });
  const later = () => {
    try { sessionStorage.setItem(LATER_KEY, '1'); } catch {}
    setHidden(true);
  };
  return (
    <section role="dialog" aria-modal="false" aria-labelledby="setup-prompt-title" data-testid="setup-prompt" className="crew-card relative mb-5 rounded-2xl border border-accent/40 bg-surface p-4 shadow-pop animate-slide-up sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-glow-1 to-glow-2 text-white"><Rocket className="size-5" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <h2 id="setup-prompt-title" className="text-[0.9375rem] font-semibold">Set up your workspace</h2>
          <p className="text-[0.8125rem] text-fg-muted">{done} of {steps.length} done. Pick a step to continue; this stays on top until the setup is complete or you open it.</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-subtle" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done} aria-label="Setup progress">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(done / steps.length) * 100}%` }} />
          </div>
          <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {steps.map((s) => (
              <li key={s.href}>
                <button type="button" disabled={pending} onClick={() => open(s.href)} data-testid="setup-prompt-step"
                  className={cn('flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[0.8125rem] transition-colors', s.done ? 'border-success/30 bg-success-subtle/50 text-fg-muted' : 'border-border hover:border-accent hover:bg-accent-subtle')}>
                  <span className={cn('grid size-4 shrink-0 place-items-center rounded-full border', s.done ? 'border-success bg-success text-white' : 'border-border-strong')}>{s.done && <Check className="size-3" aria-hidden />}</span>
                  <span className={cn('flex-1', s.done && 'line-through')}>{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <button type="button" onClick={later} className="rounded-md p-1 text-fg-subtle hover:bg-bg-subtle hover:text-fg" aria-label="Remind me later" title="Remind me later" data-testid="setup-prompt-later"><X className="size-4" /></button>
      </div>
    </section>
  );
}
