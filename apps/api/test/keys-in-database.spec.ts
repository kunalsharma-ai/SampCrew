import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { addFieldKey, decryptField, encryptField, keyIdOf, legacyOffsite, mongo, offsiteEnvironment, readFieldKeys, retireOldFieldKeys, shellExports } from '@crew/db';
import { randomBytes } from 'node:crypto';
import { fieldKeyStatus, rotateFieldKeys } from '../src/platform/auth/field-key-rotation';
import { MongoService } from '../src/platform/database/mongo.service';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/platform/config/config';
import { FirstRunService } from '../src/modules/platform-admin/first-run.service';
import { loadInstanceSecrets } from '../src/platform/config/instance-secrets';
import { probeBackupStorage, signAzure, signS3 } from '../src/platform/integrations/backup-storage-probe';
import { legacyIntegrations } from '../src/platform/integrations/legacy-environment';
import { adminPool, createApp, login, createTenant, type TestDb } from './helpers';

/**
 * Every key lives in the database: the pieces that make that work without a running service. Signature Version 4 is
 * checked against AWS's own published examples, the rclone settings against what backup.sh expects, and the
 * sign-in signing keys against a real database.
 */
describe('Keys kept in the database', () => {
  describe('S3 request signing (AWS Signature Version 4)', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Examples"
    const example = { origin: 'https://examplebucket.s3.amazonaws.com', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', now: new Date('2013-05-24T00:00:00Z') };

    it('matches the GET Object example', () => {
      const r = signS3({ ...example, method: 'GET', pathname: '/test.txt', headers: { Range: 'bytes=0-9' } });
      expect(r.headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
      expect(r.url).toBe('https://examplebucket.s3.amazonaws.com/test.txt');
    });

    it('matches the GET Bucket (list objects) example', () => {
      const r = signS3({ ...example, method: 'GET', pathname: '/', query: { 'max-keys': '2', prefix: 'J' } });
      expect(r.headers.authorization).toContain('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
      expect(r.url).toBe('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J');
    });
  });

  it('signs Azure Blob requests with the account key (Shared Key)', () => {
    const key = Buffer.from('azure-test-account-key-0123456789').toString('base64');
    const r = signAzure({ method: 'GET', account: 'sampcrew', accountKey: key, pathname: '/backups', query: { restype: 'container', comp: 'list' }, now: new Date('2026-01-02T03:04:05Z') });
    expect(r.url).toBe('https://sampcrew.blob.core.windows.net/backups?restype=container&comp=list');
    expect(r.headers['x-ms-date']).toBe('Fri, 02 Jan 2026 03:04:05 GMT');
    expect(r.headers.authorization).toMatch(/^SharedKey sampcrew:[A-Za-z0-9+/]{43}=$/);
    // Same request, same signature; another key, another signature.
    expect(signAzure({ method: 'GET', account: 'sampcrew', accountKey: key, pathname: '/backups', query: { comp: 'list', restype: 'container' }, now: new Date('2026-01-02T03:04:05Z') }).headers.authorization).toBe(r.headers.authorization);
    expect(signAzure({ method: 'GET', account: 'sampcrew', accountKey: Buffer.from('another-key').toString('base64'), pathname: '/backups', now: new Date('2026-01-02T03:04:05Z') }).headers.authorization).not.toBe(r.headers.authorization);
  });

  describe('SFTP and folder checks', () => {
    let ssh: Server;
    let port = 0;
    beforeAll(async () => {
      ssh = createServer((s) => s.end('SSH-2.0-OpenSSH_9.6\r\n'));
      await new Promise<void>((r) => ssh.listen(0, '127.0.0.1', r));
      port = (ssh.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((r) => ssh.close(() => r())));

    it('checks that an SSH server answers, and says when nothing does', async () => {
      await expect(probeBackupStorage({ provider: 'sftp', host: '127.0.0.1', port, user: 'x', path: '/b' }, {})).resolves.toContain('answered as an SSH server (SSH-2.0-OpenSSH_9.6)');
      await expect(probeBackupStorage({ provider: 'sftp', host: '127.0.0.1', port: 1, user: 'x', path: '/b' }, {})).rejects.toThrow(/Could not reach 127.0.0.1:1/);
      await expect(probeBackupStorage({ provider: 'folder', path: '/mnt/nas' }, {})).resolves.toContain('checked by the backup service');
    });
  });

  describe('off-site settings for the backup service', () => {
    it('turns each provider into the rclone "offsite" remote', () => {
      expect(offsiteEnvironment(true, { provider: 's3', bucket: 'b', region: '', accessKeyId: 'AK', path: '/x/y/', keepDays: 7 }, { secretAccessKey: 'SK' })).toEqual({
        RCLONE_CONFIG_OFFSITE_TYPE: 's3', RCLONE_CONFIG_OFFSITE_PROVIDER: 'AWS', RCLONE_CONFIG_OFFSITE_REGION: 'us-east-1', RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: 'AK',
        RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: 'SK', RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: 'true', BACKUP_REMOTE: 'offsite:b/x/y', BACKUP_REMOTE_KEEP_DAYS: '7', BACKUP_ALERT_WEBHOOK: '',
      });
      expect(offsiteEnvironment(true, { provider: 'azure', account: 'acct', bucket: 'c', keepDays: 0 }, { accountKey: 'K==' })).toMatchObject({ RCLONE_CONFIG_OFFSITE_TYPE: 'azureblob', RCLONE_CONFIG_OFFSITE_KEY: 'K==', BACKUP_REMOTE: 'offsite:c', BACKUP_REMOTE_KEEP_DAYS: '0' });
      expect(offsiteEnvironment(true, { provider: 'sftp', host: 'h', port: 2222, user: 'u', path: '/srv/b', keepDays: 30 }, { privateKey: 'line1\nline2', password: 'pw' })).toMatchObject({ RCLONE_CONFIG_OFFSITE_KEY_PEM: 'line1\\nline2', OFFSITE_SFTP_PASSWORD: 'pw', RCLONE_CONFIG_OFFSITE_PORT: '2222', BACKUP_REMOTE: 'offsite:/srv/b' });
      expect(offsiteEnvironment(false, { provider: 's3' }, { alertWebhook: 'https://hook' })).toEqual({ BACKUP_REMOTE: '', BACKUP_ALERT_WEBHOOK: 'https://hook' });
    });

    it('prints shell exports that survive quotes and newlines, and drop an old offsite.env', () => {
      const out = shellExports({ BACKUP_REMOTE: "offsite:it's/here", RCLONE_CONFIG_OFFSITE_TYPE: 'local' }, { RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: 'old', PATH: '/bin' });
      expect(out).toBe("unset RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID\nunset OFFSITE_SFTP_PASSWORD\nexport BACKUP_REMOTE='offsite:it'\\''s/here'\nexport RCLONE_CONFIG_OFFSITE_TYPE='local'\n");
    });

    it('reads an older install\'s offsite.env so it can be moved into the database', () => {
      expect(legacyOffsite({})).toEqual({ kind: 'none' });
      expect(legacyOffsite({ BACKUP_REMOTE: 'offsite:bucket/sampcrew', BACKUP_REMOTE_KEEP_DAYS: '45', RCLONE_CONFIG_OFFSITE_TYPE: 's3', RCLONE_CONFIG_OFFSITE_PROVIDER: 'AWS', RCLONE_CONFIG_OFFSITE_REGION: 'ap-south-1', RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: 'AK', RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: 'SK', RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: 'true' })).toMatchObject({
        kind: 'importable', enabled: true, settings: { provider: 's3', bucket: 'bucket', path: 'sampcrew', region: 'ap-south-1', endpoint: '', keepDays: 45 }, secrets: { secretAccessKey: 'SK' },
      });
      expect(legacyOffsite({ BACKUP_REMOTE: 'offsite:/tmp/offsite', RCLONE_CONFIG_OFFSITE_TYPE: 'local' })).toMatchObject({ kind: 'importable', settings: { provider: 'folder', path: '/tmp/offsite' } });
      expect(legacyOffsite({ BACKUP_REMOTE: 'offsite:x', RCLONE_CONFIG_OFFSITE_TYPE: 'drive' })).toMatchObject({ kind: 'unsupported' });
      expect(legacyOffsite({ BACKUP_REMOTE: 'offsite:/b', RCLONE_CONFIG_OFFSITE_TYPE: 'sftp', RCLONE_CONFIG_OFFSITE_HOST: 'h', RCLONE_CONFIG_OFFSITE_USER: 'u', RCLONE_CONFIG_OFFSITE_PASS: 'obscured' })).toMatchObject({ kind: 'unsupported' });
      expect(legacyOffsite({ BACKUP_ALERT_WEBHOOK: 'https://hook' })).toMatchObject({ kind: 'importable', enabled: false, secrets: { alertWebhook: 'https://hook' } });
    });
  });

  it('checks old integration variables with the Console\'s rules before moving them', () => {
    const r = legacyIntegrations({ CLAMAV_URL: 'http://clamav:3310', SMTP_URL: 'smtps://u:p%40ss@mail.example.com', MOBILE_SSO_REDIRECTS: 'crew://sso,http://localhost:8081/sso', AI_PROVIDER: 'anthropic' }, true);
    expect(r.items.map((i) => i.key)).toEqual(['email']);
    expect(r.items[0]).toMatchObject({ settings: { host: 'mail.example.com', port: 465, security: 'tls', username: 'u' }, secrets: { password: 'p@ss' } });
    expect(r.problems).toHaveLength(3);
    expect(legacyIntegrations({ SMTP_URL: 'smtp://mailpit:1025' }, false).items[0]!.settings.security).toBe('none');
    expect(legacyIntegrations({ SMTP_URL: 'smtp://mail.example.com:587' }, true).items[0]!.settings.security).toBe('starttls');
  });

  describe('first-run setup, with no admin password in the settings file', () => {
    // A brand-new installation: a database of its own, with no Console admin at all.
    const shared = process.env.MONGODB_URL!;
    const fresh = shared.replace(/\/([^/?]+)(\?|$)/, '/$1_firstrun$2');
    let pool: TestDb;
    beforeAll(async () => {
      const client = mongo.createMongoClient({ url: fresh, appName: 'crew-test-firstrun' });
      await client.connect();
      await client.db(mongo.databaseName(fresh)).dropDatabase();
      await mongo.migrateMongo(client.db(mongo.databaseName(fresh)));
      await client.close();
      process.env.MONGODB_URL = fresh;
      pool = adminPool();
    });
    afterAll(async () => {
      await pool.end();
      process.env.MONGODB_URL = shared;
      resetConfigForTests();
      const client = mongo.createMongoClient({ url: fresh, appName: 'crew-test-firstrun' });
      await client.connect();
      await client.db(mongo.databaseName(fresh)).dropDatabase();
      await client.close();
    });

    it('creates the first Super admin with the one-time code from the log, once', async () => {
      expect(mongo.databaseName(fresh)).toMatch(/test.*_firstrun$/);
      resetConfigForTests();
      const app = await createApp();
      const http = (await import('supertest')).default(app.getHttpServer());
      try {
        expect((await http.get('/api/v1/platform/setup')).body).toEqual({ needsFirstAdmin: true });
        const code = await app.get(FirstRunService).setupCode();
        expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
        const row = (await pool.find('instance_secrets', { key: 'setup_code' }))[0]!;
        expect(row.value_enc).toMatch(/^v2\./);
        expect(JSON.stringify(row)).not.toContain(code);
        const body = { fullName: 'Asha Rao', email: 'Asha.Rao@Sampledge.test', password: 'First-Admin-Pass-42' };
        const wrong = await http.post('/api/v1/platform/setup/first-admin').send({ ...body, setupCode: 'AAAAA-BBBBB-CCCCC' });
        expect(wrong.status).toBe(422);
        expect(wrong.body.error.details[0].path).toBe('setupCode');
        expect((await http.post('/api/v1/platform/setup/first-admin').send({ ...body, password: 'short', setupCode: code })).status).toBe(422);
        // Typed by hand: lower case, no dashes.
        const made = await http.post('/api/v1/platform/setup/first-admin').send({ ...body, setupCode: code!.replace(/-/g, '').toLowerCase() });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        expect(made.body).toEqual({ email: 'asha.rao@sampledge.test' });
        const signIn = await http.post('/api/v1/platform/auth/login').send({ email: 'asha.rao@sampledge.test', password: body.password });
        expect(signIn.status).toBe(200);
        expect(signIn.body).toMatchObject({ status: 'ok', mfaEnrolmentRequired: true });
        // Closed for good: the code is gone and a second try is refused.
        expect((await http.post('/api/v1/platform/setup/first-admin').send({ ...body, email: 'second@sampledge.test', setupCode: code })).status).toBe(409);
        expect((await http.get('/api/v1/platform/setup')).body).toEqual({ needsFirstAdmin: false });
        expect(await pool.find('instance_secrets', { key: 'setup_code' })).toEqual([]);
        expect(await app.get(FirstRunService).setupCode()).toBeNull();
        const admins = await pool.find('platform_admins', {});
        expect(admins.map((a) => [a.email, a.role])).toEqual([['asha.rao@sampledge.test', 'super_admin']]);
        const audit = await pool.find('audit_events', { tenant_id: null, action: 'platform.first_admin_created' });
        expect(audit).toHaveLength(1);
        expect(JSON.stringify(audit)).not.toContain(body.password);
      } finally {
        await app.close();
      }
    });
  });

  describe('sign-in signing keys', () => {
    let pool: TestDb;
    beforeAll(() => {
      pool = adminPool();
    });
    afterAll(async () => {
      delete process.env.JWT_ACCESS_SECRET;
      resetConfigForTests();
      await pool.end();
    });

    it('are created once in the database, encrypted, and the same for every server and restart', async () => {
      resetConfigForTests();
      const app = await createApp();
      const rows = await pool.find('instance_secrets', { key: { $in: ['jwt_access', 'jwt_platform'] } }, { sort: { key: 1 } });
      expect(rows.map((r) => [r.key, r.origin])).toEqual([['jwt_access', expect.any(String)], ['jwt_platform', expect.any(String)]]);
      expect(rows.every((r) => /^v2\./.test(r.value_enc as string))).toBe(true);
      const first = { ...loadConfig() };
      expect(first.JWT_ACCESS_SECRET.length).toBeGreaterThanOrEqual(32);
      expect(first.JWT_ACCESS_SECRET).not.toBe(first.JWT_PLATFORM_SECRET);
      expect(JSON.stringify(rows)).not.toContain(first.JWT_ACCESS_SECRET);
      // A token from this server works on the next one, started with no JWT_* variables.
      const t = await createTenant(pool);
      const token = (await login(app, t.ownerEmail)).accessToken;
      await app.close();
      resetConfigForTests();
      const again = await loadInstanceSecrets(loadConfig(), () => undefined);
      expect(again.JWT_ACCESS_SECRET).toBe(first.JWT_ACCESS_SECRET);
      const next = await createApp();
      const me = await (await import('supertest')).default(next.getHttpServer()).get('/api/v1/me').set('authorization', `Bearer ${token}`);
      expect(me.status).toBe(200);
      await next.close();
    });

    it('ignores an old JWT_ACCESS_SECRET once the database holds the key, and says so', async () => {
      resetConfigForTests();
      process.env.JWT_ACCESS_SECRET = 'an-old-environment-secret-that-is-long-enough-0001';
      const said: string[] = [];
      const c = await loadInstanceSecrets(loadConfig(), (m) => said.push(m));
      expect(c.JWT_ACCESS_SECRET).not.toBe(process.env.JWT_ACCESS_SECRET);
      expect(said.join(' ')).toContain('JWT_ACCESS_SECRET is ignored');
    });

    it('moves an old JWT secret into the database when none is saved, so people stay signed in', async () => {
      await pool.delete('instance_secrets', { key: 'jwt_platform' });
      resetConfigForTests();
      process.env.JWT_PLATFORM_SECRET = 'an-old-platform-secret-that-is-long-enough-0002';
      const said: string[] = [];
      const c = await loadInstanceSecrets(loadConfig(), (m) => said.push(m));
      expect(c.JWT_PLATFORM_SECRET).toBe('an-old-platform-secret-that-is-long-enough-0002');
      expect((await pool.find('instance_secrets', { key: 'jwt_platform' }))[0]!.origin).toBe('environment');
      expect(said.join(' ')).toContain('Moved JWT_PLATFORM_SECRET into the database');
      delete process.env.JWT_PLATFORM_SECRET;
    });
  });

  describe('the encryption key itself, with nothing in the settings file', () => {
    // Each case starts from a database of its own, as a new or an upgraded installation would.
    const shared = process.env.MONGODB_URL!;
    const fresh = shared.replace(/\/([^/?]+)(\?|$)/, '/$1_keyring$2');
    const client = mongo.createMongoClient({ url: fresh, appName: 'crew-test-keyring' });
    const db = () => client.db(mongo.databaseName(fresh));
    const start = async () => {
      resetConfigForTests();
      const said: string[] = [];
      const c = await loadInstanceSecrets(loadConfig(), (m) => said.push(m));
      return { c, said: said.join(' ') };
    };
    beforeAll(async () => {
      expect(mongo.databaseName(fresh)).toMatch(/test.*_keyring$/);
      await client.connect();
      process.env.MONGODB_URL = fresh;
    });
    beforeEach(async () => {
      await db().dropDatabase();
      await mongo.migrateMongo(db());
    });
    afterAll(async () => {
      delete process.env.FIELD_ENCRYPTION_KEY;
      delete process.env.FIELD_ENCRYPTION_KEYS_PREVIOUS;
      process.env.MONGODB_URL = shared;
      resetConfigForTests();
      await db().dropDatabase();
      await client.close();
    });

    it('is created at random on the first start and read back by every later start', async () => {
      const { c } = await start();
      const ring = (await readFieldKeys(db()))!;
      expect(ring).toHaveLength(1);
      expect(ring[0]).toMatchObject({ id: keyIdOf(ring[0]!.key), origin: 'generated' });
      expect(Buffer.from(ring[0]!.key, 'base64')).toHaveLength(32);
      expect(c.fieldKeys).toBe(ring[0]!.key);
      // The signing keys saved at the same time are locked with it.
      const jwt = (await db().collection('instance_secrets').findOne({ key: 'jwt_access' }))!;
      expect(decryptField(jwt.value_enc as string, c.fieldKeys)).toBe(c.JWT_ACCESS_SECRET);
      const again = await start();
      expect(again.c.fieldKeys).toBe(c.fieldKeys);
      expect(again.c.JWT_ACCESS_SECRET).toBe(c.JWT_ACCESS_SECRET);
    });

    it('is moved in from an older release\'s FIELD_ENCRYPTION_KEY, so what it encrypted stays readable', async () => {
      const oldKey = randomBytes(32).toString('base64');
      const older = randomBytes(32).toString('base64');
      await db().collection('platform_integrations').insertOne({ _id: 'x' as never, key: 'ai', enabled: true, settings: {}, secrets_enc: encryptField('{"apiKey":"sk-ant-old"}', older), secret_hints: {}, config_hash: 'h', updated_at: new Date(), created_at: new Date() } as never, { bypassDocumentValidation: true });
      process.env.FIELD_ENCRYPTION_KEY = oldKey;
      process.env.FIELD_ENCRYPTION_KEYS_PREVIOUS = older;
      const { c, said } = await start();
      expect(said).toContain('Moved FIELD_ENCRYPTION_KEY and FIELD_ENCRYPTION_KEYS_PREVIOUS into the database');
      expect((await readFieldKeys(db()))!.map((k) => [k.key, k.origin])).toEqual([[oldKey, 'environment'], [older, 'environment']]);
      const row = (await db().collection('platform_integrations').findOne({ key: 'ai' }))!;
      expect(decryptField(row.secrets_enc as string, c.fieldKeys)).toBe('{"apiKey":"sk-ant-old"}');
      // From then on the line is ignored, and the log says to delete it, even if it is changed.
      process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('base64');
      const next = await start();
      expect(next.c.fieldKeys).toBe(c.fieldKeys);
      expect(next.said).toContain('FIELD_ENCRYPTION_KEY is ignored');
      delete process.env.FIELD_ENCRYPTION_KEY;
      delete process.env.FIELD_ENCRYPTION_KEYS_PREVIOUS;
    });

    it('is not invented for a database that already holds values encrypted with a key it does not have', async () => {
      await db().collection('webhook_endpoints').insertOne({ _id: 'w' as never, secret_enc: encryptField('s', randomBytes(32).toString('base64')) } as never, { bypassDocumentValidation: true });
      await expect(start()).rejects.toThrow(/holds encrypted values but no encryption key.*FIELD_ENCRYPTION_KEY/);
      expect(await readFieldKeys(db())).toBeNull();
    });

    it('is rotated with commands, not by editing settings: add a key, re-encrypt, retire the old one', async () => {
      const before = (await start()).c;
      const first = before.fieldKeys;
      // The signing keys saved on the first start are the values encrypted with the first key.
      const saved = async () => (await db().collection('instance_secrets').findOne({ key: 'jwt_access' }))!.value_enc as string;
      const value = await saved();
      const ring = await addFieldKey(db());
      expect(ring.map((k) => k.key)).toEqual([expect.any(String), first]);
      const { c } = await start(); // what a restarted server reads
      expect(c.fieldKeys.split(',')[0]).not.toBe(first);
      expect(c.JWT_ACCESS_SECRET).toBe(before.JWT_ACCESS_SECRET);
      expect(decryptField(value, c.fieldKeys)).toBe(before.JWT_ACCESS_SECRET);
      const svc = new MongoService(c);
      try {
        expect((await fieldKeyStatus(svc, c.fieldKeys)).find((r) => r.table === 'instance_secrets')!.pending).toBe(2);
        await rotateFieldKeys(svc, c.fieldKeys);
        expect((await fieldKeyStatus(svc, c.fieldKeys)).every((r) => r.pending === 0)).toBe(true);
      } finally {
        await svc.onModuleDestroy();
      }
      const r = await retireOldFieldKeys(db());
      expect(r.removed).toEqual([keyIdOf(first)]);
      const after = await start();
      expect(after.c.fieldKeys).toBe(c.fieldKeys.split(',')[0]);
      expect(after.c.JWT_ACCESS_SECRET).toBe(before.JWT_ACCESS_SECRET);
      expect(() => decryptField(value, after.c.fieldKeys)).toThrow(/not in the key ring/);
    });
  });
});
