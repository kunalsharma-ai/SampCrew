/**
 * Wall-clock time in a named IANA time zone, without a date library. Attendance days are local to the
 * employee's location (a night shift in Pune and one in London start at different instants), while punches
 * are stored as UTC instants.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  date: string; // YYYY-MM-DD
  minutes: number; // minutes since local midnight
  seconds: number;
}

/** The local date and time of an instant in a zone. */
export function toLocal(epochMs: number, tz: string): LocalParts {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(epochMs)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), seconds: Number(p.second) };
}

/** Offset of the zone from UTC at an instant, in minutes (e.g. +330 for India). */
export function offsetMinutes(epochMs: number, tz: string): number {
  const l = toLocal(epochMs, tz);
  const asUtc = Date.parse(`${l.date}T00:00:00Z`) + l.minutes * 60_000 + l.seconds * 1000;
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

/**
 * The instant at which a local date and time occurs. `minutes` may exceed 1440 to mean the next day (night shifts).
 * In a daylight-saving gap the time is moved forward by the gap; in an overlap the earlier instant is used.
 */
export function fromLocal(date: string, minutes: number, tz: string): number {
  const naive = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  let guess = naive - offsetMinutes(naive, tz) * 60_000;
  const second = naive - offsetMinutes(guess, tz) * 60_000;
  if (second !== guess) guess = Math.min(guess, second);
  return guess;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today's date in a zone. */
export function localToday(tz: string, now = Date.now()): string {
  return toLocal(now, tz).date;
}

/** "HH:MM" or "HH:MM:SS" to minutes since midnight. */
export function hhmm(t: string): number {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
}

export function fmtHhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}
