import { HttpException, HttpStatus } from '@nestjs/common';

/** Application error with a stable machine-readable code, rendered as { error: { code, message } }. */
export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const Errors = {
  unauthorized: (message = 'Sign in to continue') => new AppError(HttpStatus.UNAUTHORIZED, 'unauthorized', message),
  /** A refusal with its own code (for example exceeds_parent), so screens can explain it. */
  forbiddenCode: (code: string, message: string, details?: unknown) => new AppError(HttpStatus.FORBIDDEN, code, message, details),
  forbidden: (message = 'You do not have permission to do that') => new AppError(HttpStatus.FORBIDDEN, 'forbidden', message),
  /** A delete needs the person's password, typed just before it (POST /me/delete-confirmation), and was sent without it. */
  deletePasswordRequired: (what: string) => new AppError(HttpStatus.FORBIDDEN, 'delete_password_required', `Enter your password to delete this (${what}).`),
  /** The level above has not given this person permission to delete in this area. */
  deleteNotPermitted: (message: string) => new AppError(HttpStatus.FORBIDDEN, 'delete_not_permitted', message),
  mfaRequired: () => new AppError(HttpStatus.FORBIDDEN, 'mfa_required', 'This action needs multi-factor authentication. Verify with your authenticator app and try again.'),
  passwordChangeRequired: () => new AppError(HttpStatus.FORBIDDEN, 'password_change_required', 'Choose a new password before you continue. Yours was set by another admin.'),
  featureSwitchedOff: (feature: string) => new AppError(HttpStatus.FORBIDDEN, 'feature_disabled', `${feature} is switched off for this workspace by SAMPLEDGE.`, { feature }),
  featureSwitchedOffByAdmin: (feature: string) => new AppError(HttpStatus.FORBIDDEN, 'feature_switched_off', `${feature} is switched off in this workspace. An administrator can switch it on in HR Workspace Admin.`, { feature }),
  featureNotForMember: (feature: string) => new AppError(HttpStatus.FORBIDDEN, 'feature_not_for_member', `You do not have access to ${feature} in this workspace.`, { feature }),
  featureNotForHrWorkspace: (feature: string) => new AppError(HttpStatus.FORBIDDEN, 'feature_not_for_hr_workspace', `${feature} is not given to your HR Workspace. Ask your company's administrators.`, { feature }),
  featureOffByPlatform: (feature: string) => new AppError(HttpStatus.FORBIDDEN, 'feature_off_by_platform', `${feature} is switched off by SAMPLEDGE for now.`, { feature }),
  featureOffForLevel: (feature: string) => new AppError(HttpStatus.FORBIDDEN, 'feature_off_for_level', `${feature} is switched off for your workspace access level by your company's Super Workspace.`, { feature }),
  featureOffForEmployees: (feature: string) => new AppError(HttpStatus.FORBIDDEN, 'feature_off_for_employees', `${feature} is switched off for Employee Workspace by your HR team.`, { feature }),
  featureNotInPlan: (feature: string) => new AppError(HttpStatus.PAYMENT_REQUIRED, 'feature_not_in_plan', `Your plan does not include ${feature}. Upgrade to use it.`, { feature }),
  notFound: (what = 'Resource') => new AppError(HttpStatus.NOT_FOUND, 'not_found', `${what} not found`),
  conflict: (code: string, message: string) => new AppError(HttpStatus.CONFLICT, code, message),
  validation: (details: unknown) => new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'validation_failed', 'Some fields need attention', details),
  badRequest: (code: string, message: string) => new AppError(HttpStatus.BAD_REQUEST, code, message),
  limitReached: (limit: string, value: number) => new AppError(HttpStatus.PAYMENT_REQUIRED, 'plan_limit_reached', `Your plan allows ${value} ${limit}. Upgrade to add more.`, { limit, value }),
  appSwitchedOff: (client: 'web' | 'mobile') => new AppError(HttpStatus.FORBIDDEN, 'app_switched_off', client === 'mobile'
    ? 'The SampCrew mobile app is switched off for this workspace by SAMPLEDGE. Use the Web Portal, or ask your administrator.'
    : 'The SampCrew Web Portal is switched off for this workspace by SAMPLEDGE. Use the mobile app, or ask your administrator.', { client }),
  featureOffInApp: (feature: string, client: string) => new AppError(HttpStatus.FORBIDDEN, 'feature_off_in_app', `${feature} is switched off in the ${client === 'mobile' ? 'mobile app' : 'Web Portal'} for this workspace by SAMPLEDGE.`, { feature, client }),
  mobileModuleOff: (module: string) => new AppError(HttpStatus.FORBIDDEN, 'mobile_module_off', `${module} is not available in the mobile app. Your company's Super Workspace decides which modules the app shows.`, { module }),
  workspaceLocked: () => new AppError(HttpStatus.PAYMENT_REQUIRED, 'workspace_read_only', 'Your workspace is read-only because an invoice is overdue. You can still view everything; a billing admin can pay on Plan & billing to open it again.'),
  /** Signed out after the inactivity time Super Workspace set (issue #89). */
  sessionIdle: () => new AppError(HttpStatus.UNAUTHORIZED, 'session_idle', 'You were signed out after a period of inactivity. Sign in again.'),
  tenantSuspended: () => new AppError(HttpStatus.FORBIDDEN, 'tenant_suspended', 'This workspace is suspended. Contact your administrator or SAMPLEDGE support.'),
  unavailable: (code: string, message: string) => new AppError(HttpStatus.SERVICE_UNAVAILABLE, code, message),
  tooMany: (message = 'Too many attempts. Try again later.') => new AppError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', message),
  /** A sign-in lock after wrong passwords or codes, with the real time left so people know when to try again. */
  lockedOut: (until: Date, what = 'sign-in attempts') =>
    new AppError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', `Too many failed ${what}. Try again after ${minutesLeft(until)}.`, { retryAt: until.toISOString(), retryInMinutes: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000)) }),
};

/** "30 minutes", "1 minute": the time left on a lock, rounded up. */
export function minutesLeft(until: Date): string {
  const m = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
}
