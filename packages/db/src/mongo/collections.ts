/**
 * Who may reach each collection, replacing PostgreSQL row-level security.
 *
 *  - tenant:   every document carries `tenant_id`. Through a workspace transaction, reads only ever see the current
 *              workspace's documents and writes can only create or change them (apps/api MongoService).
 *  - shared:   reference data with no owner workspace (e.g. the plan catalogue). Read-only from a workspace.
 *  - platform: SAMPLEDGE-internal (Super Admin, chain heads). Never reachable from a workspace transaction.
 *
 * `userField` lets the pre-workspace user transaction (listing your own workspaces) read a tenant collection, limited
 * to documents whose field equals the signed-in user. `tenantWritable: false` keeps a collection read-only from a
 * workspace even though it is tenant-owned (the audit trail is written only through appendAuditEvent).
 *
 * A collection that is not listed here cannot be used from a workspace or user transaction at all, so each module PR
 * registers its collections here together with their migration.
 */
export type CollectionScope = 'tenant' | 'shared' | 'platform';

export interface CollectionRule {
  scope: CollectionScope;
  userField?: string;
  tenantWritable?: boolean;
}

export const COLLECTION_RULES: Record<string, CollectionRule> = {
  audit_events: { scope: 'tenant', tenantWritable: false },
  audit_heads: { scope: 'platform' },
};

export function collectionRule(name: string, rules: Record<string, CollectionRule> = COLLECTION_RULES): CollectionRule | undefined {
  return Object.prototype.hasOwnProperty.call(rules, name) ? rules[name] : undefined;
}
