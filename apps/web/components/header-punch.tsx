'use client';
import { Button, cn } from '@crew/ui';
import { Coffee, LogIn, LogOut, TimerReset } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { attendanceTodayAction, punchAction } from '@/app/(app)/attendance/actions';
import { punchLocation } from '@/lib/locate';
import { BREAK_NOTE, tally } from '@/components/home/employee-home';
import { hm } from '@/lib/time';
import type { AttendanceToday } from '@/lib/types';

/** Fired after any punch on the page, so the top bar and the Home card show the same state. */
export const PUNCHED_EVENT = 'crew:punched';

/**
 * Check in, check out and breaks from the top bar, on every page. A break is a check-out marked "Break" and ends at
 * the next check-in, so break time is never counted as worked time (the same punches the Home card makes).
 */
export function HeaderPunch() {
  const router = useRouter();
  const pathname = usePathname();
  const [today, setToday] = useState<AttendanceToday | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const load = useCallback(async () => {
    const r = await attendanceTodayAction();
    setToday(r.ok && r.data ? r.data : null);
  }, []);
  useEffect(() => { void load(); }, [load, pathname]);
  useEffect(() => {
    const on = () => void load();
    window.addEventListener(PUNCHED_EVENT, on);
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { window.removeEventListener(PUNCHED_EVENT, on); window.clearInterval(id); };
  }, [load]);
  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(() => setMessage(null), 6000);
    return () => window.clearTimeout(id);
  }, [message]);
  if (!today || !today.allowed.web || today.locked) return null;

  const t = tally(today.punches, now);
  const phase = t.open ? 'working' : t.onBreak ? 'on_break' : today.punches.length ? 'done' : 'not_in';
  const punch = (direction: 'in' | 'out', note: string | undefined, done: string) => start(async () => {
    setMessage(null);
    const { where, refused } = await punchLocation(today);
    if (refused) {
      setMessage({ tone: 'error', text: refused });
      return;
    }
    const r = await punchAction({ ...where, direction, ...(note ? { note } : {}) });
    if (!r.ok) { setMessage({ tone: 'error', text: r.message }); return; }
    setMessage({ tone: 'ok', text: done });
    await load();
    window.dispatchEvent(new Event(PUNCHED_EVENT));
    router.refresh();
  });
  const label = phase === 'working' ? `Working ${hm(t.worked) === '—' ? '0m' : hm(t.worked)}` : phase === 'on_break' ? `On a break, ${hm(t.breaks) === '—' ? '0m' : hm(t.breaks)} today` : null;
  return (
    <div className="relative mr-1 flex items-center gap-1.5" data-testid="header-punch" data-phase={phase}>
      {label && <span className={cn('hidden whitespace-nowrap text-[0.75rem] font-medium lg:inline', phase === 'working' ? 'text-success' : 'text-ember')}>{label}</span>}
      {phase === 'working' && (
        <>
          <Button size="sm" variant="secondary" loading={pending} onClick={() => punch('out', BREAK_NOTE, 'Break started')} data-testid="header-start-break" title="Start a break"><Coffee className="size-4" /><span className="hidden sm:inline">Break</span></Button>
          <Button size="sm" loading={pending} onClick={() => punch('out', undefined, 'Checked out')} data-testid="header-check-out"><LogOut className="size-4" /><span className="hidden sm:inline">Check out</span></Button>
        </>
      )}
      {phase === 'on_break' && <Button size="sm" loading={pending} onClick={() => punch('in', 'Back from break', 'Break ended')} data-testid="header-end-break"><TimerReset className="size-4" /><span className="hidden sm:inline">End break</span></Button>}
      {(phase === 'not_in' || phase === 'done') && <Button size="sm" loading={pending} onClick={() => punch('in', undefined, 'Checked in')} data-testid="header-check-in"><LogIn className="size-4" /><span className="hidden sm:inline">{phase === 'done' ? 'Check in again' : 'Check in'}</span></Button>}
      {message && (
        <span role="status" className={cn('absolute right-0 top-full z-40 mt-2 w-max max-w-xs rounded-lg border px-3 py-2 text-[0.75rem] shadow-card', message.tone === 'ok' ? 'border-success/40 bg-surface text-success' : 'border-danger/40 bg-surface text-danger')} data-testid="header-punch-message">
          {message.text}
        </span>
      )}
    </div>
  );
}
