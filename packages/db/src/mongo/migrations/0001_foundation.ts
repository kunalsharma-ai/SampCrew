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
          required: ['_id', 'tenantId', 'chainSeq', 'actorType', 'action', 'resourceType', 'changes', 'metadata', 'createdAt', 'prevHash', 'hash'],
          properties: {
            _id: uuid,
            tenantId: nullable(uuid),
            chainSeq: { bsonType: ['int', 'long'], minimum: 1 },
            actorType: { enum: ['user', 'platform_admin', 'system', 'ai_agent', 'integration'] },
            actorId: nullable(uuid),
            action: { bsonType: 'string', pattern: '^[a-z_]+(\\.[a-z_]+)+$' },
            resourceType: { bsonType: 'string', minLength: 1 },
            resourceId: nullable({ bsonType: 'string' }),
            changes: { bsonType: 'object' },
            metadata: { bsonType: 'object' },
            createdAt: { bsonType: 'date' },
            prevHash: nullable({ bsonType: 'string', pattern: '^[0-9a-f]{64}$' }),
            hash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
          },
        },
      },
      indexes: [
        { key: { tenantId: 1, chainSeq: 1 }, options: { name: 'audit_events_chain', unique: true } },
        { key: { tenantId: 1, createdAt: -1 }, options: { name: 'audit_events_tenant_time' } },
        { key: { tenantId: 1, resourceType: 1, resourceId: 1 }, options: { name: 'audit_events_resource' } },
        { key: { tenantId: 1, actorId: 1 }, options: { name: 'audit_events_actor' } },
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
