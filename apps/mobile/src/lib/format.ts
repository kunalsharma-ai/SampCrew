/**
 * Amounts arrive from the API as exact decimal strings. They are formatted as text, never converted through
 * floating point. INR uses Indian digit grouping (12,34,567.00).
 */
export function money(v: string, currency: string): string {
  const [whole, frac = ''] = v.trim().split('.');
  const neg = whole.startsWith('-');
  const digits = (neg ? whole.slice(1) : whole).replace(/^0+(?=\d)/, '') || '0';
  let grouped: string;
  if (currency === 'INR' && digits.length > 3) {
    const head = digits.slice(0, -3);
    grouped = `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}`;
  } else grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${neg ? '-' : ''}${symbol}${grouped}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

/** Maps a notification link from the API (a web path) to a screen in the app, or null when there is none. */
export function appRoute(link: string | null | undefined): string | null {
  if (!link) return null;
  const path = link.split('?')[0];
  const m = (re: RegExp) => path.match(re);
  let r: RegExpMatchArray | null;
  if ((r = m(/^\/payslips\/([0-9a-f-]{36})$/))) return `/payslips/${r[1]}`;
  if ((r = m(/^\/helpdesk\/([0-9a-f-]{36})$/))) return `/helpdesk/${r[1]}`;
  if ((r = m(/^\/announcements\/([0-9a-f-]{36})$/))) return `/announcements/${r[1]}`;
  if (path === '/approvals' || link.includes('view=approvals')) return '/approvals';
  if (path.startsWith('/leave')) return '/leave';
  if (path.startsWith('/attendance')) return '/attendance';
  if (path.startsWith('/payslips')) return '/me';
  if (path.startsWith('/helpdesk')) return '/helpdesk';
  return null;
}
