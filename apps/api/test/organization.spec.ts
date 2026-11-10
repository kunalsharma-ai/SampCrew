import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPool, api, createApp, createTenant, login, type TestDb, type TestTenant } from './helpers';

describe('organization structure updates', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let token: string;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    token = (await login(app, t.ownerEmail)).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('PATCH leaves omitted fields alone instead of resetting them to defaults', async () => {
    const http = api(app, token);
    const loc = await http.post('/org/locations').send({ name: 'Chakan Plant', legalEntityId: t.legalEntityId, timezone: 'Asia/Kolkata', countryCode: 'IN', kind: 'factory' });
    expect(loc.status).toBe(201);
    const renamed = await http.patch(`/org/locations/${loc.body.id}`).send({ name: 'Chakan Plant 2' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Chakan Plant 2', kind: 'factory' });

    const le = await http.post('/org/legal-entities').send({ name: 'Calendar Co', countryCode: 'GB', currency: 'GBP', timezone: 'Europe/London', fiscalYearStartMonth: 1 });
    expect(le.status).toBe(201);
    const leRenamed = await http.patch(`/org/legal-entities/${le.body.id}`).send({ name: 'Calendar Co Ltd' });
    expect(leRenamed.body.fiscalYearStartMonth).toBe(1);
  });

  it('PATCH rejects unknown fields and still enforces cross-field rules in the database', async () => {
    const http = api(app, token);
    const loc = await http.post('/org/locations').send({ name: 'Depot', legalEntityId: t.legalEntityId, timezone: 'Asia/Kolkata', countryCode: 'IN' });
    const unknown = await http.patch(`/org/locations/${loc.body.id}`).send({ tenantId: '00000000-0000-0000-0000-000000000000' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('validation_failed');
    const geofenceWithoutCoords = await http.patch(`/org/locations/${loc.body.id}`).send({ geofenceRadiusM: 100 });
    expect(geofenceWithoutCoords.status).toBe(422);
    expect(geofenceWithoutCoords.body.error.code).toBe('constraint_violation');
  });
});
