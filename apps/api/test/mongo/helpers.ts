import { randomUUID } from 'node:crypto';
import { mongo } from '@crew/db';
import type { AppConfig } from '../../src/platform/config/config';
import { MongoService } from '../../src/platform/database/mongo.service';

const tenantTable = (columns: Record<string, mongo.ColumnSpec>, extra: Partial<mongo.TableSpec> = {}): mongo.TableSpec => ({
  access: 'tenant',
  grants: ['select', 'insert', 'update', 'delete'],
  columns: { id: { type: 'string', required: true }, tenant_id: { type: 'uuid', required: true }, ...columns },
  unique: [],
  fks: [],
  indexes: [],
  checks: [],
  ...extra,
});

/** Tables registered only for these tests, one of each kind, next to the real schema. */
export const TEST_TABLES: Record<string, mongo.TableSpec> = {
  ...mongo.TABLES,
  t_items: tenantTable({ name: { type: 'string' }, plan_key: { type: 'string' }, tag_id: { type: 'string' }, touched: { type: 'bool' }, days: { type: 'int' } }),
  t_tags: tenantTable({ label: { type: 'string' } }),
  t_nodes: tenantTable({ parent: { type: 'string' } }),
  t_memberships: { ...tenantTable({ user_id: { type: 'uuid', required: true }, role: { type: 'string' } }), access: 'tenant_or_user' },
  t_plans: { access: 'shared', grants: ['select'], columns: { id: { type: 'string', required: true }, name: { type: 'string' } }, unique: [], fks: [], indexes: [], checks: [] },
  t_secrets: { access: 'platform', grants: [], columns: { id: { type: 'string', required: true }, value: { type: 'string' } }, unique: [], fks: [], indexes: [], checks: [] },
};

export function mongoService(): MongoService {
  const svc = new MongoService({ MONGODB_URL: process.env.MONGODB_URL, MONGODB_POOL_MAX: 20 } as AppConfig);
  svc.tables = TEST_TABLES;
  return svc;
}

export const id = () => randomUUID();

/** An audit event; without `tenant_id` it takes the transaction's workspace (pass null for a platform event). */
export function auditInput(over: Partial<mongo.AuditEventInput> = {}): mongo.AuditEventInput {
  return {
    actor_type: 'system',
    actor_id: null,
    actor_label: 'test',
    action: 'test.event',
    resource_type: 'test',
    resource_id: null,
    changes: {},
    metadata: {},
    ip: null,
    user_agent: null,
    request_id: null,
    ...over,
  } as mongo.AuditEventInput;
}
