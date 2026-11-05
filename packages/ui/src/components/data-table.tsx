'use client';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronUp, Columns3, Rows3 } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '../cn';

export interface DataColumn<T> {
  key: string;
  label: string;
  /** Server sort key, when the column can be sorted. */
  sort?: string;
  /** Columns that identify the row (such as the name) cannot be hidden. */
  required?: boolean;
  className?: string;
  render: (row: T) => ReactNode;
}

export type TableDensity = 'comfortable' | 'compact';

interface DataTableProps<T> {
  label: string;
  columns: DataColumn<T>[];
  /** Visible column keys, in display order. */
  visible: string[];
  onVisibleChange?: (keys: string[]) => void;
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  sort?: string;
  dir?: 'asc' | 'desc';
  onSort?: (sort: string, dir: 'asc' | 'desc') => void;
  density?: TableDensity;
  onDensityChange?: (d: TableDensity) => void;
  /** Filters and search, shown on the left of the toolbar. */
  toolbar?: ReactNode;
  /** Buttons such as export and saved views, shown on the right. */
  actions?: ReactNode;
  /** Shown instead of the table when there are no rows. */
  empty?: ReactNode;
  footer?: ReactNode;
}

/**
 * The shared list table: sortable headers (sorting runs on the server, so it covers every page, not just the rows
 * on screen), a column picker with reordering, row density, and slots for filters, export and saved views.
 * The header row stays in view while the list scrolls.
 */
export function DataTable<T>(p: DataTableProps<T>) {
  const cols = p.visible.map((k) => p.columns.find((c) => c.key === k)).filter((c): c is DataColumn<T> => !!c);
  const compact = p.density === 'compact';
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <div className="flex min-w-[min(100%,30rem)] flex-1 flex-col gap-3 sm:flex-row sm:items-center">{p.toolbar}</div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {p.onVisibleChange && <ColumnPicker columns={p.columns} visible={p.visible} onChange={p.onVisibleChange} />}
          {p.onDensityChange && (
            <button
              type="button"
              onClick={() => p.onDensityChange!(compact ? 'comfortable' : 'compact')}
              aria-pressed={compact}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[0.8125rem] text-fg-muted hover:bg-bg-subtle hover:text-fg"
            >
              <Rows3 className="size-3.5" /> Compact rows
            </button>
          )}
          {p.actions}
        </div>
      </div>
      {p.rows.length === 0 && p.empty ? (
        p.empty
      ) : (
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full text-left text-[0.8125rem]" aria-label={p.label}>
            <thead className="sticky top-0 z-10 bg-surface text-xs text-fg-subtle">
              <tr>
                {cols.map((c) => {
                  const active = c.sort && p.sort === c.sort;
                  const ariaSort = active ? (p.dir === 'desc' ? 'descending' : 'ascending') : undefined;
                  return (
                    <th key={c.key} aria-sort={ariaSort} className={cn('whitespace-nowrap border-b border-border px-5 font-medium', compact ? 'py-1.5' : 'py-2.5')}>
                      {c.sort && p.onSort ? (
                        <button
                          type="button"
                          className={cn('-mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-fg', active && 'text-fg')}
                          onClick={() => p.onSort!(c.sort!, active && p.dir === 'asc' ? 'desc' : 'asc')}
                          aria-label={`Sort by ${c.label}${active ? (p.dir === 'asc' ? ', sorted ascending' : ', sorted descending') : ''}`}
                        >
                          {c.label}
                          {active ? (p.dir === 'desc' ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />) : <ArrowUpDown className="size-3 opacity-40" />}
                        </button>
                      ) : (
                        c.label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {p.rows.map((r) => (
                <tr key={p.rowKey(r)} className={cn('transition-colors hover:bg-bg-subtle/60', p.onRowClick && 'cursor-pointer')} onClick={p.onRowClick ? () => p.onRowClick!(r) : undefined}>
                  {cols.map((c) => (
                    <td key={c.key} className={cn('px-5 align-middle text-fg', compact ? 'py-1.5' : 'py-3', c.className)}>{c.render(r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.footer}
    </div>
  );
}

function ColumnPicker<T>({ columns, visible, onChange }: { columns: DataColumn<T>[]; visible: string[]; onChange: (k: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  // Visible columns first, in their order, then the hidden ones.
  const ordered = [...visible.map((k) => columns.find((c) => c.key === k)).filter((c): c is DataColumn<T> => !!c), ...columns.filter((c) => !visible.includes(c.key))];
  const move = (key: string, by: -1 | 1) => {
    const i = visible.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= visible.length) return;
    const next = [...visible];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[0.8125rem] text-fg-muted hover:bg-bg-subtle hover:text-fg"
      >
        <Columns3 className="size-3.5" /> Columns <ChevronDown className="size-3" />
      </button>
      {open && (
        <div role="group" aria-label="Choose columns" className="absolute left-0 z-30 mt-1 w-64 rounded-lg border border-border bg-surface-raised p-1.5 shadow-pop">
          {ordered.map((c) => {
            const on = visible.includes(c.key);
            const i = visible.indexOf(c.key);
            return (
              <div key={c.key} className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-bg-subtle">
                <label className="flex flex-1 items-center gap-2 text-[0.8125rem]">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-[var(--accent)]"
                    checked={on}
                    disabled={c.required}
                    onChange={() => onChange(on ? visible.filter((k) => k !== c.key) : [...visible, c.key])}
                  />
                  {c.label}
                </label>
                {on && (
                  <>
                    <button type="button" className="rounded p-0.5 text-fg-subtle hover:text-fg disabled:opacity-30" disabled={i === 0} onClick={() => move(c.key, -1)} aria-label={`Move ${c.label} left`}><ChevronUp className="size-3.5" /></button>
                    <button type="button" className="rounded p-0.5 text-fg-subtle hover:text-fg disabled:opacity-30" disabled={i === visible.length - 1} onClick={() => move(c.key, 1)} aria-label={`Move ${c.label} right`}><ChevronDown className="size-3.5" /></button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
