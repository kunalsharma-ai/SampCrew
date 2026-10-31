/** Formats a decimal string as money with two decimals, without converting through floating point. */
export function amount(value: string | null | undefined, currency?: string | null) {
  if (value === null || value === undefined || value === '') return '';
  const neg = value.startsWith('-');
  const [whole, frac = ''] = value.replace('-', '').split('.');
  const grouped = currency === 'INR' ? whole!.replace(/(\d)(?=(\d\d)+\d$)/g, '$1,') : whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency ? `${currency} ` : ''}${neg ? '-' : ''}${grouped}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

/** "1.50" -> "1.5", "27.00" -> "27" */
export const days = (v: string | null | undefined) => (v ?? '0').replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

export const RUN_STATUS: Record<string, string> = { draft: 'Draft', computed: 'Computed', pending_approval: 'Waiting for approval', finalised: 'Finalised', cancelled: 'Cancelled' };
export const RUN_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = { draft: 'neutral', computed: 'info', pending_approval: 'warning', finalised: 'success', cancelled: 'neutral' };
export const CLAIM_STATUS: Record<string, string> = { pending: 'Waiting for approval', approved: 'Approved, to be paid', rejected: 'Rejected', cancelled: 'Withdrawn', paid: 'Paid' };
export const CLAIM_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = { pending: 'warning', approved: 'info', rejected: 'danger', cancelled: 'neutral', paid: 'success' };
export const CALC: Record<string, string> = { fixed: 'Fixed amount a year', percent_of_ctc: '% of CTC', percent_of_basic: '% of Basic', balance: 'Balance of CTC' };
export const LINE_KIND: Record<string, string> = { earning: 'Earnings', deduction: 'Deductions', reimbursement: 'Reimbursements', employer: 'Employer contributions (not paid to you)' };

/** value x n for a decimal string, exactly (BigInt paise). */
export function times(value: string, n: number) {
  const [w, f = ''] = value.split('.');
  const p = BigInt(w!) * 100n + BigInt(f.padEnd(2, '0').slice(0, 2)) * (w!.startsWith('-') ? -1n : 1n);
  const r = p * BigInt(n);
  const a = r < 0n ? -r : r;
  return `${r < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}
