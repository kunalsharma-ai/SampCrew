import { type INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { CONTROLLERS } from '../src/app.module';
import { PUBLIC_KEY } from '../src/platform/authz/decorators';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttendanceDaysService } from '../src/modules/attendance/attendance-days.service';
import { HrJobsService } from '../src/modules/hr-jobs/hr-jobs.service';
import { AuditService } from '../src/platform/audit/audit.service';
import { loadConfig, productionProblems, resetConfigForTests } from '../src/platform/config/config';
import { MongoService as DatabaseService } from '../src/platform/database/mongo.service';
import { OutboxService } from '../src/platform/events/outbox.service';
import { adminPool, api, createApp, createTenant, login, type TestDb, type TestTenant } from './helpers';

/** Phase 12: what production readiness changed in the API. */
describe('Phase 12 production readiness', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    owner = (await login(app, t.ownerEmail)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  describe('production configuration', () => {
    const good = {
      CREW_ENV: 'production',
      MONGODB_URL: 'mongodb://crew_api:9f1c2b7e4d8a6f3c0b5e1d7a@db1.internal:27017,db2.internal:27017,db3.internal:27017/crew?replicaSet=rs0&authSource=admin',
      WEB_PUBLIC_URL: 'https://crew.acme.test',
      API_PUBLIC_URL: 'https://api.crew.acme.test',
      CORS_ORIGINS: 'https://crew.acme.test,https://console.crew.acme.test',
      MOBILE_SSO_REDIRECTS: 'crew://sso',
      JWT_ACCESS_SECRET: 'q8Zr3VbN1xLk7Pw2Hs9Tf4Jd6Gm0Yc5Ru8Ea3Wn1Ok7Lp2',
      JWT_PLATFORM_SECRET: 'Z2nX7cV4bM9qW1eR6tY3uI8oP5aS0dF2gH7jK4lL9zX1cV6',
      FIELD_ENCRYPTION_KEY: Buffer.from('k'.repeat(16) + 'm'.repeat(16)).toString('base64'),
      REDIS_URL: 'redis://:5b2e8f1a9c4d7e3b6a0f@redis:6379/0',
    };
    const load = (overrides: Record<string, string>) => {
      resetConfigForTests();
      try {
        return loadConfig({ ...good, ...overrides } as NodeJS.ProcessEnv);
      } finally {
        resetConfigForTests();
      }
    };

    it('starts with a complete, safe production configuration', () => {
      expect(load({}).isProductionLike).toBe(true);
    });

    it('refuses plain http, localhost origins, wildcard CORS and http mobile return addresses', () => {
      expect(() => load({ WEB_PUBLIC_URL: 'http://crew.acme.test' })).toThrow(/WEB_PUBLIC_URL must be an https/);
      expect(() => load({ API_PUBLIC_URL: 'http://localhost:4000' })).toThrow(/API_PUBLIC_URL must be an https/);
      expect(() => load({ CORS_ORIGINS: '*' })).toThrow(/not \*/);
      expect(() => load({ CORS_ORIGINS: 'https://crew.acme.test,http://localhost:3000' })).toThrow(/CORS_ORIGINS entry must be an https/);
      expect(() => load({ MOBILE_SSO_REDIRECTS: 'crew://sso,http://localhost:8081/sso' })).toThrow(/MOBILE_SSO_REDIRECTS/);
      // Staging gets the same checks.
      expect(() => load({ CREW_ENV: 'staging', WEB_PUBLIC_URL: 'http://staging.acme.test' })).toThrow(/staging/);
      // Local development is unaffected.
      expect(load({ CREW_ENV: 'local', WEB_PUBLIC_URL: 'http://localhost:3000', CORS_ORIGINS: 'http://localhost:3000' }).isProductionLike).toBe(false);
    });

    it('refuses secrets and passwords still holding template values', () => {
      expect(() => load({ JWT_ACCESS_SECRET: 'change-me-change-me-change-me-change-me-12' })).toThrow(/JWT_ACCESS_SECRET still holds a template value/);
      expect(() => load({ MONGODB_URL: 'mongodb://crew_api:change-me-local-only@mongo:27017/crew?replicaSet=rs0' })).toThrow(/MONGODB_URL needs a database user with a real password/);
      expect(() => load({ MONGODB_URL: 'mongodb://mongo:27017/crew?replicaSet=rs0' })).toThrow(/MONGODB_URL needs a database user/);
      expect(load({ MONGODB_URL: 'mongodb+srv://crew-api:Qm7Xt2Vr9Lp4Nz8K@crew.abc12.mongodb.net/crew?retryWrites=true' }).isProductionLike).toBe(true);
      expect(load({ MONGODB_URL: 'mongodb+srv://crew.abc12.mongodb.net/crew?authMechanism=MONGODB-X509&tls=true' }).isProductionLike).toBe(true);
      expect(() => load({ REDIS_URL: 'redis://:changeme@redis:6379' })).toThrow(/REDIS_URL/);
      // Every problem is listed at once, so one restart fixes them all.
      const all = productionProblems({ ...(load({ CREW_ENV: 'local' }) as never), WEB_PUBLIC_URL: 'http://a.test', API_PUBLIC_URL: 'http://b.test' });
      expect(all.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('audit trail and overlapping writes', () => {
    it('writes the audit row with the transaction, only when it commits', async () => {
      const db = app.get(DatabaseService);
      const audit = app.get(AuditService);
      const count = () => pool.count('audit_events', { tenant_id: t.id, action: 'test.deferred' });
      const before = await count();
      const seenInside = await db.tenant(async (tx) => {
        await audit.record(tx, { tenantId: t.id, action: 'test.deferred', resourceType: 'test' });
        return tx.collection('audit_events').count({ action: 'test.deferred' });
      }, { tenantId: t.id });
      expect(seenInside).toBe(before); // not yet: it is written just before commit
      expect(await count()).toBe(before + 1);
      await expect(
        db.tenant(async (tx) => {
          await audit.record(tx, { tenantId: t.id, action: 'test.deferred', resourceType: 'test' });
          throw new Error('roll back');
        }, { tenantId: t.id }),
      ).rejects.toThrow('roll back');
      expect(await count()).toBe(before + 1); // rolled back with the change
      const chain = await pool.tenant(t.id, (tx) => tx.verifyAuditChain());
      expect(chain.firstBrokenSeq).toBeNull();
    });

    it('two requests that audit and lock the same row in opposite order both succeed (no deadlock)', async () => {
      const db = app.get(DatabaseService);
      const audit = app.get(AuditService);
      const id = (await pool.one('legal_entities', { tenant_id: t.id }))!.id as string;
      let rowLocked!: () => void;
      const locked = new Promise<void>((r) => (rowLocked = r));
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // B locks the row first, then audits. A audits first, then wants the row. Before Phase 12 the audit-chain lock
      // was taken at A's audit, so B's audit waited for A while A waited for B's row: PostgreSQL failed one of them.
      const b = db.tenant(async (tx) => {
        await tx.collection('legal_entities').updateOne({ id }, { $set: { updated_at: new Date() } });
        rowLocked();
        await pause(400);
        await audit.record(tx, { tenantId: t.id, action: 'test.order_b', resourceType: 'legal_entity', resourceId: id });
        return 'b';
      }, { tenantId: t.id });
      const a = (async () => {
        await locked;
        return db.tenant(async (tx) => {
          await audit.record(tx, { tenantId: t.id, action: 'test.order_a', resourceType: 'legal_entity', resourceId: id });
          await tx.collection('legal_entities').updateOne({ id }, { $set: { updated_at: new Date() } });
          return 'a';
        }, { tenantId: t.id });
      })();
      expect(await Promise.all([a, b])).toEqual(['a', 'b']);
      const chain = await pool.tenant(t.id, (tx) => tx.verifyAuditChain());
      expect(chain.firstBrokenSeq).toBeNull();
    });
  });

  describe('attendance recomputes', () => {
    it('a single person\'s recompute and a bulk recompute of the same day both finish, and one correct day is stored', async () => {
      const hire = await api(app, owner).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: 'Ravi', lastName: 'Shift', dateOfJoining: '2024-01-15', probationMonths: 0 });
      expect(hire.status, JSON.stringify(hire.body)).toBe(201);
      const id = hire.body.employee.id as string;
      const db = app.get(DatabaseService);
      const days = app.get(AttendanceDaysService);
      const today = new Date().toISOString().slice(0, 10);
      const order: string[] = [];
      let bulkHasLock!: () => void;
      const locked = new Promise<void>((r) => (bulkHasLock = r));
      const bulk = db.tenant(async (tx) => {
        await days.lockBulk(tx);
        bulkHasLock();
        await new Promise((r) => setTimeout(r, 400));
        await days.recompute(tx, id, today, today);
        order.push('bulk done');
      }, { tenantId: t.id });
      await locked;
      const single = db.tenant(async (tx) => {
        await days.recompute(tx, id, today, today);
        order.push('single done');
      }, { tenantId: t.id });
      await Promise.all([bulk, single]);
      // MongoDB lets the first to commit win and runs the other again from the start, so neither waits or fails.
      expect(order).toEqual(expect.arrayContaining(['bulk done', 'single done']));
      const stored = await pool.find('attendance_days', { employee_id: id, work_date: today });
      expect(stored).toHaveLength(1);
      const fresh = await db.tenant((tx) => days.recompute(tx, id, today, today), { tenantId: t.id });
      expect(stored[0]).toMatchObject({ status: fresh.get(today)!.status, worked_minutes: fresh.get(today)!.workedMinutes });
    });
  });

  describe('background work on a production server', () => {
    it('a database error in the outbox loop is logged, not thrown (it used to stop the API process)', async () => {
      const failing = { platform: () => Promise.reject(new Error('relation "outbox_events" does not exist')) } as unknown as DatabaseService;
      const outbox = new OutboxService(failing);
      await expect(outbox.tick()).resolves.toBeUndefined();
    });

    it('runs the daily HR jobs on one server at a time', async () => {
      const jobs = app.get(HrJobsService);
      // Another API server holds the lease: this one skips the run instead of doing the same work twice.
      const release = await pool.svc.tryLease('hr_jobs', 60_000);
      expect(release).not.toBeNull();
      try {
        expect(await jobs.runAll()).toEqual([]);
      } finally {
        await release!();
      }
      const ran = await jobs.runAll();
      expect(ran.some((r) => r.tenantId === t.id)).toBe(true);
    });
  });

  describe('route protection', () => {
    // Every route needs a signed-in session unless it is on this list. A new public route fails this test until it is
    // reviewed and added here on purpose. Each one does its own check: a signed link, a one-time token, a device key,
    // a kiosk token, or it is a sign-in step, a health probe or a public careers or proposal page.
    const REVIEWED_PUBLIC = [
      'GET /auth/invitations/:token', 'GET /auth/sso/saml/metadata', 'GET /files/:id', 'GET /files/receipts/:id', 'GET /files/resumes/:id',
      'GET /health/live', 'GET /health/ready', 'GET /iclock/cdata', 'GET /iclock/getrequest', 'GET /kiosk/qr',
      'GET /public/careers/:site', 'GET /public/careers/:site/jobs/:job', 'GET /public/proposals/:token', 'GET /public/proposals/:token/proposal.pdf',
      'POST /auth/initial-password', 'POST /auth/invitations/accept', 'POST /auth/login', 'POST /auth/mfa/verify', 'POST /auth/refresh', 'POST /auth/select-tenant', 'POST /auth/signup',
      'POST /auth/sso/callback', 'POST /auth/sso/exchange', 'POST /auth/sso/saml/callback', 'POST /auth/sso/start',
      'POST /device-api/heartbeat', 'POST /device-api/punches', 'POST /iclock/cdata', 'POST /iclock/devicecmd', 'POST /platform/auth/login', 'POST /platform/auth/refresh',
      'POST /public/careers/:site/jobs/:job/apply', 'POST /public/proposals/:token/accept', 'POST /public/proposals/:token/decline',
      'GET /signature-agent/images/:kind', 'POST /signature-agent/report', 'POST /signature-agent/sync',
      // Razorpay and Stripe webhooks: refused unless signed with the webhook secret saved in Console > Integrations.
      'POST /billing/webhooks/:provider',
    ];

    it('only the reviewed routes are reachable without signing in', () => {
      const open: string[] = [];
      for (const C of CONTROLLERS as unknown as Array<{ prototype: Record<string, unknown> }>) {
        const base = (Reflect.getMetadata(PATH_METADATA, C) as string | undefined) ?? '';
        const classPublic = Reflect.getMetadata(PUBLIC_KEY, C);
        for (const name of Object.getOwnPropertyNames(C.prototype)) {
          const h = C.prototype[name];
          if (name === 'constructor' || typeof h !== 'function') continue;
          const path = Reflect.getMetadata(PATH_METADATA, h) as string | undefined;
          if (path === undefined) continue;
          if (!(Reflect.getMetadata(PUBLIC_KEY, h) ?? classPublic)) continue;
          const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, h) as number];
          open.push(`${method} /${[base, path].filter((x) => x && x !== '/').join('/')}`.replace(/\/+/g, '/'));
        }
      }
      expect(open.sort()).toEqual([...REVIEWED_PUBLIC].sort());
    });

    it('a protected route refuses a request without a session, with a forged token and with a platform token', async () => {
      expect((await api(app).get('/employees')).status).toBe(401);
      expect((await api(app, 'eyJhbGciOiJub25lIn0.eyJ0aWQiOiJ4In0.').get('/employees')).status).toBe(401);
      const forged = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ tid: t.id, exp: 9999999999 })).toString('base64url') + '.c2lnbmF0dXJl';
      expect((await api(app, forged).get('/employees')).status).toBe(401);
    });
  });

  describe('downloads', () => {
    it('serves files whose names are in any language', async () => {
      const hire = await api(app, owner).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: 'Asha', lastName: 'Rao', dateOfJoining: '2024-01-15', probationMonths: 0 });
      expect(hire.status, JSON.stringify(hire.body)).toBe(201);
      const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
      const up = await api(app, owner).post(`/employees/${hire.body.employee.id}/documents`)
        .field('category', 'contract').field('title', 'Offer letter').field('visibility', 'employee')
        .attach('file', pdf, { filename: 'नियुक्ति पत्र März.pdf', contentType: 'application/pdf' });
      expect(up.status, JSON.stringify(up.body)).toBe(201);
      const link = await api(app, owner).post(`/documents/${up.body.id}/link`);
      const file = await api(app).get(link.body.path.replace('/api/v1', ''));
      expect(file.status).toBe(200); // used to fail: Node refuses non-ASCII header values
      expect(file.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('नियुक्ति पत्र März.pdf')}`);
      expect(file.headers['content-disposition']).toMatch(/^attachment; filename="[\x20-\x7e]+"/);
    });
  });
});
