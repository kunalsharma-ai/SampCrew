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
export function LocalTime({ value, dateOnly = false, className }: { value: string; dateOnly?: boolean; className?: string }) {
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    const d = new Date(value);
    setLocal(dateOnly ? d.toLocaleDateString() : d.toLocaleString());
  }, [value, dateOnly]);
  return <time dateTime={value} className={className}>{local ?? fixedUtc(value, dateOnly)}</time>;
}

/** The same text in Node and every browser: "2026-11-06 14:46 UTC" (or the date alone). */
export function fixedUtc(value: string, dateOnly = false): string {
  const iso = new Date(value).toISOString();
  return dateOnly ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
