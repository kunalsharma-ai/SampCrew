import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { HealthController } from '../../src/modules/health/health.controller';
import type { AppConfig } from '../../src/platform/config/config';
import type { DatabaseService } from '../../src/platform/database/database.service';
import { MongoService } from '../../src/platform/database/mongo.service';
import { mongoService } from './helpers';

const postgresUp = { pool: { query: async () => ({ rows: [] }) } } as unknown as DatabaseService;

describe('Readiness with MongoDB', () => {
  it('reports MongoDB once it is configured', async () => {
    const mongo = mongoService();
    try {
      const r = await new HealthController(postgresUp, mongo).ready();
      expect(r.status).toBe('ok');
      expect(r).toHaveProperty('mongodb.latencyMs');
    } finally {
      await mongo.onModuleDestroy();
    }
  });

  it('is not ready when configured MongoDB cannot be reached', async () => {
    const mongo = new MongoService({ MONGODB_URL: 'mongodb://127.0.0.1:1/crew_test?replicaSet=rs0&serverSelectionTimeoutMS=300', MONGODB_POOL_MAX: 2 } as AppConfig);
    await expect(new HealthController(postgresUp, mongo).ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await mongo.onModuleDestroy();
  });

  it('leaves readiness to PostgreSQL alone while MongoDB is not configured', async () => {
    const mongo = new MongoService({ MONGODB_POOL_MAX: 2 } as AppConfig);
    const r = await new HealthController(postgresUp, mongo).ready();
    expect(r).not.toHaveProperty('mongodb');
    await expect(mongo.tenant(async () => 1, { tenantId: 'x' })).rejects.toThrow(/not configured/);
  });
});
