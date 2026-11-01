import { priceBid } from '@crew/contracts';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../src/platform/config/config';
import { MailerService } from '../src/platform/notify/mailer.service';
import { addMember, adminPool, api, createApp, createTenant, loginWithMfa, type TestTenant } from './helpers';

/** Staffing bids: clients, templates, exact pricing, approval before sending, the proposal PDF and scheduled email. */
describe('staffing bids', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let other: TestTenant;
  let server: SMTPServer;
  const received: { to: string; body: string }[] = [];
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  let clientId = '';
  let bidId = '';
  const startDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const bid = (over: Record<string, unknown> = {}) => ({
    clientId, legalEntityId: t.legalEntityId, title: 'Recruiters for the Q1 hiring drive', mode: 'quick', startDate, durationMonths: 6,
    onCostPct: '13', overheadPct: '5', targetMarginPct: '18', lines: [{ roleTitle: 'Recruiter', headcount: 5, location: 'Bengaluru', payMonthly: '40000' }], ...over,
  });

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
    process.env.SMTP_URL = `smtp://127.0.0.1:${(server.server.address() as { port: number }).port}`;
    resetConfigForTests();
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    const people = {
      recruiter: await addMember(pool, t, { roles: ['recruiter'], name: 'Kabir Recruiter' }),
      finance: await addMember(pool, t, { roles: ['finance_manager'], name: 'Rohan Finance' }),
      hr: await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' }),
      employee: await addMember(pool, t, { name: 'Eve Employee' }),
      stranger: await addMember(pool, other, { roles: ['recruiter'], name: 'Other Recruiter' }),
    };
    for (const [who, p] of Object.entries(people)) tokens[who] = (await loginWithMfa(app, pool, p.email, who === 'stranger' ? other.slug : t.slug)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.SMTP_URL;
    resetConfigForTests();
  });

  it('manages clients, refusing duplicates and people without access', async () => {
    const c = ok(await as('recruiter').post('/staffing/clients').send({ name: 'Acme Logistics', legalName: 'Acme Logistics Pvt Ltd', contactName: 'Divya Shah', contactEmail: 'divya@acme.test', address: 'Plot 4, Whitefield, Bengaluru' }), 201);
    clientId = c.id;
    expect(c.currency).toBe('INR');
    expect((await as('recruiter').post('/staffing/clients').send({ name: 'acme logistics' })).status).toBe(409);
    expect((await as('employee').get('/staffing/clients')).status).toBe(403);
    expect((await as('finance').post('/staffing/clients').send({ name: 'Finance Co' })).status).toBe(403);
    expect(ok(await as('stranger').get('/staffing/clients'))).toEqual([]);
    expect((ok(await as('finance').get('/staffing/clients')) as unknown as { name: string }[]).map((x) => x.name)).toEqual(['Acme Logistics']);
  });

  it('starts every workspace with a default template and keeps one default', async () => {
    const list = ok(await as('recruiter').get('/staffing/templates')) as unknown as { id: string; isDefault: boolean; terms: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.isDefault).toBe(true);
    expect(list[0]!.terms).toContain('30 days');
    const tpl = ok(await as('recruiter').post('/staffing/templates').send({ name: 'Volume hiring', targetMarginPct: '22', isDefault: true }), 201);
    const after = ok(await as('recruiter').get('/staffing/templates')) as unknown as { id: string; isDefault: boolean }[];
    expect(after.filter((x) => x.isDefault).map((x) => x.id)).toEqual([tpl.id]);
    expect((await as('recruiter').post('/staffing/templates').send({ name: 'Bad', targetMarginPct: '100' })).status).toBe(422);
  });

  it('prices a quick bid exactly on the server and scopes who can see it', async () => {
    const b = ok(await as('recruiter').post('/staffing/bids').send(bid()), 201);
    bidId = b.id;
    expect(b.code).toBe('BID-0001');
    expect(b.status).toBe('draft');
    expect(b.pricing).toEqual(priceBid(bid() as never));
    expect(b.pricing.lines[0].billMonthly).toBe('57561.00');
    expect(b.pricing.contractRevenue).toBe('1726830.00');
    expect(b.can).toMatchObject({ edit: true, submit: true, send: false, delete: true });
    const list = ok(await as('hr').get('/staffing/bids')) as unknown as { code: string; marginPct: string; clientName: string }[];
    expect(list).toEqual([expect.objectContaining({ code: 'BID-0001', marginPct: '18.00', clientName: 'Acme Logistics' })]);
    expect((await as('employee').get(`/staffing/bids/${bidId}`)).status).toBe(403);
    expect((await as('stranger').get(`/staffing/bids/${bidId}`)).status).toBe(404);
    expect((await as('recruiter').post('/staffing/bids').send(bid({ clientId: '00000000-0000-4000-8000-000000000000' }))).status).toBe(400);
  });

  it('keeps a draft editable, then locks it while it waits for approval', async () => {
    const b = ok(await as('recruiter').put(`/staffing/bids/${bidId}`).send(bid({
      mode: 'advanced',
      lines: [
        { roleTitle: 'Senior recruiter', headcount: 1, location: 'Bengaluru', payMonthly: '90000', billMonthly: '130000' },
        { roleTitle: 'Recruiter', headcount: 4, location: 'Pune', payMonthly: '40000' },
      ],
    })));
    expect(b.pricing.headcount).toBe(5);
    expect(b.version).toBe(1);
    expect((await as('recruiter').post(`/staffing/bids/${bidId}/send`).send({ to: 'divya@acme.test', subject: 'Proposal', message: 'Hello' })).status).toBe(409);
    const s = ok(await as('recruiter').post(`/staffing/bids/${bidId}/submit`));
    expect(s.status).toBe('pending_approval');
    expect((await as('recruiter').put(`/staffing/bids/${bidId}`).send(bid())).status).toBe(409);
    const inbox = ok(await as('finance').get('/approvals/inbox')) as unknown as { id: string; summary: string }[];
    const item = inbox.find((i) => i.summary.startsWith('BID-0001'));
    expect(item?.summary).toContain('margin 18.11% (target 18%)');
    expect((ok(await as('recruiter').get('/approvals/inbox')) as unknown as unknown[]).length).toBe(0);
    ok(await as('finance').post(`/approvals/${item!.id}/approve`).send({}));
    const after = ok(await as('recruiter').get(`/staffing/bids/${bidId}`));
    expect(after.status).toBe('approved');
    expect(after.approval.steps[0]).toMatchObject({ status: 'approved', decidedBy: 'Rohan Finance' });
    expect(after.versions).toEqual([expect.objectContaining({ version: 1, event: 'submitted' })]);
  });

  it('renders the client proposal as a PDF', async () => {
    const r = await as('recruiter').get(`/staffing/bids/${bidId}/proposal.pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('schedules the proposal email, lets it be cancelled, and sends it with the PDF attached', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const later = ok(await as('recruiter').post(`/staffing/bids/${bidId}/send`).send({ to: 'divya@acme.test', cc: ['ops@acme.test'], subject: 'Staffing proposal BID-0001', message: 'Dear Divya, please find our proposal attached.', sendAt: tomorrow }), 201);
    expect(later.recipients).toBe(2);
    let b = ok(await as('recruiter').get(`/staffing/bids/${bidId}`));
    expect(b.status).toBe('sent');
    expect(b.emails[0].delivery.map((d: { status: string }) => d.status)).toEqual(['queued', 'queued']);
    expect(b.versions.map((v: { event: string; hasPdf: boolean }) => [v.event, v.hasPdf])).toEqual([['sent', true], ['submitted', false]]);
    await app.get(MailerService).sendBatch(500);
    expect(received.filter((m) => m.to === 'divya@acme.test')).toHaveLength(0);
    ok(await as('recruiter').post(`/staffing/bids/${bidId}/emails/${later.id}/cancel`));
    b = ok(await as('recruiter').get(`/staffing/bids/${bidId}`));
    expect(b.status).toBe('approved');
    expect(b.emails[0].delivery.map((d: { status: string }) => d.status)).toEqual(['cancelled', 'cancelled']);
    expect((await as('recruiter').post(`/staffing/bids/${bidId}/emails/${later.id}/cancel`)).status).toBe(409);
    expect((await as('recruiter').post(`/staffing/bids/${bidId}/send`).send({ to: 'divya@acme.test', subject: 'Proposal', message: 'Hi', sendAt: '2020-01-01T00:00:00Z' })).status).toBe(400);

    const now = ok(await as('recruiter').post(`/staffing/bids/${bidId}/send`).send({ to: 'divya@acme.test', subject: 'Staffing proposal BID-0001', message: 'Dear Divya, please find our proposal attached.' }), 201);
    await app.get(MailerService).sendBatch(500);
    const mail = received.find((m) => m.to === 'divya@acme.test');
    expect(mail?.body).toContain('Dear Divya');
    expect(mail?.body).toContain('Contract value: INR');
    expect(mail?.body).toMatch(/Content-Type: application\/pdf; name=BID-0001-v1\.pdf/);
    b = ok(await as('recruiter').get(`/staffing/bids/${bidId}`));
    expect(b.status).toBe('sent');
    expect(b.emails.find((e: { id: string }) => e.id === now.id).delivery[0].status).toBe('sent');
    // The same PDF version is reused; no second "sent" version.
    expect(b.versions.filter((v: { event: string }) => v.event === 'sent')).toHaveLength(1);
    expect((await as('recruiter').post(`/staffing/bids/${bidId}/emails/${now.id}/cancel`)).status).toBe(409);
  });

  it('starts a new version when a sent bid changes, and keeps the history', async () => {
    const before = ok(await as('recruiter').get(`/staffing/bids/${bidId}`));
    const sentVersion = before.versions.find((v: { event: string }) => v.event === 'sent');
    const b = ok(await as('recruiter').put(`/staffing/bids/${bidId}`).send(bid({ durationMonths: 12 })));
    expect(b.version).toBe(2);
    expect(b.status).toBe('draft');
    expect(b.approval).toBeNull();
    const old = await as('recruiter').get(`/staffing/bids/${bidId}/proposal.pdf?version=${sentVersion.id}`);
    expect(old.status).toBe(200);
    expect(old.headers['content-disposition']).toContain('BID-0001-v1.pdf');
    expect((await as('recruiter').delete(`/staffing/bids/${bidId}`)).status).toBe(409);
  });

  it('records outcomes only in the right state, and withdraws', async () => {
    expect((await as('recruiter').post(`/staffing/bids/${bidId}/outcome`).send({ outcome: 'won' })).status).toBe(409);
    ok(await as('recruiter').post(`/staffing/bids/${bidId}/submit`));
    const w = ok(await as('recruiter').post(`/staffing/bids/${bidId}/outcome`).send({ outcome: 'withdrawn', reason: 'Client paused hiring' }));
    expect(w.status).toBe('withdrawn');
    const inbox = ok(await as('finance').get('/approvals/inbox')) as unknown as { summary: string }[];
    expect(inbox.some((i) => i.summary.startsWith('BID-0001'))).toBe(false);
    expect((await as('recruiter').put(`/staffing/bids/${bidId}`).send(bid())).status).toBe(409);

    const draft = ok(await as('recruiter').post('/staffing/bids').send(bid({ title: 'Warehouse associates' })), 201);
    expect(draft.code).toBe('BID-0002');
    expect((await as('recruiter').delete(`/staffing/bids/${draft.id}`)).status).toBe(204);
    const audit = await pool.query(`select action from audit_events where tenant_id = $1 and resource_type = 'staffing_bid' order by created_at`, [t.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['bid.created', 'bid.submitted', 'bid.approved', 'bid.proposal_scheduled', 'bid.email_cancelled', 'bid.withdrawn', 'bid.deleted']));
  });
});
