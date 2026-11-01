import { cn } from '../cn';

/** CREW wordmark: three overlapping arcs (people working together) + logotype. */
export function CrewLogo({ className, withWordmark = true, subtitle }: { className?: string; withWordmark?: boolean; subtitle?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="9" fill="var(--accent)" />
        <circle cx="11" cy="13" r="4" fill="white" opacity="0.95" />
        <circle cx="21" cy="13" r="4" fill="white" opacity="0.7" />
        <path d="M5.5 25c1.4-4 4.6-6 8.5-6s7.1 2 8.5 6" stroke="white" strokeWidth="2.4" fill="none" strokeLinecap="round" />
        <circle cx="25" cy="23.5" r="2.5" fill="var(--ember)" />
      </svg>
      {withWordmark && (
        <span className="flex flex-col leading-none">
          <span className="text-[0.9375rem] font-bold tracking-[0.12em] text-fg">CREW</span>
          {subtitle && <span className="mt-0.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-fg-subtle">{subtitle}</span>}
        </span>
      )}
    </span>
  );
}

export function DemoBanner() {
  return (
    <div role="note" className="bg-ember-subtle text-ember text-xs font-medium text-center px-4 py-1.5 border-b border-ember/20">
      Demo workspace. All people, companies and figures here are fictional sample data.
    </div>
  );
}
