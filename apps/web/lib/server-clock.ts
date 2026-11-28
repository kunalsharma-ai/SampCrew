'use client';
import { useEffect, useState } from 'react';

/**
 * The server's clock on the page (issue #91 point 1). A laptop's own clock can be minutes or hours wrong, so every
 * attendance clock, timer and "now" on the page runs from the time the server gave last, plus the time elapsed since
 * (performance.now() is monotonic and does not move when someone changes the system clock).
 */
let base: { serverMs: number; perfMs: number } | null = null;

const perf = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Records a time the server reported (ms or ISO). Later readings replace earlier ones. */
export function syncServerClock(server: number | string | null | undefined) {
  // Only in the browser: on the server this module is shared by every request, and the server's clock is right anyway.
  if (typeof window === 'undefined') return;
  const ms = typeof server === 'string' ? Date.parse(server) : server;
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return;
  base = { serverMs: ms, perfMs: perf() };
}

/** Now, by the server's clock when it is known, otherwise the device clock. */
export function serverNow(): number {
  return base ? base.serverMs + (perf() - base.perfMs) : Date.now();
}

/** True once a server time has been recorded on this page. */
export function serverClockKnown() {
  return base !== null;
}

/**
 * A ticking "now" from the server's clock. `seed` is the server time the page was rendered with, so the first paint
 * and the ticking clock agree whatever the device clock says.
 */
export function useServerNow(seed: number | string | null | undefined, everyMs = 1000) {
  const seedMs = typeof seed === 'string' ? Date.parse(seed) : seed ?? null;
  const [now, setNow] = useState(() => seedMs ?? serverNow());
  useEffect(() => {
    if (seedMs !== null && Number.isFinite(seedMs)) {
      // The first server reading sets the clock; later fresh readings come from syncServerClock (today's attendance).
      if (!base) syncServerClock(seedMs);
    }
    setNow(serverNow());
    const id = window.setInterval(() => setNow(serverNow()), everyMs);
    return () => window.clearInterval(id);
  }, [seedMs, everyMs]);
  return now;
}
