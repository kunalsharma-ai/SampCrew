'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export const SUPPORT_EVENTS = ['support.message', 'support.read', 'support.changed', 'help.query'] as const;

/**
 * Keeps the Console's support inbox (and its menu badge) current: listens to /live and re-renders the page's server
 * data when a Super Workspace writes, reads or resolves. Falls back to refreshing every minute when the stream fails.
 */
export function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let t: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let failures = 0;
    let closed = false;
    const fire = () => {
      if (t) return;
      t = setTimeout(() => { t = null; router.refresh(); }, 400);
    };
    const open = () => {
      es = new EventSource('/live');
      es.addEventListener('ready', () => { failures = 0; document.documentElement.dataset.consoleLive = 'on'; });
      for (const type of SUPPORT_EVENTS) es.addEventListener(type, fire);
      es.onerror = () => {
        failures++;
        delete document.documentElement.dataset.consoleLive;
        if (es?.readyState === EventSource.CLOSED && !closed) {
          if (failures > 3) { poll ??= setInterval(() => router.refresh(), 60_000); return; }
          setTimeout(open, 3000);
        }
      };
    };
    open();
    return () => {
      closed = true;
      es?.close();
      if (t) clearTimeout(t);
      if (poll) clearInterval(poll);
    };
  }, [router]);
  return null;
}
