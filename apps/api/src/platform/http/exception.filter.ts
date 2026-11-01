import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import { requestContext } from '../context/request-context';

const PG_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  '23505': { status: 409, code: 'already_exists', message: 'A record with these details already exists' },
  '23503': { status: 422, code: 'invalid_reference', message: 'A referenced record does not exist in this workspace' },
  '23514': { status: 422, code: 'constraint_violation', message: 'The change breaks a data rule' },
  '22P02': { status: 422, code: 'invalid_input', message: 'Invalid identifier or value' },
  '42501': { status: 403, code: 'forbidden', message: 'Not permitted' },
  // Raised by the database's own guards on history that cannot change (finalised payroll, released reviews).
  P0001: { status: 409, code: 'locked', message: 'This record is locked and cannot be changed' },
};

/** Renders every error as { error: { code, message, requestId, details? } } and never leaks internals. */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = requestContext.get()?.requestId;

    if (exception instanceof ThrottlerException) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests. Slow down and try again.', requestId } });
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body && 'code' in body) {
        const b = body as { code: string; message: string; details?: unknown };
        return res.status(status).json({ error: { code: b.code, message: b.message, details: b.details, requestId } });
      }
      const message = typeof body === 'string' ? body : ((body as { message?: string }).message ?? exception.message);
      const code = status === 404 ? 'not_found' : status === 405 ? 'method_not_allowed' : 'http_error';
      return res.status(status).json({ error: { code, message: String(message), requestId } });
    }
    const pg = exception as { code?: string; constraint?: string };
    if (pg?.code && PG_ERRORS[pg.code]) {
      const m = PG_ERRORS[pg.code]!;
      return res.status(m.status).json({ error: { code: m.code, message: m.message, details: pg.constraint ? { constraint: pg.constraint } : undefined, requestId } });
    }
    this.logger.error({ requestId, err: exception instanceof Error ? exception.stack : exception });
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: { code: 'internal_error', message: 'Something went wrong on our side. Quote the request id if you contact support.', requestId } });
  }
}
