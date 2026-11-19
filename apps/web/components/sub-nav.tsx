import { cn } from '@crew/ui';
import Link from 'next/link';

export interface SubNavItem {
  href: string;
  label: string;
  count?: number;
  /** Shown as a red count (overdue, waiting for you) rather than a neutral one. */
  alert?: boolean;
  testId?: string;
}

/**
 * Section tabs as links (each one is its own URL, so a reload or a shared link lands on the same view). Counts sit
 * inside the link name, so screen readers hear "HR tasks, 3".
 */
export function SubNav({ items, current, label }: { items: SubNavItem[]; current: string; label: string }) {
  return (
    <nav aria-label={label} className="-mx-1 mb-5 overflow-x-auto px-1">
      <ul className="flex w-max min-w-full gap-1 rounded-xl border border-border bg-bg-elevated p-1">
        {items.map((i) => {
          const active = i.href === current;
          return (
            <li key={i.href}>
              <Link
                href={i.href}
                aria-current={active ? 'page' : undefined}
                data-testid={i.testId}
                className={cn(
                  'flex items-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium transition-colors motion-reduce:transition-none',
                  active ? 'bg-accent text-accent-fg shadow-sm' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg',
                )}
              >
                {i.label}
                {i.count ? (
                  <span className={cn('min-w-5 rounded-full px-1.5 text-center text-[0.6875rem] font-semibold leading-5 tabular', active ? 'bg-accent-fg/20 text-accent-fg' : i.alert ? 'bg-danger text-white' : 'bg-bg-subtle text-fg')}>
                    {i.count > 99 ? '99+' : i.count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
