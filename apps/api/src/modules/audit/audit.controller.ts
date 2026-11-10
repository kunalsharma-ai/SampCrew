import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { paginationQuery } from '@crew/contracts';
import { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
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
      const r = await tx.verifyAuditChain();
      return { checked: r.checked, intact: r.firstBrokenSeq === null, firstBrokenSeq: r.firstBrokenSeq, verifiedAt: new Date().toISOString() };
    });
  }
}

const EXPORT_MAX = 50_000;
const BOM = String.fromCharCode(0xfeff);

interface AuditRow {
  id: string; seq: number; actorType: string; actorId: string | null; actorLabel: string | null; action: string; resourceType: string | null;
  resourceId: string | null; changes: unknown; metadata?: unknown; ip: string | null; requestId: string | null; createdAt: string | Date; hash: string;
}

const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function search(tx: TenantTx, q: z.infer<typeof auditQuery>, limit: number): Promise<AuditRow[]> {
  const filter: Record<string, unknown> = {};
  if (q.action) filter.action = { $regex: `^${escape(q.action)}` };
  if (q.resourceType) filter.resource_type = q.resourceType;
  if (q.resourceId) filter.resource_id = q.resourceId;
  if (q.actorId) filter.actor_id = q.actorId;
  if (q.from || q.to) filter.created_at = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(q.to) } : {}) };
  if (q.q) {
    const like = { $regex: escape(q.q), $options: 'i' };
    filter.$or = [{ actor_label: like }, { action: like }];
  }
  const cursor = decodeCursor(q.cursor);
  if (cursor) filter.chain_seq = { $lt: Number(cursor[0]) };
  const rows = await tx.collection('audit_events').find(filter, { sort: { chain_seq: -1 }, limit });
  return rows.map((e) => ({
    id: e.id,
    seq: e.chain_seq,
    actorType: e.actor_type,
    actorId: e.actor_id ?? null,
    actorLabel: e.actor_label ?? null,
    action: e.action,
    resourceType: e.resource_type ?? null,
    resourceId: e.resource_id ?? null,
    changes: e.changes,
    metadata: e.metadata,
    ip: e.ip ?? null,
    requestId: e.request_id ?? null,
    createdAt: e.created_at,
    hash: e.hash,
  }));
}
