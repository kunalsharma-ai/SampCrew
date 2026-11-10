import { createCipheriv, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { mongo } from '@crew/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptField, encryptField, fieldKeyId, keyIdOf } from '../src/platform/auth/crypto';
import { ENCRYPTED_COLUMNS, fieldKeyStatus, rotateFieldKeys } from '../src/platform/auth/field-key-rotation';
import { currentTotp, generateMfaSecret } from '../src/platform/auth/mfa';
import { loadConfig, resetConfigForTests } from '../src/platform/config/config';
import { MongoService as DatabaseService } from '../src/platform/database/mongo.service';
import { scanWithClamd } from '../src/platform/storage/malware-scan';
import { adminPool, api, createApp, createTenant, login, PASSWORD, type TestDb, type TestTenant } from './helpers';

/**
 * A value as SampCrew wrote it before key ids existed (v1.<iv>.<tag>.<ciphertext>), to check old data stays readable.
 */
function legacyV1(plaintext: string, keyBase64: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** EICAR: the industry-standard harmless test file every virus scanner reports (it is not malware). */
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

/**
 * TEST STUB of clamd, used when CLAMAV_TEST_URL is not set: it speaks clamd's INSTREAM protocol and reports the EICAR
 * test string at the start of a file, as ClamAV does. CI also runs this file against a real ClamAV (job "malware-scan", CLAMAV_TEST_URL).
 */
function clamdStub(): Promise<{ server: Server; url: string }> {
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      const cmd = buf.indexOf(0);
      if (cmd < 0) return;
      const name = buf.subarray(0, cmd).toString();
      if (name === 'zPING') return void sock.end('PONG\0');
      let off = cmd + 1;
      const parts: Buffer[] = [];
      while (buf.length >= off + 4) {
        const n = buf.readUInt32BE(off);
        if (n === 0) {
          const data = Buffer.concat(parts);
          // Like ClamAV, only a file that starts with the EICAR string is reported (the EICAR standard's own rule).
          return void sock.end(data.subarray(0, EICAR.length).equals(EICAR) ? 'stream: Eicar-Signature FOUND\0' : 'stream: OK\0');
        }
        if (buf.length < off + 4 + n) return;
        parts.push(buf.subarray(off + 4, off + 4 + n));
        off += 4 + n;
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `tcp://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

describe('Phase 13: closing the remaining gaps', () => {
  const oldKey = randomBytes(32).toString('base64');
  let stub: { server: Server; url: string } | undefined;
  let scanner: string;
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let employeeId: string;

  beforeAll(async () => {
    stub = process.env.CLAMAV_TEST_URL ? undefined : await clamdStub();
    scanner = process.env.CLAMAV_TEST_URL ?? stub!.url;
    // This API instance reads values written with an earlier key and scans uploads.
    process.env.FIELD_ENCRYPTION_KEYS_PREVIOUS = oldKey;
    process.env.CLAMAV_URL = scanner;
    resetConfigForTests();
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    owner = (await login(app, t.ownerEmail)).accessToken;
    const e = await api(app, owner).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: 'Scan', lastName: 'Test', dateOfJoining: '2024-01-15', probationMonths: 0, onboardingTemplateId: null });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    employeeId = e.body.employee.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    stub?.server.close();
    delete process.env.FIELD_ENCRYPTION_KEYS_PREVIOUS;
    delete process.env.CLAMAV_URL;
    resetConfigForTests();
  });

  describe('field encryption key rotation', () => {
    const current = () => loadConfig().FIELD_ENCRYPTION_KEY;

    it('writes the key id into new values and reads values from every key in the ring, including pre-key-id ones', () => {
      const ring = `${current()},${oldKey}`;
      const v = encryptField('JBSWY3DPEHPK3PXP', ring);
      expect(fieldKeyId(v)).toBe(keyIdOf(current()));
      expect(decryptField(v, ring)).toBe('JBSWY3DPEHPK3PXP');
      expect(decryptField(encryptField('x', oldKey), ring)).toBe('x');
      expect(decryptField(legacyV1('legacy', oldKey), ring)).toBe('legacy');
      expect(() => decryptField(encryptField('x', oldKey), current())).toThrow(/FIELD_ENCRYPTION_KEYS_PREVIOUS/);
      expect(() => decryptField(legacyV1('x', oldKey), current())).toThrow();
    });

    it('lists every encrypted column in the database, so the re-encryption job misses none', async () => {
      const cols = Object.entries(mongo.TABLES).flatMap(([table, spec]) => Object.keys(spec.columns).filter((c) => c.endsWith('_enc')).map((c) => `${table}.${c}`));
      expect(cols.length).toBeGreaterThan(3);
      const listed = new Set(ENCRYPTED_COLUMNS.map((x) => `${x.table}.${x.column}`));
      expect(cols.filter((c) => !listed.has(c))).toEqual([]);
    });

    it('keeps sign-in working during a rotation and re-encrypts everything with the current key', async () => {
      // Data as an installation had it before the rotation: an MFA seed and bank details under the old key.
      const seed = generateMfaSecret();
      const ownerId = (await pool.one('users', { email: t.ownerEmail }))!.id as string;
      await pool.update('users', { id: ownerId }, { $set: { mfa_secret_enc: legacyV1(seed, oldKey), mfa_enabled: true } });
      const bank = { bank_account_enc: encryptField('000123456789', oldKey), tax_id_enc: legacyV1('ABCDE1234F', oldKey) };
      await pool.platform((tx) => tx.collection('employee_sensitive').upsert({ employee_id: employeeId }, { employee_id: employeeId, tenant_id: t.id, bank_name: 'Test Bank', ...bank }, { $set: bank }));

      // The API, restarted with the new key and the old one as previous, still signs the owner in with MFA.
      const first = await api(app).post('/auth/login').send({ email: t.ownerEmail, password: PASSWORD });
      expect(first.body.status).toBe('mfa_required');
      const verified = await api(app).post('/auth/mfa/verify').send({ mfaToken: first.body.mfaToken, code: currentTotp(seed) });
      expect(verified.status, JSON.stringify(verified.body)).toBe(200);
      expect(verified.body.status).toBe('ok');

      const db = new DatabaseService(loadConfig());
      try {
        const ring = loadConfig().fieldKeys;
        expect((await fieldKeyStatus(db, ring)).reduce((a, r) => a + r.pending, 0)).toBeGreaterThanOrEqual(3);
        const run = await rotateFieldKeys(db, ring, { batchSize: 2 });
        expect(run.find((r) => r.table === 'users')!.rewritten).toBeGreaterThanOrEqual(1);
        expect(run.find((r) => r.column === 'tax_id_enc')!.rewritten).toBeGreaterThanOrEqual(1);
        expect((await fieldKeyStatus(db, ring)).every((r) => r.pending === 0)).toBe(true);
        // Running it again changes nothing.
        expect((await rotateFieldKeys(db, ring)).every((r) => r.rewritten === 0)).toBe(true);
      } finally {
        await db.onModuleDestroy();
      }

      // Everything now opens with the current key alone, so the old key can be removed.
      const u = (await pool.one('users', { id: ownerId }))!.mfa_secret_enc as string;
      expect(fieldKeyId(u)).toBe(keyIdOf(current()));
      expect(decryptField(u, current())).toBe(seed);
      const sens = (await pool.one('employee_sensitive', { employee_id: employeeId }))!;
      const s = { a: sens.bank_account_enc as string, x: sens.tax_id_enc as string };
      expect([decryptField(s.a, current()), decryptField(s.x, current())]).toEqual(['000123456789', 'ABCDE1234F']);

      const audit = (await pool.one('audit_events', { tenant_id: null, action: 'platform.field_key_rotated' }, { sort: { chain_seq: -1 } }))!;
      expect(audit.metadata.keyId).toBe(keyIdOf(current()));
      await pool.update('users', { id: ownerId }, { $set: { mfa_secret_enc: null, mfa_enabled: false } });
    });

    it('stops with the table and row named when a value cannot be opened with any key', async () => {
      const stray = encryptField('lost', randomBytes(32).toString('base64'));
      const w = await pool.insert('webhook_endpoints', { tenant_id: t.id, name: 'Stray', url: 'https://hooks.example.test/x', events: ['employee.created'], secret_enc: stray, created_by_membership_id: t.ownerMembershipId });
      const db = new DatabaseService(loadConfig());
      try {
        await expect(rotateFieldKeys(db, loadConfig().fieldKeys)).rejects.toThrow(new RegExp(`webhook_endpoints.secret_enc for id ${w.id}`));
      } finally {
        await db.onModuleDestroy();
        await pool.delete('webhook_endpoints', { id: w.id });
      }
    });
  });

  describe('virus scanning of uploads', () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const upload = (file: Buffer, title: string) =>
      api(app, owner).post(`/employees/${employeeId}/documents`).field('category', 'other').field('title', title).field('visibility', 'employee')
        .attach('file', file, { filename: 'scan.txt', contentType: 'text/plain' });

    it('answers clean and flagged files the way clamd does', async () => {
      expect(await scanWithClamd(scanner, pdf)).toEqual({ clean: true });
      const r = await scanWithClamd(scanner, EICAR);
      expect(r.clean).toBe(false);
      expect(!r.clean && r.signature).toMatch(/eicar/i);
    });

    it('stores a clean upload and refuses a flagged one without keeping anything', async () => {
      expect((await upload(Buffer.from('Shift handover notes'), 'Clean notes')).status).toBe(201);
      const bad = await upload(EICAR, 'Flagged file');
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('malware_detected');
      const titles = (await api(app, owner).get(`/employees/${employeeId}/documents`)).body.map((d: { title: string }) => d.title);
      expect(titles).toContain('Clean notes');
      expect(titles).not.toContain('Flagged file');
    });

    it('refuses uploads while the scanner is unreachable (fails closed)', async () => {
      const closed = await new Promise<string>((r) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => {
          const port = (s.address() as { port: number }).port;
          s.close(() => r(`tcp://127.0.0.1:${port}`));
        });
      });
      const cfg = loadConfig() as { CLAMAV_URL?: string };
      const before = cfg.CLAMAV_URL;
      cfg.CLAMAV_URL = closed;
      try {
        const res = await upload(Buffer.from('Some notes'), 'While scanner down');
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('scanner_unavailable');
      } finally {
        cfg.CLAMAV_URL = before;
      }
    });
  });
});
