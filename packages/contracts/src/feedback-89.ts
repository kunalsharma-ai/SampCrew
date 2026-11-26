import { z } from 'zod';

/**
 * Issue #89 (feedback of 26 November 2026, "Issues Identified in HR Admin and Employee Roles 3"): shared rules for
 * the automatic sign-out time, the company work email domain and the Add Employee form fields.
 */

// Automatic sign-out (point 4) ---------------------------------------------------------------------------------------

/** Minutes of inactivity after which everyone is signed out; 0 is off. Only the Super Workspace changes it. */
export const SESSION_IDLE_CHOICES = [0, 15, 30, 60, 120, 240, 480, 720] as const;
export const sessionPolicyInput = z.object({
  idleMinutes: z.number().int().refine((v) => (SESSION_IDLE_CHOICES as readonly number[]).includes(v), 'Choose one of the listed times'),
});
export type SessionPolicyInput = z.infer<typeof sessionPolicyInput>;
export function idleLabel(minutes: number | null | undefined): string {
  if (!minutes) return 'Never (stay signed in)';
  if (minutes < 60) return `After ${minutes} minutes of inactivity`;
  const h = minutes / 60;
  return `After ${h} ${h === 1 ? 'hour' : 'hours'} of inactivity`;
}
