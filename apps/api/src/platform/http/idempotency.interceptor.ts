import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { catchError, from, map, type Observable, of, switchMap, throwError } from 'rxjs';
import { sha256 } from '../auth/crypto';
import { requestContext } from '../context/request-context';
import { MongoService as DatabaseService } from '../database/mongo.service';
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
        tx.collection<{ request_hash: string; response_status: number | null; response_body: unknown }>('idempotency_keys').findOne({ actor_id: actor.userId, key }),
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
          this.db.tenant((tx) => tx.collection('idempotency_keys').insert({ key, actor_id: actor.userId, request_hash: requestHash })).catch((err: { code?: string }) => {
            // Two retries raced: the other one holds the key.
            if (err.code === '23505') throw Errors.conflict('request_in_progress', 'A request with this Idempotency-Key is still being processed');
            throw err;
          }),
        ).pipe(
          switchMap(() => next.handle()),
          switchMap((body) =>
            from(
              this.db.tenant((tx) =>
                tx.collection('idempotency_keys').updateOne({ actor_id: actor.userId, key }, { $set: { response_status: res.statusCode, response_body: JSON.parse(JSON.stringify(body ?? null)) } }),
              ),
            ).pipe(map(() => body)),
          ),
          catchError((err) =>
            from(this.db.tenant((tx) => tx.collection('idempotency_keys').deleteOne({ actor_id: actor.userId, key }))).pipe(
              switchMap(() => throwError(() => err)),
            ),
          ),
        );
      }),
    );
  }
}
