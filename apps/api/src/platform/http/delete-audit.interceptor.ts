import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { from, mergeMap, type Observable } from 'rxjs';
import { AuditService } from '../audit/audit.service';
import { MongoService as DatabaseService } from '../database/mongo.service';

/** Set by AuthGuard on a request that is a delete action and passed the permission and password checks. */
export interface CrewDelete {
  realm: 'workspace' | 'console';
  area: string;
  label: string;
}

/**
 * Writes every delete that ran to the audit trail (delete.performed): what was deleted, which area, the route and
 * its ids, and that the person confirmed with their password. Modules keep their own detailed audit entries too; this
 * one is the same for every delete, so the trail can be filtered for deletes alone. A failure to record never changes
 * the answer the person gets.
 */
@Injectable()
export class DeleteAuditInterceptor implements NestInterceptor {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request & { crewDelete?: CrewDelete }>();
    return next.handle().pipe(mergeMap((body) => from(this.record(req).then(() => body))));
  }

  private async record(req: Request & { crewDelete?: CrewDelete }) {
    const del = req.crewDelete;
    if (!del) return;
    const params = Object.fromEntries(Object.entries(req.params ?? {}).map(([k, v]) => [k, String(v).slice(0, 100)]));
    const ids = Object.values(params);
    const entry = {
      action: 'delete.performed', resourceType: del.area, resourceId: ids.length ? ids[ids.length - 1]! : null,
      metadata: { what: del.label, area: del.area, method: req.method, route: req.route?.path ?? req.path, params, reauthenticated: true },
    };
    const write = del.realm === 'console'
      ? this.db.platform((tx) => this.audit.record(tx, { ...entry, tenantId: null }))
      : this.db.tenant((tx) => this.audit.record(tx, entry));
    await write.catch(() => undefined);
  }
}
