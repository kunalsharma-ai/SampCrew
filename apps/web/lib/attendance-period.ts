/**
 * The period picker of the Attendance pages: Today, This week, This month, Previous month, a month, or a custom range.
 * Worked out in the company's time zone so "today" is the company's today. The API checks the same dates again.
 */
export type PeriodKey = 'today' | 'week' | 'month' | 'previous_month' | 'custom';

export interface Period {
  key: PeriodKey;
  from: string;
  to: string;
  label: string;
  /** The month (YYYY-MM) when the period is one whole month. */
  month: string | null;
  today: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const companyToday = (timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const monthBounds = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
};

export const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
};

export const monthLabel = (month: string) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
export const dateLabel = (d: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

export function resolvePeriod(sp: { period?: string; from?: string; to?: string; month?: string }, timeZone: string): Period {
  const today = companyToday(timeZone);
  const asMonth = (month: string, key: PeriodKey): Period => ({ key, ...monthBounds(month), label: monthLabel(month), month, today });
  if (sp.period === 'today') return { key: 'today', from: today, to: today, label: `Today, ${dateLabel(today)}`, month: null, today };
  if (sp.period === 'week') {
    const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
    const from = plusDays(today, -dow);
    return { key: 'week', from, to: plusDays(from, 6), label: `This week, ${dateLabel(from)} to ${dateLabel(plusDays(from, 6))}`, month: null, today };
  }
  if (sp.period === 'previous_month') return asMonth(shiftMonth(today.slice(0, 7), -1), 'previous_month');
  if (sp.period === 'custom' || (sp.from && sp.to)) {
    let from = DAY.test(sp.from ?? '') ? sp.from! : today;
    let to = DAY.test(sp.to ?? '') ? sp.to! : today;
    if (to < from) [from, to] = [to, from];
    if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) from = plusDays(to, -366);
    return { key: 'custom', from, to, label: `${dateLabel(from)} to ${dateLabel(to)}`, month: null, today };
  }
  if (MONTH.test(sp.month ?? '')) return asMonth(sp.month!, sp.month === today.slice(0, 7) ? 'month' : 'custom');
  return asMonth(today.slice(0, 7), 'month');
}

/** The query string of a period, for links and the export. */
export function periodQuery(p: Period): Record<string, string> {
  if (p.key === 'custom') return p.month ? { month: p.month } : { period: 'custom', from: p.from, to: p.to };
  return { period: p.key };
}
