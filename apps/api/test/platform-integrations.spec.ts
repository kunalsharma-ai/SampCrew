import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiGatewayService } from '../src/modules/ai/ai-gateway.service';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { resetConfigForTests } from '../src/platform/config/config';
import { offsiteEnvironment } from '@crew/db';
import { signS3 } from '../src/platform/integrations/backup-storage-probe';
import { PlatformIntegrationsService } from '../src/platform/integrations/platform-integrations.service';
import { MailerService } from '../src/platform/notify/mailer.service';
import { adminPool, api, createApp, createTenant, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

/**
 * Installation-wide integrations, kept only in the database and set up in the Super Admin Console: Claude AI, SMTP
 * email, Expo push, ClamAV scanning, mobile sign-in addresses and off-site backup storage (payments: billing-payments.spec.ts). Each test talks to a real local server (a Claude API
 * stand-in, an SMTP server, an Expo push stand-in, a clamd stand-in), so the connection tests and the services that
 * use the saved settings are exercised for real.
 */
describe('Platform integrations (Super Admin Console)', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let superToken: string;
  let supportToken: string;
  const stamp = Date.now();
  const S3_KEY_ID = 'AKIASAMPCREWTEST0001';
  const S3_SECRET = 'sampcrew/test/S3-secret-key-0000000000';
  let s3: Server;
  let s3Url = '';
  const s3Requests: { method: string; path: string }[] = [];
  const s3Objects = new Map<string, string>();

  // Claude API stand-in: answers "OK" for the key it knows, 401 for any other.
  const aiRequests: { key: string | undefined; body: Record<string, unknown> }[] = [];
  let ai: Server;
  let aiUrl: string;
  // Expo push stand-in: 401 for a wrong access token, tickets otherwise.
  const pushes: { auth: string | undefined; body: { to: string }[] }[] = [];
  let push: Server;
  // SMTP server that requires a user name and password.
  const mails: { to: string; body: string }[] = [];
  let smtp: SMTPServer;
  let smtpPort: number;
  // clamd stand-in answering PING.
  let clamd: TcpServer;
  let clamdUrl: string;

  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const as = (token: string) => api(app, token);
  const view = async (key: string) => (ok(await as(superToken).get('/platform/integrations')) as unknown as Record<string, any>[]).find((v) => v.key === key)!;

  async function platformToken(role: string) {
    const email = `${role}.integrations.${stamp}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: `${role} admin`, password_hash: await hashPassword(PASSWORD), role });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    return (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken as string;
  }

  beforeAll(async () => {
    ai = createHttpServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        // The SDK sends the key as x-api-key or as a bearer token, depending on its version.
        const key = (req.headers['x-api-key'] as string | undefined) ?? req.headers.authorization?.replace(/^Bearer /, '');
        aiRequests.push({ key, body: raw ? JSON.parse(raw) : {} });
        res.setHeader('content-type', 'application/json');
        if (key !== 'sk-ant-test-good-key-1234') {
          res.statusCode = 401;
          return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        }
        const body = JSON.parse(raw) as { model: string };
        res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 12, output_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => ai.listen(0, '127.0.0.1', r));
    aiUrl = `http://127.0.0.1:${(ai.address() as AddressInfo).port}`;

    push = createHttpServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const auth = req.headers.authorization;
        const body = JSON.parse(raw) as { to: string }[];
        pushes.push({ auth, body });
        res.setHeader('content-type', 'application/json');
        if (auth && auth !== 'Bearer expo-good-access-token-0001') {
          res.statusCode = 401;
          return res.end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', message: 'bad access token' }] }));
        }
        res.end(JSON.stringify({ data: body.map((m) => (m.to.includes('crew-connection-check') ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'ticket-1' })) }));
      });
    });
    await new Promise<void>((r) => push.listen(0, '127.0.0.1', r));

    smtp = new SMTPServer({
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      onAuth(auth, _session, cb) {
        if (auth.username === 'crew-mailer' && auth.password === 'smtp-secret-pass-9876') return cb(null, { user: 'crew-mailer' });
        cb(new Error('Invalid user name or password'));
      },
      onData(stream, session, cb) {
        let body = '';
        stream.on('data', (c: Buffer) => (body += c.toString()));
        stream.on('end', () => {
          mails.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), body });
          cb();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
    smtpPort = (smtp.server.address() as AddressInfo).port;

    clamd = createTcpServer((sock) => {
      sock.on('data', (d) => {
        if (d.toString().includes('PING')) sock.end('PONG\0');
      });
    });
    await new Promise<void>((r) => clamd.listen(0, '127.0.0.1', r));
    clamdUrl = `tcp://127.0.0.1:${(clamd.address() as AddressInfo).port}`;

    // S3 stand-in: checks each request's Signature Version 4 with the secret it knows, and keeps objects in memory.
    s3 = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        const url = new URL(req.url!, s3Url);
        s3Requests.push({ method: req.method!, path: url.pathname });
        const xml = (status: number, code: string) => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`); };
        const auth = String(req.headers.authorization ?? '');
        const date = String(req.headers['x-amz-date']);
        const now = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +date.slice(9, 11), +date.slice(11, 13), +date.slice(13, 15)));
        const expected = signS3({ method: req.method!, origin: s3Url, pathname: decodeURIComponent(url.pathname), query: Object.fromEntries(url.searchParams), region: 'ap-south-1', accessKeyId: S3_KEY_ID, secretAccessKey: S3_SECRET, body, headers: req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : {}, now });
        if (!auth.includes(`Credential=${S3_KEY_ID}/`)) return xml(403, 'InvalidAccessKeyId');
        if (auth !== expected.headers.authorization) return xml(403, 'SignatureDoesNotMatch');
        const [, bucket, ...key] = url.pathname.split('/');
        if (bucket !== 'sampcrew-backups') return xml(404, 'NoSuchBucket');
        const k = key.join('/');
        if (req.method === 'PUT') { s3Objects.set(k, body); res.writeHead(200); return res.end(); }
        if (req.method === 'DELETE') { s3Objects.delete(k); res.writeHead(204); return res.end(); }
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...s3Objects.keys()].filter((o) => o.startsWith(prefix));
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(`<ListBucketResult><KeyCount>${keys.length}</KeyCount>${keys.map((o) => `<Contents><Key>${o}</Key></Contents>`).join('')}</ListBucketResult>`);
      });
    });
    await new Promise<void>((r) => s3.listen(0, '127.0.0.1', r));
    s3Url = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;

    process.env.EXPO_PUSH_URL = `http://127.0.0.1:${(push.address() as AddressInfo).port}/--/api/v2/push/send`;
    resetConfigForTests();
    app = await createApp();
    pool = adminPool();
    await pool.delete('platform_integrations', {});
    t = await createTenant(pool, { plan: 'business' });
    superToken = await platformToken('super_admin');
    supportToken = await platformToken('support');
  });

  afterAll(async () => {
    await pool.delete('platform_integrations', {});
    await app.close();
    await pool.end();
    await Promise.all([
      new Promise((r) => ai.close(r)),
      new Promise((r) => push.close(r)),
      new Promise((r) => smtp.close(() => r(undefined))),
      new Promise((r) => clamd.close(r)),
      new Promise((r) => s3.close(r)),
    ]);
    delete process.env.EXPO_PUSH_URL;
    resetConfigForTests();
  });

  it('lists every integration with where its setting comes from: nothing saved yet', async () => {
    const list = ok(await as(superToken).get('/platform/integrations')) as unknown as Record<string, any>[];
    expect(list.map((v) => v.key)).toEqual(['ai', 'email', 'push', 'scanning', 'mobile_sso', 'razorpay', 'stripe', 'backups', 'company_data']);
    // Nothing comes from the environment any more; only the app's own sign-in address has a built-in default.
    expect(list.find((v) => v.key === 'ai')).toMatchObject({ source: 'none', enabled: false, secrets: { apiKey: { set: false, hint: null } } });
    expect(list.find((v) => v.key === 'email')).toMatchObject({ source: 'none', enabled: false });
    expect(list.find((v) => v.key === 'mobile_sso')).toMatchObject({ source: 'default', enabled: true, settings: { redirects: ['crew://sso'] }, imported: null });
    expect(list.find((v) => v.key === 'backups')).toMatchObject({ source: 'none', enabled: false, secrets: { secretAccessKey: { set: false } } });
  });

  it('lets support staff look but only Super admins change or test, and keeps workspaces out', async () => {
    expect((await as(supportToken).get('/platform/integrations')).status).toBe(200);
    expect((await as(supportToken).put('/platform/integrations/scanning').send({ enabled: true, url: clamdUrl })).status).toBe(403);
    expect((await as(supportToken).post('/platform/integrations/scanning/test').send({ values: { enabled: true, url: clamdUrl } })).status).toBe(403);
    expect((await as(supportToken).delete('/platform/integrations/scanning')).status).toBe(403);
    const owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    expect((await as(owner).get('/platform/integrations')).status).toBe(401);
  });

  it('refuses incomplete or malformed values with field messages', async () => {
    const noKey = await as(superToken).put('/platform/integrations/ai').send({ enabled: true, model: 'claude-opus-5-5', effort: 'low', refusalFallback: true, timeoutSeconds: 30 });
    expect(noKey.status).toBe(422);
    expect(noKey.body.error.details).toEqual([{ path: 'apiKey', message: 'Paste the Claude API key' }]);
    const badFrom = await as(superToken).put('/platform/integrations/email').send({ enabled: true, host: 'smtp.example.com', port: 587, security: 'starttls', from: 'not an address' });
    expect(badFrom.status).toBe(422);
    expect(badFrom.body.error.details[0].path).toBe('from');
    expect((await as(superToken).put('/platform/integrations/payments').send({ enabled: true })).status).toBe(422);
    expect((await as(superToken).put('/platform/integrations/scanning').send({ enabled: true, url: 'http://clamav:3310' })).status).toBe(422);
  });

  describe('Claude AI', () => {
    const values = (extra: Record<string, unknown> = {}) => ({ enabled: true, apiKey: 'sk-ant-test-good-key-1234', model: 'claude-opus-5-5', effort: 'low', refusalFallback: false, timeoutSeconds: 20, baseUrl: aiUrl, ...extra });

    it('tests a key before saving, and says plainly when the key is refused', async () => {
      const bad = ok(await as(superToken).post('/platform/integrations/ai/test').send({ values: values({ apiKey: 'sk-ant-wrong-key-0000' }) }));
      expect(bad).toMatchObject({ ok: false, recorded: false });
      expect(bad.detail).toMatch(/401.*API key was refused/);
      const good = ok(await as(superToken).post('/platform/integrations/ai/test').send({ values: values() }));
      expect(good).toMatchObject({ ok: true, recorded: false });
      expect(good.detail).toMatch(/^Claude answered using claude-opus-5-5/);
      expect(aiRequests.at(-1)!.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16 });
      // Nothing was saved by testing.
      expect((await view('ai')).source).toBe('none');
    });

    it('saves the key encrypted, never returns it, and AI then works for workspaces', async () => {
      const gateway = app.get(AiGatewayService);
      gateway.setProvider(undefined);
      expect(await gateway.providerInfo()).toMatchObject({ configured: false });

      const saved = ok(await as(superToken).put('/platform/integrations/ai').send(values()));
      expect(saved).toMatchObject({ source: 'console', enabled: true, settings: { model: 'claude-opus-5-5', baseUrl: aiUrl }, secrets: { apiKey: { set: true, hint: '••••1234' } } });
      const listed = await as(superToken).get('/platform/integrations');
      expect(JSON.stringify(listed.body)).not.toContain('sk-ant-test-good-key');
      const stored = (await pool.one('platform_integrations', { key: 'ai' }))!;
      const row = { secrets_enc: stored.secrets_enc as string, settings: JSON.stringify(stored.settings) };
      expect(row.secrets_enc).toMatch(/^v2\./);
      expect(row.secrets_enc).not.toContain('good-key');
      expect(row.settings).not.toContain('good-key');

      // The AI gateway picks the saved settings up and calls the configured address with the saved key.
      expect(await gateway.providerInfo()).toEqual({ configured: true, provider: 'anthropic', model: 'claude-opus-5-5' });
      const before = aiRequests.length;
      const provider = (await gateway.provider())!;
      expect((await provider.complete({ system: 's', user: 'u', maxTokens: 10 })).text).toBe('OK');
      expect(aiRequests.length).toBe(before + 1);
      expect(aiRequests.at(-1)!.key).toBe('sk-ant-test-good-key-1234');

      // A workspace sees AI as set up (its plan includes AI) in its own status.
      const owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
      expect(ok(await as(owner).get('/ai/status'))).toMatchObject({ configured: true, provider: 'anthropic', model: 'claude-opus-5-5' });
    });

    it('keeps the saved key when the field is left empty, and records a test only for the saved values', async () => {
      ok(await as(superToken).put('/platform/integrations/ai').send(values({ apiKey: '', effort: 'medium' })));
      const current = ok(await as(superToken).post('/platform/integrations/ai/test').send({ values: values({ apiKey: '', effort: 'medium' }) }));
      expect(current).toMatchObject({ ok: true, recorded: true });
      expect((await view('ai')).lastTest).toMatchObject({ ok: true, current: true });
      // Testing different values than the saved ones is not shown as the saved setting's result.
      expect(ok(await as(superToken).post('/platform/integrations/ai/test').send({ values: values({ apiKey: '', model: 'claude-haiku-5-5' }) }))).toMatchObject({ ok: true, recorded: false });
      // After a change, the earlier test no longer counts as current.
      ok(await as(superToken).put('/platform/integrations/ai').send(values({ apiKey: '', timeoutSeconds: 25 })));
      expect((await view('ai')).lastTest).toMatchObject({ ok: true, current: false });
    });

    it('does not send the saved key to a different address unless it is typed again', async () => {
      const moved = await as(superToken).post('/platform/integrations/ai/test').send({ values: values({ apiKey: '', baseUrl: 'https://elsewhere.example.com' }) });
      expect(moved.status).toBe(422);
      expect(moved.body.error.details[0]).toMatchObject({ path: 'apiKey' });
      expect((await as(superToken).put('/platform/integrations/ai').send(values({ apiKey: '', baseUrl: 'https://elsewhere.example.com' }))).status).toBe(422);
    });

    it('switches AI off from the Console, and removing the setting leaves AI off', async () => {
      const gateway = app.get(AiGatewayService);
      ok(await as(superToken).put('/platform/integrations/ai').send(values({ apiKey: '', enabled: false })));
      expect(await gateway.providerInfo()).toMatchObject({ configured: false });
      const reset = ok(await as(superToken).delete('/platform/integrations/ai'));
      expect(reset).toMatchObject({ source: 'none', enabled: false });
      expect((await as(superToken).delete('/platform/integrations/ai')).status).toBe(404);
    });
  });

  describe('Email (SMTP)', () => {
    const values = (extra: Record<string, unknown> = {}) => ({ enabled: true, host: '127.0.0.1', port: smtpPort, security: 'none', username: 'crew-mailer', password: 'smtp-secret-pass-9876', from: 'SampCrew Test <no-reply@crew.test>', ...extra });

    it('signs in and sends a real test email, and reports a wrong password', async () => {
      const wrong = ok(await as(superToken).post('/platform/integrations/email/test').send({ values: values({ password: 'nope' }), sendTo: 'ops@sampledge.test' }));
      expect(wrong.ok).toBe(false);
      expect(wrong.detail).toMatch(/Email server 127\.0\.0\.1:\d+: .*Invalid user name or password/);
      const sent = ok(await as(superToken).post('/platform/integrations/email/test').send({ values: values(), sendTo: 'ops@sampledge.test' }));
      expect(sent.ok, sent.detail).toBe(true);
      expect(sent.detail).toContain('sent a test email to ops@sampledge.test');
      const mail = mails.find((m) => m.to === 'ops@sampledge.test');
      expect(mail?.body).toContain('Subject: SampCrew test email');
      expect(mail?.body).toContain('From: SampCrew Test <no-reply@crew.test>');
    });

    it('needs the password when a user name is given', async () => {
      const res = await as(superToken).put('/platform/integrations/email').send(values({ password: undefined }));
      expect(res.status).toBe(422);
      expect(res.body.error.details[0].path).toBe('password');
    });

    it('delivers queued email with the saved settings, and stops when switched off', async () => {
      const mailer = app.get(MailerService);
      expect(await mailer.isConfigured()).toBe(false);
      ok(await as(superToken).put('/platform/integrations/email').send(values()));
      expect(await mailer.isConfigured()).toBe(true);
      const to = `queued.${stamp}@crew.test`;
      await pool.insert('email_messages', { tenant_id: t.id, to_email: to, subject: 'Queued via Console SMTP', text_body: 'Hello', template: 'test' });
      const r = await mailer.sendBatch(500);
      expect(r.sent).toBeGreaterThan(0);
      expect(mails.find((m) => m.to === to)?.body).toContain('Queued via Console SMTP');
      expect((await pool.one('email_messages', { to_email: to }))!.status).toBe('sent');

      ok(await as(superToken).put('/platform/integrations/email').send(values({ password: '', enabled: false })));
      const off = `off.${stamp}@crew.test`;
      await pool.insert('email_messages', { tenant_id: t.id, to_email: off, subject: 'Should not go', text_body: 'x', template: 'test' });
      await mailer.sendBatch(500);
      expect(await pool.one('email_messages', { to_email: off })).toMatchObject({ status: 'skipped', last_error: 'Email delivery is not set up (Settings > Email setup in the workspace, or Super Admin Console > Integrations > Email)' });
      ok(await as(superToken).delete('/platform/integrations/email'));
    });
  });

  describe('Mobile push (Expo)', () => {
    it('checks the push service accepts requests, refuses a bad token, and alerts one device', async () => {
      const check = ok(await as(superToken).post('/platform/integrations/push/test').send({ values: { enabled: true } }));
      expect(check).toMatchObject({ ok: true });
      expect(check.detail).toContain('accepted SampCrew\'s request');
      const bad = ok(await as(superToken).post('/platform/integrations/push/test').send({ values: { enabled: true, accessToken: 'expo-wrong-token-000000' } }));
      expect(bad.ok).toBe(false);
      expect(bad.detail).toMatch(/refused the access token \(401\)/);
      const device = ok(await as(superToken).post('/platform/integrations/push/test').send({ values: { enabled: true, accessToken: 'expo-good-access-token-0001' }, pushToken: 'ExponentPushToken[abcdefghij123]' }));
      expect(device).toMatchObject({ ok: true });
      expect(pushes.at(-1)).toMatchObject({ auth: 'Bearer expo-good-access-token-0001', body: [{ to: 'ExponentPushToken[abcdefghij123]' }] });
    });

    it('switches push on for the push sender', async () => {
      const svc = app.get(PlatformIntegrationsService);
      expect((await svc.push()).enabled).toBe(false);
      ok(await as(superToken).put('/platform/integrations/push').send({ enabled: true, accessToken: 'expo-good-access-token-0001' }));
      expect(await svc.push()).toEqual({ enabled: true, accessToken: 'expo-good-access-token-0001' });
      ok(await as(superToken).delete('/platform/integrations/push'));
    });
  });

  describe('Virus scanning and mobile sign-in', () => {
    it('pings the scanner, and turns upload scanning on and off', async () => {
      expect(ok(await as(superToken).post('/platform/integrations/scanning/test').send({ values: { enabled: true, url: clamdUrl } }))).toMatchObject({ ok: true });
      const down = ok(await as(superToken).post('/platform/integrations/scanning/test').send({ values: { enabled: true, url: 'tcp://127.0.0.1:1' } }));
      expect(down.ok).toBe(false);
      const svc = app.get(PlatformIntegrationsService);
      ok(await as(superToken).put('/platform/integrations/scanning').send({ enabled: true, url: clamdUrl }));
      expect(await svc.scanningUrl()).toBe(clamdUrl);
      const health = ok(await as(superToken).get('/platform/health'));
      expect(health.uploadScanning).toEqual({ configured: true, reachable: true });
      ok(await as(superToken).put('/platform/integrations/scanning').send({ enabled: false, url: clamdUrl }));
      expect(await svc.scanningUrl()).toBeNull();
      ok(await as(superToken).delete('/platform/integrations/scanning'));
    });

    it('controls which app addresses may receive single sign-on', async () => {
      const svc = app.get(PlatformIntegrationsService);
      ok(await as(superToken).put('/platform/integrations/mobile_sso').send({ enabled: true, redirects: ['crew://sso', 'acme-crew://sso', 'crew://sso'] }));
      expect(await svc.mobileSsoRedirects()).toEqual(['crew://sso', 'acme-crew://sso']);
      const refused = await api(app).post('/auth/sso/start').set('x-crew-client', 'mobile').send({ email: `x@${t.slug}.test`, returnTo: 'evil://sso', appChallenge: 'a'.repeat(43) });
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body.error.code).toBe('return_to_not_allowed');
      ok(await as(superToken).put('/platform/integrations/mobile_sso').send({ enabled: false, redirects: ['crew://sso'] }));
      expect(await svc.mobileSsoRedirects()).toEqual([]);
      ok(await as(superToken).delete('/platform/integrations/mobile_sso'));
      expect(await svc.mobileSsoRedirects()).toEqual(['crew://sso']);
    });
  });

  describe('Off-site backups', () => {
    const values = (extra: Record<string, unknown> = {}) => ({ enabled: true, provider: 's3', bucket: 'sampcrew-backups', region: 'ap-south-1', endpoint: s3Url, accessKeyId: S3_KEY_ID, secretAccessKey: S3_SECRET, path: 'prod', keepDays: 30, ...extra });

    it('writes, lists and deletes a check file with the keys on screen, and names a wrong secret', async () => {
      const good = ok(await as(superToken).post('/platform/integrations/backups/test').send({ values: values() }));
      expect(good, JSON.stringify(good)).toMatchObject({ ok: true });
      expect(good.detail).toContain('Wrote, listed and deleted a check file in sampcrew-backups');
      expect(s3Requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'PUT /sampcrew-backups/prod/.sampcrew-connection-check', 'GET /sampcrew-backups/', 'DELETE /sampcrew-backups/prod/.sampcrew-connection-check',
      ]);
      expect(s3Objects.size).toBe(0);
      const bad = ok(await as(superToken).post('/platform/integrations/backups/test').send({ values: values({ secretAccessKey: 'not-the-right-secret-0000' }) }));
      expect(bad.ok).toBe(false);
      expect(bad.detail).toContain('the secret access key does not match the access key id');
      const bucket = ok(await as(superToken).post('/platform/integrations/backups/test').send({ values: values({ bucket: 'no-such-bucket' }) }));
      expect(bucket.detail).toContain('the bucket no-such-bucket does not exist');
    });

    it('saves the storage keys encrypted, keeps only the chosen provider\'s fields, and hides them from workspaces', async () => {
      const incomplete = await as(superToken).put('/platform/integrations/backups').send(values({ secretAccessKey: undefined }));
      expect(incomplete.status).toBe(422);
      expect(incomplete.body.error.details).toEqual([{ path: 'secretAccessKey', message: 'Paste the secret access key' }]);
      expect((await as(superToken).put('/platform/integrations/backups').send(values({ provider: 'sftp' }))).status).toBe(422);
      const saved = ok(await as(superToken).put('/platform/integrations/backups').send(values({ account: 'ignoredaccount', alertWebhook: 'https://hooks.example.test/backup-alerts-123456' })));
      expect(saved).toMatchObject({ source: 'console', enabled: true, settings: { provider: 's3', bucket: 'sampcrew-backups', accessKeyId: S3_KEY_ID }, secrets: { secretAccessKey: { set: true, hint: `••••${S3_SECRET.slice(-4)}` }, alertWebhook: { set: true } } });
      expect(saved.settings.account).toBeUndefined();
      expect(JSON.stringify(saved)).not.toContain(S3_SECRET);
      const row = (await pool.find('platform_integrations', { key: 'backups' }))[0]!;
      expect(row.secrets_enc).toMatch(/^v2\./);
      // The same values the backup service turns into rclone settings.
      const r = await app.get(PlatformIntegrationsService).resolve('backups');
      expect(offsiteEnvironment(r.enabled, r.settings, r.secrets)).toMatchObject({
        RCLONE_CONFIG_OFFSITE_TYPE: 's3', RCLONE_CONFIG_OFFSITE_PROVIDER: 'Other', RCLONE_CONFIG_OFFSITE_ENDPOINT: s3Url, RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: S3_SECRET,
        BACKUP_REMOTE: 'offsite:sampcrew-backups/prod', BACKUP_REMOTE_KEEP_DAYS: '30', BACKUP_ALERT_WEBHOOK: 'https://hooks.example.test/backup-alerts-123456',
      });
      // A different storage service needs the secret typed again; the alert address is kept.
      const moved = await as(superToken).put('/platform/integrations/backups').send(values({ secretAccessKey: '', endpoint: 'http://127.0.0.1:1' }));
      expect(moved.status).toBe(422);
      expect(moved.body.error.details[0].path).toBe('secretAccessKey');
      // Switching provider drops the S3 key altogether.
      const folder = ok(await as(superToken).put('/platform/integrations/backups').send({ enabled: true, provider: 'folder', path: '/mnt/nas/sampcrew', keepDays: 0 }));
      expect(folder.secrets.secretAccessKey).toEqual({ set: false, hint: null });
      expect(folder.secrets.alertWebhook.set).toBe(true);
      const owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
      const cat = ok(await as(owner).get('/integrations/catalogue'));
      expect(cat.platformServices.map((s: { key: string }) => s.key)).not.toContain('backups');
      ok(await as(superToken).delete('/platform/integrations/backups'));
      const health = ok(await as(superToken).get('/platform/health'));
      expect(health.notConfigured).toContain('Off-site backups (Console > Integrations)');
    });
  });

  describe('moving an older release\'s environment variables into the database', () => {
    it('moves each integration once, says which lines to delete, and never reads them again', async () => {
      const svc = app.get(PlatformIntegrationsService);
      ok(await as(superToken).put('/platform/integrations/scanning').send({ enabled: true, url: clamdUrl }));
      const env = {
        AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-legacy-env-key-5678', AI_MODEL: 'claude-sonnet-5-5', AI_TIMEOUT_MS: '20000',
        SMTP_URL: 'smtp://legacy-user:legacy-smtp-pass@127.0.0.1:2525', MAIL_FROM: 'Legacy <no-reply@legacy.test>',
        CLAMAV_URL: 'tcp://other-scanner:3310', MOBILE_SSO_REDIRECTS: 'crew://sso',
      };
      expect(await svc.importLegacyEnvironment(env)).toEqual(['ai', 'email']);
      const list = ok(await as(superToken).get('/platform/integrations')) as unknown as Record<string, any>[];
      const ai = list.find((v) => v.key === 'ai');
      expect(ai).toMatchObject({ source: 'console', enabled: true, settings: { model: 'claude-sonnet-5-5', timeoutSeconds: 20 }, secrets: { apiKey: { set: true, hint: '••••5678' } }, updatedBy: 'moved from the server\'s environment variables' });
      expect(ai.imported.variables).toEqual(['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'AI_MODEL', 'AI_TIMEOUT_MS']);
      expect(list.find((v) => v.key === 'email')).toMatchObject({ enabled: true, settings: { host: '127.0.0.1', port: 2525, security: 'none', username: 'legacy-user', from: 'Legacy <no-reply@legacy.test>' }, secrets: { password: { set: true } } });
      // A setting already saved in the Console is never replaced, and a default needs no setting.
      expect(await svc.scanningUrl()).toBe(clamdUrl);
      expect(list.find((v) => v.key === 'push')).toMatchObject({ source: 'none' });
      expect(list.find((v) => v.key === 'mobile_sso')).toMatchObject({ source: 'default' });
      // Started again with the same variables: nothing moves twice.
      expect(await svc.importLegacyEnvironment(env)).toEqual([]);
      // Saving in the Console clears the notice.
      const saved = ok(await as(superToken).put('/platform/integrations/ai').send({ enabled: false, model: 'claude-sonnet-5-5', effort: 'low', refusalFallback: true, timeoutSeconds: 20 }));
      expect(saved.imported).toBeNull();
      expect(saved.secrets.apiKey.set).toBe(true);
      const imported = await pool.find('audit_events', { tenant_id: null, action: 'platform.integration_imported' });
      expect(imported.map((a) => a.resource_id).sort()).toEqual(['ai', 'email']);
      expect(imported.every((a) => a.actor_type === 'system' && a.actor_label === 'moved from the server\'s environment variables')).toBe(true);
      for (const k of ['ai', 'email', 'scanning']) ok(await as(superToken).delete(`/platform/integrations/${k}`));
    });
  });

  it('shows workspaces which services are on, without any settings', async () => {
    ok(await as(superToken).put('/platform/integrations/scanning').send({ enabled: true, url: clamdUrl }));
    const owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const cat = ok(await as(owner).get('/integrations/catalogue'));
    expect(cat.platformServices.find((s: { key: string }) => s.key === 'scanning')).toMatchObject({ name: 'Virus scanning (ClamAV)', on: true });
    expect(cat.platformServices.find((s: { key: string }) => s.key === 'email')).toMatchObject({ on: false });
    expect(JSON.stringify(cat.platformServices)).not.toContain(clamdUrl);
    ok(await as(superToken).delete('/platform/integrations/scanning'));
  });

  it('writes every change and test to the platform audit trail, without secrets', async () => {
    const audit = (await pool.find('audit_events', { tenant_id: null, resource_type: 'platform_integration' }, { sort: { chain_seq: 1 } }))
      .map((a) => ({ action: a.action, resource_id: a.resource_id, changes: JSON.stringify(a.changes), metadata: JSON.stringify(a.metadata) }));
    const actions = new Set(audit.map((a) => a.action));
    expect(actions).toEqual(new Set(['platform.integration_saved', 'platform.integration_tested', 'platform.integration_reset', 'platform.integration_imported']));
    const all = JSON.stringify(audit);
    for (const secret of ['sk-ant-test-good-key-1234', 'smtp-secret-pass-9876', 'expo-good-access-token-0001', S3_SECRET, 'sk-ant-legacy-env-key-5678', 'legacy-smtp-pass']) expect(all).not.toContain(secret);
    // Nothing secret is stored in the clear either.
    const rows = JSON.stringify(await pool.find('platform_integrations', {}));
    for (const secret of [S3_SECRET, 'sk-ant-legacy-env-key-5678', 'legacy-smtp-pass']) expect(rows).not.toContain(secret);
  });
});
