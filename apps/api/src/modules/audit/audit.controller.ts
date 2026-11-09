import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { paginationQuery } from '@crew/contracts';
import { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { csv } from '../payroll/payroll-common';
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
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit:read')
  @Doc({ summary: 'Search the audit trail (newest first)', query: auditQuery })
  list(@Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>) {
    return this.db.tenant(async (tx) => {
      const rows = await search(tx, q, q.limit + 1);
      return page(rows, q.limit, (r) => Number(r.seq));
    });
  }

  @Get('export.csv')
  @RequirePermission('audit:read')
  @RequireFeature('audit_export')
  @Doc({ summary: 'Download the audit trail as CSV with the same filters as the search (newest first, up to 50,000 events; the export itself is audited)', query: auditQuery })
  async exportCsv(@Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>, @Res() res: Response) {
    const content = await this.db.tenant(async (tx) => {
      const rows = await search(tx, { ...q, cursor: undefined }, EXPORT_MAX);
      await this.audit.record(tx, { action: 'audit.exported', resourceType: 'audit_events', metadata: { rows: rows.length, action: q.action ?? null, resourceType: q.resourceType ?? null, from: q.from ?? null, to: q.to ?? null } });
      return BOM + csv([
        ['Sequence', 'When (UTC)', 'Actor type', 'Actor', 'Action', 'Resource type', 'Resource id', 'IP address', 'Request id', 'Changes', 'Hash'],
        ...rows.map((r) => [r.seq, new Date(r.createdAt).toISOString(), r.actorType, r.actorLabel, r.action, r.resourceType, r.resourceId, r.ip, r.requestId, r.changes ? JSON.stringify(r.changes) : '', r.hash]),
      ]);
    });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="audit-trail-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('cache-control', 'no-store');
    res.send(content);
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

const EXPORT_MAX = 50_000;
const BOM = String.fromCharCode(0xfeff);

interface AuditRow {
  id: string; seq: number; actorType: string; actorId: string | null; actorLabel: string | null; action: string; resourceType: string | null;
  resourceId: string | null; changes: unknown; ip: string | null; requestId: string | null; createdAt: string; hash: string;
}

function search(tx: Tx, q: z.infer<typeof auditQuery>, limit: number) {
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
  params.push(limit);
  return many<AuditRow>(
    tx,
    `select id::text, chain_seq as seq, actor_type as "actorType", actor_id as "actorId", actor_label as "actorLabel", action,
            resource_type as "resourceType", resource_id as "resourceId", changes, metadata, host(ip) as ip, request_id as "requestId",
            created_at as "createdAt", encode(hash, 'hex') as hash
       from audit_events where ${where.join(' and ')} order by chain_seq desc limit $${params.length}`,
    params,
  );
}
