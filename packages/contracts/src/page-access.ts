import { z } from 'zod';

/**
 * Page access chosen when an employee is registered (issue #86): which of the everyday pages the new login opens.
 * Each choice switches one or more pages (FEATURE_PARTS keys); the ones left unticked are withheld for that person
 * only, and HR can change them later under Employee features. The pages that matter on day one are ticked by default.
 */
export const PAGE_ACCESS_CHOICES = [
  { key: 'attendance', label: 'Attendance (own and team attendance)', parts: ['attendance_basic.mine', 'attendance_basic.team'], default: true },
  { key: 'leave', label: 'Leave and holidays', parts: ['leave.requests'], default: true },
  { key: 'announcements', label: 'Announcements', parts: ['announcements.read'], default: true },
  { key: 'signature', label: 'Email signature', parts: ['email_signatures.mine'], default: true },
  { key: 'communication', label: 'Communication and Ask HR', parts: ['helpdesk.communication'], default: false },
  { key: 'payslips', label: 'Payslips', parts: ['payroll.payslips'], default: false },
  { key: 'expenses', label: 'Expenses', parts: ['expenses.claims'], default: false },
  { key: 'appraisal', label: 'Appraisal, goals and reviews', parts: ['performance.my_appraisal', 'performance.goals', 'performance.reviews'], default: false },
  { key: 'learning', label: 'My learning', parts: ['learning.mine'], default: false },
  { key: 'assets', label: 'My assets', parts: ['asset_management.mine'], default: false },
  { key: 'recognition', label: 'Recognition and surveys', parts: ['engagement.recognition', 'engagement.surveys'], default: false },
] as const;

export type PageAccessKey = (typeof PAGE_ACCESS_CHOICES)[number]['key'];
export const PAGE_ACCESS_KEYS = PAGE_ACCESS_CHOICES.map((c) => c.key) as unknown as readonly [PageAccessKey, ...PageAccessKey[]];
export const DEFAULT_PAGE_ACCESS: PageAccessKey[] = PAGE_ACCESS_CHOICES.filter((c) => c.default).map((c) => c.key);

/** The page keys withheld when only `given` are ticked. */
export function withheldPages(given: readonly string[]): string[] {
  const on = new Set(given);
  return PAGE_ACCESS_CHOICES.filter((c) => !on.has(c.key)).flatMap((c) => [...c.parts]).sort();
}

export const pageAccessInput = z.object({ pages: z.array(z.enum(PAGE_ACCESS_KEYS)).max(20) }).strict();
export type PageAccessInput = z.infer<typeof pageAccessInput>;
/** A person's page access: the choices on (null without a login) and whether the viewer may change them. */
export interface PageAccessView { pages: PageAccessKey[] | null; canEdit: boolean }
