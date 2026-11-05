import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../context/request-context';

/** Establishes the per-request context (request id, client ip, user agent) used by logging, auditing and RLS. */
export function contextMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', requestId);
  requestContext.run({ requestId, ip: req.ip, userAgent: req.headers['user-agent'] }, () => next());
}
