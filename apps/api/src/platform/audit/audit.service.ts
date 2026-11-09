import { Injectable } from '@nestjs/common';
import { requestContext } from '../context/request-context';
import type { PlatformTx, TenantTx, UserTx } from '../database/mongo.service';

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
 * Appends to the hash-chained audit trail inside the caller's transaction, so the audit record commits or rolls
 * back together with the change it describes. The event is written as the transaction's last step.
 */
@Injectable()
export class AuditService {
  async record(tx: TenantTx | UserTx | PlatformTx, input: AuditInput): Promise<void> {
    const ctx = requestContext.get();
    const actor = ctx?.actor;
    const tenantId = input.tenantId !== undefined ? input.tenantId : actor?.kind === 'user' ? actor.tenantId : null;
    // Everything about the event is captured now (who, from where); only the write waits for the end of the transaction.
    tx.audit({
      tenant_id: tenantId,
      actor_type: actor?.kind ?? 'system',
      actor_id: actor?.kind === 'user' ? actor.userId : actor?.kind === 'platform_admin' ? actor.adminId : null,
      actor_label: actor?.label ?? 'system',
      action: input.action,
      resource_type: input.resourceType,
      resource_id: input.resourceId ?? null,
      changes: redact(input.changes ?? {}) as Record<string, unknown>,
      metadata: redact(input.metadata ?? {}) as Record<string, unknown>,
      ip: ctx?.ip ?? null,
      user_agent: ctx?.userAgent?.slice(0, 400) ?? null,
      request_id: ctx?.requestId ?? null,
    });
  }
}
