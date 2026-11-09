import type { MongoMigration } from '../migrator';

const uuid = { bsonType: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const nullable = (schema: Record<string, unknown>) => ({ oneOf: [schema, { bsonType: 'null' }] });

/**
 * Foundation: the tamper-evident audit trail. Every other collection arrives with the module that owns it.
 * Ids are UUID strings (not ObjectIds) so ids in API responses, URLs and tests stay as they were on PostgreSQL.
 */
export const m0001Foundation: MongoMigration = {
  name: '0001_foundation',
  collections: [
    {
      name: 'audit_events',
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['_id', 'tenant_id', 'chain_seq', 'actor_type', 'action', 'resource_type', 'changes', 'metadata', 'created_at', 'prev_hash', 'hash'],
          properties: {
            _id: uuid,
            tenant_id: nullable(uuid),
            chain_seq: { bsonType: ['int', 'long'], minimum: 1 },
            actor_type: { enum: ['user', 'platform_admin', 'system', 'ai_agent', 'integration'] },
            actor_id: nullable(uuid),
            action: { bsonType: 'string', pattern: '^[a-z_]+(\\.[a-z_]+)+$' },
            resource_type: { bsonType: 'string', minLength: 1 },
            resource_id: nullable({ bsonType: 'string' }),
            changes: { bsonType: 'object' },
            metadata: { bsonType: 'object' },
            created_at: { bsonType: 'date' },
            prev_hash: nullable({ bsonType: 'string', pattern: '^[0-9a-f]{64}$' }),
            hash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
          },
        },
      },
      indexes: [
        { key: { tenant_id: 1, chain_seq: 1 }, options: { name: 'audit_events_chain', unique: true } },
        { key: { tenant_id: 1, created_at: -1 }, options: { name: 'audit_events_tenant_time' } },
        { key: { tenant_id: 1, resource_type: 1, resource_id: 1 }, options: { name: 'audit_events_resource' } },
        { key: { tenant_id: 1, actor_id: 1 }, options: { name: 'audit_events_actor' } },
      ],
    },
    {
      name: 'audit_heads',
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['_id', 'seq', 'hash'],
          properties: {
            _id: uuid,
            seq: { bsonType: ['int', 'long'], minimum: 0 },
            hash: nullable({ bsonType: 'string', pattern: '^[0-9a-f]{64}$' }),
          },
        },
      },
    },
  ],
};
