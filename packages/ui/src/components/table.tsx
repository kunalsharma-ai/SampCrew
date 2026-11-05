import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../cn';

/**
 * Lightweight table primitives. Wrap in a Card; scrolls horizontally on narrow screens. The scrolling wrapper takes
 * keyboard focus, so people who do not use a mouse can scroll a wide table with the arrow keys (WCAG 2.1.1).
 */
export function Table({ className, children, 'aria-label': label }: { className?: string; children: ReactNode; 'aria-label'?: string }) {
  return (
    <div
      className="overflow-x-auto rounded-[inherit] outline-none focus-visible:ring-3 focus-visible:ring-accent/40"
      tabIndex={0}
      role="region"
      aria-label={label ?? 'Table'}
    >
      <table aria-label={label} className={cn('w-full text-left text-[0.8125rem]', className)}>{children}</table>
    </div>
  );
}
export const THead = (p: HTMLAttributes<HTMLTableSectionElement>) => <thead {...p} className={cn('text-xs text-fg-subtle', p.className)} />;
export const TBody = (p: HTMLAttributes<HTMLTableSectionElement>) => <tbody {...p} className={cn('divide-y divide-border', p.className)} />;
export const TR = (p: HTMLAttributes<HTMLTableRowElement>) => <tr {...p} className={cn('transition-colors hover:bg-bg-subtle/60', p.className)} />;
export const TH = (p: ThHTMLAttributes<HTMLTableCellElement>) => <th {...p} className={cn('px-5 py-2.5 font-medium border-b border-border whitespace-nowrap', p.className)} />;
export const TD = (p: TdHTMLAttributes<HTMLTableCellElement>) => <td {...p} className={cn('px-5 py-3 align-middle text-fg', p.className)} />;
