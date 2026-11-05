import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { catchError, from, map, type Observable, of, switchMap, throwError } from 'rxjs';
import { sha256 } from '../auth/crypto';
import { requestContext } from '../context/request-context';
import { DatabaseService, one } from '../database/database.service';
import { Errors } from './errors';

/**
 * Honors the Idempotency-Key header on POST requests from tenant users (mobile apps and integrations retry
 * on flaky networks). The first response is stored; a retry with the same key and body replays it; reuse
 * of a key with a different body is rejected.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly db: DatabaseService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = req.headers['idempotency-key'];
    const actor = requestContext.get()?.actor;
    if (req.method !== 'POST' || typeof key !== 'string' || actor?.kind !== 'user') return next.handle();
    if (key.length < 8 || key.length > 128) throw Errors.badRequest('invalid_idempotency_key', 'Idempotency-Key must be 8 to 128 characters');
    const requestHash = sha256(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}`);
    const res = ctx.switchToHttp().getResponse<Response>();

    return from(
      this.db.tenant((tx) =>
        one<{ request_hash: string; response_status: number | null; response_body: unknown }>(
          tx,
          'select request_hash, response_status, response_body from idempotency_keys where actor_id = $1 and key = $2',
          [actor.userId, key],
        ),
      ),
    ).pipe(
      switchMap((existing) => {
        if (existing) {
          if (existing.request_hash !== requestHash) throw Errors.conflict('idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
          if (existing.response_status === null) throw Errors.conflict('request_in_progress', 'A request with this Idempotency-Key is still being processed');
          res.status(existing.response_status);
          res.setHeader('idempotent-replayed', 'true');
          return of(existing.response_body);
        }
        return from(
          this.db.tenant((tx) =>
            tx.query('insert into idempotency_keys (tenant_id, key, actor_id, request_hash) values ($1, $2, $3, $4)', [actor.tenantId, key, actor.userId, requestHash]),
          ),
        ).pipe(
          switchMap(() => next.handle()),
          switchMap((body) =>
            from(
              this.db.tenant((tx) =>
                tx.query('update idempotency_keys set response_status = $3, response_body = $4 where actor_id = $1 and key = $2', [actor.userId, key, res.statusCode, JSON.stringify(body ?? null)]),
              ),
            ).pipe(map(() => body)),
          ),
          catchError((err) =>
            from(this.db.tenant((tx) => tx.query('delete from idempotency_keys where actor_id = $1 and key = $2', [actor.userId, key]))).pipe(
              switchMap(() => throwError(() => err)),
            ),
          ),
        );
      }),
    );
  }
}
