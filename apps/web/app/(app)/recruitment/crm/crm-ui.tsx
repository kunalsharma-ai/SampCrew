'use client';
import { Alert, Badge, type Tone } from '@crew/ui';
import type { Notice } from '../use-runner';

/** Stage colours by what the stage means: in progress, joined, closed or on hold. */
const KIND_TONE: Record<string, Tone> = { open: 'info', won: 'success', lost: 'neutral', paused: 'warning' };
export function StageBadge({ label, kind }: { label: string; kind?: string }) {
  return <Badge tone={KIND_TONE[kind ?? 'open'] ?? 'info'} dot>{label}</Badge>;
}

const PRIORITY_TONE: Record<string, Tone> = { low: 'neutral', medium: 'info', high: 'warning', urgent: 'danger' };
export const PriorityBadge = ({ priority }: { priority: string }) => <Badge tone={PRIORITY_TONE[priority] ?? 'neutral'}>{priority[0]!.toUpperCase() + priority.slice(1)}</Badge>;

const FOLLOW_TONE: Record<string, Tone> = { pending: 'info', completed: 'success', rescheduled: 'warning', missed: 'danger', cancelled: 'neutral' };
export const FollowUpBadge = ({ status, overdue }: { status: string; overdue?: boolean }) =>
  overdue ? <Badge tone="danger" dot>Overdue</Badge> : <Badge tone={FOLLOW_TONE[status] ?? 'neutral'} dot>{status[0]!.toUpperCase() + status.slice(1)}</Badge>;

export const when = (d: string | null | undefined) => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const day = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString([], { dateStyle: 'medium' }) : '—');
export const dash = (v: unknown) => (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) ? '—' : Array.isArray(v) ? v.join(', ') : String(v));

/** A date and time input's value ("2026-11-22T10:30") for a moment, in the browser's own zone. */
export function localInput(d: Date | string | null | undefined) {
  if (!d) return '';
  const x = new Date(d);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}
/** An input's local date and time as an ISO moment with the browser's offset. */
export const toIso = (local: string) => (local ? new Date(local).toISOString() : null);

/** Relative label for a due time: "Overdue by 2 days", "Today 3:00 PM", "In 3 days". */
export function dueText(d: string | null | undefined) {
  if (!d) return 'None';
  const at = new Date(d);
  const now = new Date();
  const days = Math.round((new Date(at.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86400000);
  const time = at.toLocaleTimeString([], { timeStyle: 'short' });
  if (at < now && days === 0) return `Today ${time} (overdue)`;
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 0) return `Overdue by ${-days} day${days === -1 ? '' : 's'}`;
  return `In ${days} days`;
}

export function NoticeBar({ notice }: { notice: Notice }) {
  return notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null;
}

/** Options from the contracts' [key, label] lists. */
export const optionsOf = (list: readonly (readonly [string, string, ...unknown[]])[]) => list.map(([value, label]) => ({ value, label }));

/** Pay as people read it: ₹12 L for lakhs in rupees, otherwise the amount with its currency. */
export function money(v: unknown, currency?: unknown) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const cur = typeof currency === 'string' && currency ? currency : 'INR';
  if (cur === 'INR' && n >= 100000) return `₹${(n / 100000).toFixed(2).replace(/\.0+$|(\.\d)0$/, '$1')} L`;
  return `${cur} ${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}
