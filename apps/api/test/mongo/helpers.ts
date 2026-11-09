import { randomUUID } from 'node:crypto';
import { mongo } from '@crew/db';
import type { AppConfig } from '../../src/platform/config/config';
import { MongoService } from '../../src/platform/database/mongo.service';

/** Collections registered only for these tests, one of each kind. */
export const TEST_RULES: Record<string, mongo.CollectionRule> = {
  ...mongo.COLLECTION_RULES,
  t_items: { scope: 'tenant' },
  t_tags: { scope: 'tenant' },
  t_nodes: { scope: 'tenant' },
  t_memberships: { scope: 'tenant', userField: 'user_id' },
  t_plans: { scope: 'shared' },
  t_secrets: { scope: 'platform' },
};

export function mongoService(): MongoService {
  const svc = new MongoService({ MONGODB_URL: process.env.MONGODB_URL, MONGODB_POOL_MAX: 20 } as AppConfig);
  svc.rules = TEST_RULES;
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
