import { Controller, Get, Query } from '@nestjs/common';
import { paginationQuery } from '@crew/contracts';
import { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { DatabaseService, many, one } from '../../platform/database/database.service';
import { decodeCursor, page } from '../../platform/http/pagination';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';

const auditQuery = paginationQuery.extend({
  action: z.string().max(80).optional(),
  resourceType: z.string().max(40).optional(),
  resourceId: z.string().max(80).optional(),
  actorId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

@Controller('audit-events')
export class AuditController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @RequirePermission('audit:read')
  @Doc({ summary: 'Search the audit trail (newest first)', query: auditQuery })
  list(@Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>) {
    return this.db.tenant(async (tx) => {
      const where: string[] = ['true'];
      const params: unknown[] = [];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (q.action) add('action like ?', `${q.action}%`);
      if (q.resourceType) add('resource_type = ?', q.resourceType);
      if (q.resourceId) add('resource_id = ?', q.resourceId);
      if (q.actorId) add('actor_id = ?', q.actorId);
      if (q.from) add('created_at >= ?', q.from);
      if (q.to) add('created_at <= ?', q.to);
      if (q.q) add(`(actor_label ilike ? or action ilike $${params.length + 1})`, `%${q.q}%`);
      if (q.q) params.push(`%${q.q}%`);
      const cursor = decodeCursor(q.cursor);
      if (cursor) add('chain_seq < ?', Number(cursor[0]));
      params.push(q.limit + 1);
      const rows = await many<{ id: string; seq: number }>(
        tx,
        `select id::text, chain_seq as seq, actor_type as "actorType", actor_id as "actorId", actor_label as "actorLabel", action,
                resource_type as "resourceType", resource_id as "resourceId", changes, metadata, host(ip) as ip, request_id as "requestId",
                created_at as "createdAt", encode(hash, 'hex') as hash
           from audit_events where ${where.join(' and ')} order by chain_seq desc limit $${params.length}`,
        params,
      );
      return page(rows, q.limit, (r) => Number(r.seq));
    });
  }

  @Get('verify')
  @RequirePermission('audit:read')
  @Doc({ summary: 'Recompute the tamper-evident hash chain for this workspace' })
  verify() {
    return this.db.tenant(async (tx) => {
      const r = await one<{ checked: string; first_broken_seq: string | null }>(tx, 'select * from audit_verify_chain(app_tenant_id())');
      return { checked: Number(r!.checked), intact: r!.first_broken_seq === null, firstBrokenSeq: r!.first_broken_seq ? Number(r!.first_broken_seq) : null, verifiedAt: new Date().toISOString() };
    });
  }
}
