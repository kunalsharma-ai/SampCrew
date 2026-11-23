/** Money and number formatting for Console pages. */
export function fmtMoney(v: string | number, currency: string, digits = 0) {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: digits }).format(Number(v)); } catch { return `${currency} ${v}`; }
}

/** A per-currency amount map ({ INR: '1200.00', USD: '40.00' }) as text, skipping zeros. */
export function fmtMoneyMap(m: Record<string, string> | null | undefined, empty = '—') {
  const parts = Object.entries(m ?? {}).filter(([, v]) => Number(v) !== 0).map(([c, v]) => fmtMoney(v, c));
  return parts.length ? parts.join(' + ') : empty;
}

export const fmtNumber = (n: number) => new Intl.NumberFormat('en').format(n);
