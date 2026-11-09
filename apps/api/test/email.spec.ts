import type { INestApplication } from '@nestjs/common';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailerService } from '../src/platform/notify/mailer.service';
import { resetConfigForTests } from '../src/platform/config/config';
import { adminPool, api, createApp, createTenant, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/** Email goes out over real SMTP (a local test server here; Mailpit or a provider's SMTP relay in practice). */
describe('email delivery', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let server: SMTPServer;
  const received: { to: string; body: string }[] = [];

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, session, cb) {
        let body = '';
        stream.on('data', (c: Buffer) => (body += c.toString()));
        stream.on('end', () => {
          received.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), body });
          cb();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.server.address() as { port: number }).port;
    process.env.SMTP_URL = `smtp://127.0.0.1:${port}`;
    resetConfigForTests();
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.SMTP_URL;
    resetConfigForTests();
  });

  it('sends the invitation email queued by an invite, with a working link', async () => {
    const owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const res = await api(app, owner).post('/members/invite').send({ email: `new.joiner@${t.slug}.test`, fullName: 'New Joiner', roleKeys: ['employee'] });
    expect(res.status).toBe(201);
    expect(res.body.delivery).toBe('email_queued');
    const r = await app.get(MailerService).sendBatch(500);
    expect(r.sent).toBeGreaterThan(0);
    const mail = received.find((m) => m.to === `new.joiner@${t.slug}.test`);
    expect(mail?.body).toContain('accept-invite?token=');
    const row = (await pool.one('email_messages', { to_email: `new.joiner@${t.slug}.test` }))!;
    expect({ status: row.status, sent: row.sent_at instanceof Date }).toEqual({ status: 'sent', sent: true });
  });
});
