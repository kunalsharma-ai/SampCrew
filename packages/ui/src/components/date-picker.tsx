'use client';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { type InputHTMLAttributes, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../cn';
import { Input } from './form';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${pad(m + 1)}-${pad(d)}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const valid = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const parts = (v: string) => ({ y: Number(v.slice(0, 4)), m: Number(v.slice(5, 7)) - 1, d: Number(v.slice(8, 10)) });
/** Moves a YYYY-MM-DD date by days, in UTC so time zones never shift it. */
const shift = (v: string, days: number) => new Date(Date.parse(`${v}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const clamp = (v: string, min?: string, max?: string) => (min && v < min ? min : max && v > max ? max : v);

export interface DatePickerProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max' | 'defaultValue'> {
  /** YYYY-MM-DD, or '' for no date. */
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  /** The month the calendar shows when no date is chosen yet, such as 25 years before the joining date for a birthday. */
  openTo?: string;
  /** Names the calendar button and panel, such as "Choose date of birth". */
  calendarLabel?: string;
}

/**
 * A date field with a calendar. The date can be typed (the browser's own date entry) or picked from the calendar,
 * which has month and year lists so a birthday decades back is two clicks away. Dates outside min and max cannot be
 * picked. The calendar opens in the page flow rather than floating, so it is never cut off inside a dialog.
 */
export function DatePicker({ value, onChange, min, max, openTo, calendarLabel = 'Choose a date', className, disabled, id, ...rest }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const start = () => clamp(valid(value) ? value : valid(openTo) ? openTo : new Date().toISOString().slice(0, 10), min, max);
  const [focus, setFocus] = useState(start);
  const grid = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  // Opening (or a new value while open) shows that date's month.
  useEffect(() => { if (open) setFocus(start()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, value, min, max]);
  // Keyboard moves inside the grid keep focus on the active day.
  useEffect(() => {
    if (!open || !moved.current) return;
    moved.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`button[data-date="${focus}"]`)?.focus();
  }, [focus, open]);
  // A click anywhere else closes the calendar.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const { y, m } = parts(focus);
  const today = new Date().toISOString().slice(0, 10);
  const minYear = valid(min) ? parts(min).y : Number(today.slice(0, 4)) - 100;
  const maxYear = valid(max) ? parts(max).y : Number(today.slice(0, 4)) + 10;
  const years = useMemo(() => Array.from({ length: Math.max(1, maxYear - minYear + 1) }, (_, i) => maxYear - i), [minYear, maxYear]);
  const out = (d: string) => (valid(min) && d < min) || (valid(max) && d > max);
  const goMonth = (year: number, month: number) => {
    const yy = year + Math.floor(month / 12);
    const mm = ((month % 12) + 12) % 12;
    setFocus(clamp(iso(yy, mm, Math.min(parts(focus).d, daysIn(yy, mm))), min, max));
  };
  const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: daysIn(y, m) }, (_, i) => iso(y, m, i + 1))];
  const pick = (d: string) => { if (out(d)) return; onChange(d); setOpen(false); };
  const firstOfMonth = iso(y, m, 1);
  const lastOfMonth = iso(y, m, daysIn(y, m));

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) { e.preventDefault(); moved.current = true; setFocus(clamp(shift(focus, step[e.key]!), min, max)); }
    else if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); moved.current = true; goMonth(y, m + (e.key === 'PageUp' ? -1 : 1)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(focus); }
  };

  return (
    <div ref={wrap} className={cn('flex flex-col gap-2', className)}>
      <div className="relative">
        <Input
          {...rest}
          id={id}
          type="date"
          value={value}
          min={min}
          max={max}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          data-calendar=""
          className="pr-10"
        />
        <button
          type="button"
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-fg-subtle hover:text-fg disabled:opacity-60"
          aria-label={calendarLabel}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          <CalendarDays className="size-4" />
        </button>
      </div>
      {open && (
        <div
          role="group"
          aria-label={calendarLabel}
          className="w-full max-w-80 rounded-lg border border-border bg-surface p-3 shadow-card"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); } }}
        >
          <div className="mb-2 flex items-center gap-1.5">
            <button type="button" className="rounded p-1 text-fg-subtle hover:bg-bg-subtle hover:text-fg disabled:opacity-40" aria-label="Previous month" disabled={valid(min) && firstOfMonth <= min} onClick={() => goMonth(y, m - 1)}>
              <ChevronLeft className="size-4" />
            </button>
            <select aria-label="Month" className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-1.5 text-sm" value={m} onChange={(e) => goMonth(y, Number(e.target.value))}>
              {MONTHS.map((name, i) => <option key={name} value={i} disabled={(valid(min) && iso(y, i, daysIn(y, i)) < min) || (valid(max) && iso(y, i, 1) > max)}>{name}</option>)}
            </select>
            <select aria-label="Year" className="h-8 w-20 rounded-md border border-border bg-surface px-1.5 text-sm" value={y} onChange={(e) => goMonth(Number(e.target.value), m)}>
              {years.map((yr) => <option key={yr} value={yr}>{yr}</option>)}
            </select>
            <button type="button" className="rounded p-1 text-fg-subtle hover:bg-bg-subtle hover:text-fg disabled:opacity-40" aria-label="Next month" disabled={valid(max) && lastOfMonth >= max} onClick={() => goMonth(y, m + 1)}>
              <ChevronRight className="size-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-[0.6875rem] font-medium text-fg-subtle" aria-hidden>
            {WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
          </div>
          <div ref={grid} className="mt-1 grid grid-cols-7 gap-0.5" onKeyDown={onGridKey}>
            {cells.map((d, i) => d === null ? <span key={`b${i}`} /> : (
              <button
                key={d}
                type="button"
                data-date={d}
                tabIndex={d === focus ? 0 : -1}
                disabled={out(d)}
                aria-pressed={d === value}
                aria-label={new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}
                onClick={() => pick(d)}
                className={cn(
                  'h-8 rounded-md text-sm tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-30',
                  d === value ? 'bg-accent font-semibold text-accent-fg' : 'hover:bg-bg-subtle',
                  d === today && d !== value && 'ring-1 ring-inset ring-accent/50',
                )}
              >
                {Number(d.slice(8))}
              </button>
            ))}
          </div>
          {(valid(min) || valid(max)) && (
            <p className="mt-2 text-[0.6875rem] text-fg-subtle">
              {valid(min) && valid(max) ? `From ${min} to ${max}` : valid(min) ? `From ${min}` : `Up to ${max}`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
