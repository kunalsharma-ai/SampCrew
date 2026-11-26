'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@crew/ui';
import { idleLogoutAction, sessionActivityAction } from '@/app/(app)/shell-actions';

const KEY = 'crew-last-activity';
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove', 'scroll'] as const;

function readLast(): number {
  try {
    return Number(localStorage.getItem(KEY)) || Date.now();
  } catch {
    return Date.now();
  }
}

/**
 * Automatic sign-out after inactivity (issue #89). The Super Workspace sets the time for everyone; this watches real
 * use (clicks, typing, scrolling) across every open tab, tells the server about it about once a minute, warns a
 * minute before the end, and signs out when the time is up. The server enforces the same rule on its own.
 */
export function IdleWatch({ minutes }: { minutes: number | null | undefined }) {
  const limit = (minutes ?? 0) * 60_000;
  const [warn, setWarn] = useState<number | null>(null);
  const lastBeat = useRef(0);
  const leaving = useRef(false);

  const touch = useCallback(() => {
    const now = Date.now();
    try {
      if (now - readLast() > 5_000) localStorage.setItem(KEY, String(now));
    } catch { /* storage blocked: this tab's own clock is used */ }
    if (now - lastBeat.current > 60_000) {
      lastBeat.current = now;
      void sessionActivityAction();
    }
  }, []);

  useEffect(() => {
    if (!limit) return;
    try { localStorage.setItem(KEY, String(Date.now())); } catch { /* ignore */ }
    lastBeat.current = Date.now();
    let local = Date.now();
    const onUse = () => {
      local = Date.now();
      touch();
    };
    for (const e of EVENTS) window.addEventListener(e, onUse, { passive: true });
    const timer = window.setInterval(() => {
      const last = Math.max(readLast(), local);
      const left = limit - (Date.now() - last);
      if (left <= 0) {
        if (!leaving.current) {
          leaving.current = true;
          void idleLogoutAction();
        }
      } else setWarn(left <= 60_000 ? Math.ceil(left / 1000) : null);
    }, 1_000);
    return () => {
      for (const e of EVENTS) window.removeEventListener(e, onUse);
      window.clearInterval(timer);
    };
  }, [limit, touch]);

  if (!limit || warn === null) return null;
  return (
    <div role="alertdialog" aria-modal="false" aria-labelledby="idle-title" data-testid="idle-warning" className="fixed inset-x-0 bottom-6 z-[90] mx-auto flex w-[min(28rem,calc(100%-2rem))] flex-col gap-3 rounded-xl border border-warning/40 bg-surface p-4 shadow-lg">
      <p id="idle-title" className="text-sm font-semibold">You will be signed out in {warn} seconds</p>
      <p className="text-xs text-fg-muted">Your company signs people out after a period of inactivity. Stay signed in to keep working.</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => { touch(); setWarn(null); }}>Stay signed in</Button>
        <Button size="sm" variant="ghost" onClick={() => { leaving.current = true; void idleLogoutAction(); }}>Sign out now</Button>
      </div>
    </div>
  );
}
