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
  forbidden: (message = 'You do not have permission to do that') => new AppError(HttpStatus.FORBIDDEN, 'forbidden', message),
  mfaRequired: () => new AppError(HttpStatus.FORBIDDEN, 'mfa_required', 'This action needs multi-factor authentication. Verify with your authenticator app and try again.'),
  featureNotInPlan: (feature: string) => new AppError(HttpStatus.PAYMENT_REQUIRED, 'feature_not_in_plan', `Your plan does not include ${feature}. Upgrade to use it.`, { feature }),
  notFound: (what = 'Resource') => new AppError(HttpStatus.NOT_FOUND, 'not_found', `${what} not found`),
  conflict: (code: string, message: string) => new AppError(HttpStatus.CONFLICT, code, message),
  validation: (details: unknown) => new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'validation_failed', 'Some fields need attention', details),
  badRequest: (code: string, message: string) => new AppError(HttpStatus.BAD_REQUEST, code, message),
  limitReached: (limit: string, value: number) => new AppError(HttpStatus.PAYMENT_REQUIRED, 'plan_limit_reached', `Your plan allows ${value} ${limit}. Upgrade to add more.`, { limit, value }),
  tenantSuspended: () => new AppError(HttpStatus.FORBIDDEN, 'tenant_suspended', 'This workspace is suspended. Contact your administrator or SAMPLEDGE support.'),
  unavailable: (code: string, message: string) => new AppError(HttpStatus.SERVICE_UNAVAILABLE, code, message),
  tooMany: (message = 'Too many attempts. Try again later.') => new AppError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', message),
};
