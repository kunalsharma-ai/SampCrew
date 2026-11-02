import { Injectable } from '@nestjs/common';
import { requestContext } from '../context/request-context';
import { deferUntilCommit, type Tx } from '../database/database.service';

export interface AuditInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  changes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Override for platform events or events written on behalf of a tenant by the platform. */
  tenantId?: string | null;
}

const REDACT = /password|secret|token|hash|bank|account_number|pan|aadhaar|ssn|tax_?id|national_?id/i;

/** Removes secrets and sensitive identifiers from change sets before they are written to the audit trail. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, REDACT.test(k) ? '[redacted]' : redact(v)]));
  }
  return value;
}

/** Builds a { field: { from, to } } diff for changed keys only. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    const a = before[key] ?? null;
    const b = after[key] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = { from: a, to: b };
  }
  return out;
}

/**
 * Writes to the append-only, hash-chained audit_events table inside the caller's transaction, so the audit
 * record commits or rolls back together with the change it describes. The row is inserted just before commit.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, input: AuditInput): Promise<void> {
    const ctx = requestContext.get();
    const actor = ctx?.actor;
    const tenantId = input.tenantId !== undefined ? input.tenantId : actor?.kind === 'user' ? actor.tenantId : null;
    const actorType = actor?.kind ?? 'system';
    const actorId = actor?.kind === 'user' ? actor.userId : actor?.kind === 'platform_admin' ? actor.adminId : null;
    // Everything about the event is captured now (who, from where); only the insert waits for the end of the
    // transaction, so the audit-chain lock is the last lock it takes (see deferUntilCommit).
    const insert = () => tx.query(
      `insert into audit_events (tenant_id, actor_type, actor_id, actor_label, action, resource_type, resource_id, changes, metadata, ip, user_agent, request_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        tenantId,
        actorType,
        actorId,
        actor?.label ?? 'system',
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        JSON.stringify(redact(input.changes ?? {})),
        JSON.stringify(redact(input.metadata ?? {})),
        ctx?.ip ?? null,
        ctx?.userAgent?.slice(0, 400) ?? null,
        ctx?.requestId ?? null,
      ],
    ).then(() => undefined);
    if (!deferUntilCommit(tx, insert)) await insert();
  }
}
