'use client';

import { useEffect, useState } from 'react';

/**
 * A date and time shown in the viewer's own time zone and locale.
 *
 * The server does not know the viewer's time zone or locale, so `toLocaleString()` during server rendering and again
 * in the browser can give different text, which React reports as a hydration error (#418). This renders a fixed
 * UTC form first, identical on the server and in the browser's first render, then switches to the local form after
 * hydration.
 */
export function LocalTime({ value, dateOnly = false, relative = false, className }: { value: string; dateOnly?: boolean; relative?: boolean; className?: string }) {
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    const d = new Date(value);
    setLocal(relative ? relativeTime(d) : dateOnly ? d.toLocaleDateString() : d.toLocaleString());
  }, [value, dateOnly, relative]);
  return <time dateTime={value} title={relative ? fixedUtc(value) : undefined} className={className}>{local ?? fixedUtc(value, dateOnly)}</time>;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function relativeTime(d: Date, now = Date.now()): string {
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)} day${Math.round(s / 86_400) === 1 ? '' : 's'} ago`;
  return d.toLocaleDateString();
}

/** The same text in Node and every browser: "2026-11-06 14:46 UTC" (or the date alone). */
export function fixedUtc(value: string, dateOnly = false): string {
  const iso = new Date(value).toISOString();
  return dateOnly ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
