import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../cn';

/** Lightweight table primitives. Wrap in a Card; scrolls horizontally on narrow screens. */
export function Table({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full text-left text-[0.8125rem]', className)}>{children}</table>
    </div>
  );
}
export const THead = (p: HTMLAttributes<HTMLTableSectionElement>) => <thead {...p} className={cn('text-xs text-fg-subtle', p.className)} />;
export const TBody = (p: HTMLAttributes<HTMLTableSectionElement>) => <tbody {...p} className={cn('divide-y divide-border', p.className)} />;
export const TR = (p: HTMLAttributes<HTMLTableRowElement>) => <tr {...p} className={cn('transition-colors hover:bg-bg-subtle/60', p.className)} />;
export const TH = (p: ThHTMLAttributes<HTMLTableCellElement>) => <th {...p} className={cn('px-5 py-2.5 font-medium border-b border-border whitespace-nowrap', p.className)} />;
export const TD = (p: TdHTMLAttributes<HTMLTableCellElement>) => <td {...p} className={cn('px-5 py-3 align-middle text-fg', p.className)} />;
