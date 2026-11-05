export const REQ_STATUS: Record<string, string> = {
  draft: 'Draft', pending_approval: 'Awaiting approval', approved: 'Approved', open: 'Open', on_hold: 'On hold', filled: 'Filled', closed: 'Closed', cancelled: 'Cancelled', rejected: 'Not approved',
};
export const REQ_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'> = {
  draft: 'neutral', pending_approval: 'warning', approved: 'info', open: 'success', on_hold: 'warning', filled: 'accent', closed: 'neutral', cancelled: 'neutral', rejected: 'danger',
};
export const APP_STATUS: Record<string, string> = { active: 'In process', rejected: 'Rejected', withdrawn: 'Withdrew', hired: 'Hired' };
export const OFFER_STATUS: Record<string, string> = {
  draft: 'Draft', pending_approval: 'Awaiting approval', approved: 'Approved, not sent', sent: 'Sent', accepted: 'Accepted', declined: 'Declined', withdrawn: 'Withdrawn', rejected: 'Not approved',
};
export const SOURCE: Record<string, string> = { career_site: 'Career site', referral: 'Referral', agency: 'Agency', sourced: 'Sourced', manual: 'Added by hand' };
export const WORK_MODE: Record<string, string> = { onsite: 'On site', hybrid: 'Hybrid', remote: 'Remote' };
export const EMPLOYMENT: Record<string, string> = { full_time: 'Full time', part_time: 'Part time', contract: 'Contract', intern: 'Intern', temporary: 'Temporary' };
export const REJECTION: Record<string, string> = {
  not_qualified: 'Not qualified', better_candidate: 'Stronger candidate chosen', salary: 'Salary expectations', location: 'Location', no_show: 'Did not attend',
  withdrew: 'Candidate withdrew', position_closed: 'Position closed', other: 'Other',
};
export const RECOMMENDATION: Record<string, string> = { strong_no: 'Strong no', no: 'No', yes: 'Yes', strong_yes: 'Strong yes' };
export const MODE: Record<string, string> = { video: 'Video call', in_person: 'In person', phone: 'Phone' };
export const STAGE_KIND: Record<string, string> = { new: 'New applications', screen: 'Screening', interview: 'Interview', offer: 'Offer', hired: 'Hired' };
export const EVENT: Record<string, string> = {
  applied: 'Applied', stage_changed: 'Moved', rejected: 'Rejected', withdrawn: 'Withdrew', reopened: 'Reopened', interview_scheduled: 'Interview scheduled',
  interview_cancelled: 'Interview cancelled', feedback_submitted: 'Scorecard submitted', offer_drafted: 'Offer drafted', offer_submitted: 'Offer sent for approval',
  offer_approved: 'Offer approved', offer_rejected: 'Offer not approved', offer_sent: 'Offer sent', offer_accepted: 'Offer accepted', offer_declined: 'Offer declined',
  offer_withdrawn: 'Offer withdrawn', hired: 'Hired', email_queued: 'Email queued', anonymized: 'Personal details erased',
};

export const opts = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }));

/** Formats a decimal string as money without converting through floating point. */
export function money(amount: string | null, currency: string | null) {
  if (amount === null || amount === undefined) return '';
  const [whole, frac] = amount.split('.');
  const grouped = currency === 'INR'
    ? whole!.replace(/(\d)(?=(\d\d)+\d$)/g, '$1,')
    : whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = frac && Number(frac) !== 0 ? `.${frac.padEnd(2, '0')}` : '';
  return `${currency ?? ''} ${grouped}${cents}`.trim();
}

export const range = (min: string | null, max: string | null, currency: string | null) =>
  min && max ? `${money(min, currency)} to ${money(max, null)}` : min ? `From ${money(min, currency)}` : max ? `Up to ${money(max, currency)}` : 'Not set';

export const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const date = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');
