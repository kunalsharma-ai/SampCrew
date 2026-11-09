import { priceBid } from '@crew/contracts';
import type { INestApplication } from '@nestjs/common';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../src/platform/config/config';
import { MailerService } from '../src/platform/notify/mailer.service';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { addMember, adminPool, api, createApp, createTenant, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/** Staffing bids: clients, templates, exact pricing, approval before sending, the proposal PDF and scheduled email. */
describe('staffing bids', () => {
  let app: INestApplication;
  let pool: TestDb;
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
  let firstLink = '';
  /** The acceptance link in a raw (possibly quoted-printable) email. */
  const linkIn = (raw: string) => {
    const m = raw.replace(/=\r?\n/g, '').match(/\/proposal\/([A-Za-z0-9_-]{32})/);
    expect(m, 'no acceptance link in the email').toBeTruthy();
    return m![1]!;
  };
  const binary = (r: { buffer: (b: boolean) => any }) => r.buffer(true).parse((res: NodeJS.ReadableStream, cb: (e: null, b: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
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
    firstLink = linkIn(mail!.body);
    expect(mail?.body).toContain('Contract value: INR');
    expect(mail?.body).toMatch(/Content-Type: application\/pdf; name=BID-0001-v1\.pdf/);
    b = ok(await as('recruiter').get(`/staffing/bids/${bidId}`));
    expect(b.status).toBe('sent');
    expect(b.emails.find((e: { id: string }) => e.id === now.id).delivery[0].status).toBe('sent');
    // The same PDF version is reused; no second "sent" version.
    expect(b.versions.filter((v: { event: string }) => v.event === 'sent')).toHaveLength(1);
    // The PDF made for the cancelled schedule (dated tomorrow) was never seen, so it was made again for today.
    const issued = await pool.find('bid_versions', { bid_id: bidId, event: 'sent' });
    expect(issued[0]!.snapshot.issuedOn).toBe(new Date().toISOString().slice(0, 10));
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
    const audit = await pool.find('audit_events', { tenant_id: t.id, resource_type: 'staffing_bid' }, { sort: { created_at: 1 } });
    expect(audit.map((r) => r.action)).toEqual(expect.arrayContaining(['bid.created', 'bid.submitted', 'bid.approved', 'bid.proposal_scheduled', 'bid.email_cancelled', 'bid.withdrawn', 'bid.deleted']));
  });

  /** Submits, approves and emails a fresh bid; returns its id and the links sent to each recipient. */
  const sendFresh = async (title: string, to: string, cc: string[] = []) => {
    const d = ok(await as('recruiter').post('/staffing/bids').send(bid({ title })), 201);
    ok(await as('recruiter').post(`/staffing/bids/${d.id}/submit`));
    const inbox = ok(await as('finance').get('/approvals/inbox')) as unknown as { id: string; summary: string }[];
    ok(await as('finance').post(`/approvals/${inbox.find((i) => i.summary.includes(title))!.id}/approve`).send({}));
    ok(await as('recruiter').post(`/staffing/bids/${d.id}/send`).send({ to, cc, subject: `Proposal ${d.code}`, message: 'Please review.' }), 201);
    await app.get(MailerService).sendBatch(500);
    const links: Record<string, string> = {};
    for (const r of [to, ...cc]) links[r] = linkIn(received.filter((m) => m.to === r).at(-1)!.body);
    return { id: d.id as string, code: d.code as string, links };
  };
  const pub = api as unknown as (a: INestApplication) => ReturnType<typeof api>;
  const signer = { signerName: 'Meera Nair', signerTitle: 'Head of Operations', signerEmail: 'meera@acme.test', signature: 'meera  nair', authorised: true };

  it('lets the client accept online with a typed signature, keeping a signed copy and marking the bid won', async () => {
    // The first link went out with version 1 of a bid that was since changed and withdrawn.
    expect(ok(await pub(app).get(`/public/proposals/${firstLink}`)).status).toBe('withdrawn');
    expect((await pub(app).post(`/public/proposals/${firstLink}/accept`).send(signer)).status).toBe(409);
    expect((await pub(app).get('/public/proposals/not-a-token')).status).toBe(404);
    expect((await pub(app).get(`/public/proposals/${'x'.repeat(32)}`)).status).toBe(404);

    const f = await sendFresh('Forklift operators', 'meera@acme.test', ['ops2@acme.test']);
    const view = ok(await pub(app).get(`/public/proposals/${f.links['meera@acme.test']}`));
    expect(view).toMatchObject({ status: 'open', code: f.code, version: 1, clientName: 'Acme Logistics', headcount: 5, decision: null });
    expect(view.lines).toEqual([{ roleTitle: 'Recruiter', location: 'Bengaluru', headcount: 5, billMonthly: expect.any(String), monthlyRevenue: expect.any(String) }]);
    // Never pay, costs or margins.
    expect(JSON.stringify(view)).not.toMatch(/"(payMonthly|loadedCostMonthly|monthlyCost|monthlyMargin|marginPct|markupPct|contractCost)"/);
    ok(await pub(app).get(`/public/proposals/${f.links['meera@acme.test']}`));
    let b = ok(await as('recruiter').get(`/staffing/bids/${f.id}`));
    expect(b.emails[0].links).toEqual([
      expect.objectContaining({ to: 'meera@acme.test', viewCount: 2, decision: null, revoked: false, firstViewedAt: expect.any(String) }),
      expect.objectContaining({ to: 'ops2@acme.test', viewCount: 0, firstViewedAt: null }),
    ]);
    const seen = await pool.find('notifications', { tenant_id: t.id, kind: 'bid.viewed' });
    expect(seen.map((r) => r.title)).toEqual([`Acme Logistics opened proposal ${f.code}`]);

    const original = await binary(pub(app).get(`/public/proposals/${f.links['meera@acme.test']}/proposal.pdf`));
    expect(original.status).toBe(200);
    const accept = (body: unknown) => pub(app).post(`/public/proposals/${f.links['meera@acme.test']}/accept`).send(body);
    expect((await accept({ ...signer, signature: 'M Nair' })).status).toBe(422);
    expect((await accept({ ...signer, authorised: false })).status).toBe(422);
    const done = ok(await accept(signer));
    expect(done).toMatchObject({ status: 'accepted', decision: { kind: 'accepted', by: 'Meera Nair', title: 'Head of Operations' } });
    expect((await accept(signer)).status).toBe(409);

    b = ok(await as('recruiter').get(`/staffing/bids/${f.id}`));
    expect(b.status).toBe('won');
    expect(b.outcomeReason).toBe('Accepted online by Meera Nair, Head of Operations');
    expect(b.acceptance).toMatchObject({ decision: 'accepted', sentTo: 'meera@acme.test', signerName: 'Meera Nair', signerEmail: 'meera@acme.test', version: 1, hasSignedPdf: true });
    // The cc recipient's link now shows the proposal as answered.
    expect(ok(await pub(app).get(`/public/proposals/${f.links['ops2@acme.test']}`)).status).toBe('closed');
    expect((await pub(app).post(`/public/proposals/${f.links['ops2@acme.test']}/decline`).send({ signerName: 'Ops', signerEmail: 'ops2@acme.test', reason: 'Too late' })).status).toBe(409);

    // The signed copy is the PDF as sent plus an acceptance page, for the team and through the link.
    const signed = await binary(as('recruiter').get(`/staffing/bids/${f.id}/signed.pdf`));
    expect(signed.status).toBe(200);
    expect(signed.headers['content-disposition']).toContain(`${f.code}-v1-signed.pdf`);
    const pages = async (x: Buffer) => (await PDFDocument.load(x)).getPageCount();
    expect(await pages(signed.body)).toBe((await pages(original.body)) + 1);
    const viaLink = await binary(pub(app).get(`/public/proposals/${f.links['meera@acme.test']}/proposal.pdf`));
    expect(Buffer.compare(viaLink.body, signed.body)).toBe(0);
    const stored = (await pool.one('bid_acceptance_links', { bid_id: f.id, decision: 'accepted' }))!;
    expect(stored.pdf_sha256).toBe(createHash('sha256').update(original.body).digest('hex'));
    expect((await as('stranger').get(`/staffing/bids/${f.id}/signed.pdf`)).status).toBe(404);
    expect((await as('recruiter').get(`/staffing/bids/${bidId}/signed.pdf`)).status).toBe(404);

    const notes = await pool.find('notifications', { tenant_id: t.id, kind: { $regex: '^bid\\.' } });
    expect(notes.map((r) => r.kind)).toContain('bid.accepted');
    const audit = await pool.find('audit_events', { tenant_id: t.id, resource_id: f.id }, { sort: { created_at: 1 } });
    const acc = audit.find((r) => r.action === 'bid.accepted_online');
    expect(acc).toMatchObject({ actor_type: 'system', metadata: expect.objectContaining({ signerEmail: 'meera@acme.test', sentTo: 'meera@acme.test' }) });
    expect(audit.map((r) => r.action)).toContain('bid.proposal_viewed');
  });

  it('lets the client decline with a reason, and stops links for replaced or expired proposals', async () => {
    const f = await sendFresh('Packers for the festive season', 'lata@acme.test');
    const link = f.links['lata@acme.test']!;
    expect((await pub(app).post(`/public/proposals/${link}/decline`).send({ signerName: 'Lata', signerEmail: 'lata@acme.test', reason: '' })).status).toBe(422);
    const d = ok(await pub(app).post(`/public/proposals/${link}/decline`).send({ signerName: 'Lata Rao', signerEmail: 'lata@acme.test', reason: 'We chose a vendor closer to the site' }));
    expect(d).toMatchObject({ status: 'declined', decision: { kind: 'declined', by: 'Lata Rao', reason: 'We chose a vendor closer to the site' } });
    const b = ok(await as('recruiter').get(`/staffing/bids/${f.id}`));
    expect(b.status).toBe('lost');
    expect(b.acceptance).toMatchObject({ decision: 'declined', reason: 'We chose a vendor closer to the site', hasSignedPdf: false });

    // Changing a sent bid replaces its link; an expired link can no longer be used.
    const g = await sendFresh('Loaders for the new depot', 'sam@acme.test');
    const old = g.links['sam@acme.test']!;
    ok(await as('recruiter').put(`/staffing/bids/${g.id}`).send(bid({ title: 'Loaders for the new depot', durationMonths: 9 })));
    expect(ok(await pub(app).get(`/public/proposals/${old}`)).status).toBe('replaced');
    const h = await sendFresh('Pickers for the night shift', 'ria@acme.test');
    await pool.update('bid_acceptance_links', { bid_id: h.id }, { $set: { expires_at: new Date(Date.now() - 60_000) } });
    expect(ok(await pub(app).get(`/public/proposals/${h.links['ria@acme.test']}`)).status).toBe('expired');
    expect((await pub(app).post(`/public/proposals/${h.links['ria@acme.test']}/accept`).send({ ...signer, signerEmail: 'ria@acme.test' })).status).toBe(409);
    // A scheduled email that is cancelled takes its link with it.
    const i = await sendFresh('Drivers for the airport run', 'raj@acme.test');
    const later = ok(await as('recruiter').post(`/staffing/bids/${i.id}/send`).send({ to: 'raj2@acme.test', subject: 'Later', message: 'Later', sendAt: new Date(Date.now() + 86_400_000).toISOString() }), 201);
    const queued = (await pool.one('bid_acceptance_links', { bid_email_id: later.id }))!;
    expect(queued.active_from.getTime()).toBeGreaterThan(Date.now());
    ok(await as('recruiter').post(`/staffing/bids/${i.id}/emails/${later.id}/cancel`));
    expect((await pool.one('bid_acceptance_links', { bid_email_id: later.id }))!.revoked_at).toBeTruthy();
  });

  it('keeps rate cards, checks bids against them, and adds one-off fees to the contract', async () => {
    const card = ok(await as('recruiter').post('/staffing/rate-cards').send({ name: 'Acme standard', clientId, lines: [{ roleTitle: 'Recruiter', payMonthly: '40000', billMonthly: '60000' }, { roleTitle: 'Sourcer', payMonthly: '30000', billMonthly: '45000' }] }), 201);
    expect(card).toMatchObject({ name: 'Acme standard', clientName: 'Acme Logistics', currency: 'INR' });
    expect((await as('recruiter').post('/staffing/rate-cards').send({ name: 'acme standard', lines: [{ roleTitle: 'X y', payMonthly: '1', billMonthly: '2' }] })).status).toBe(409);
    expect((await as('employee').get('/staffing/rate-cards')).status).toBe(403);
    expect((await as('finance').post('/staffing/rate-cards').send({ name: 'F', lines: [{ roleTitle: 'X y', payMonthly: '1', billMonthly: '2' }] })).status).toBe(403);
    expect(ok(await as('stranger').get('/staffing/rate-cards'))).toEqual([]);
    const usd = ok(await as('recruiter').post('/staffing/rate-cards').send({ name: 'US rates', currency: 'USD', lines: [{ roleTitle: 'Recruiter', payMonthly: '4000', billMonthly: '6000' }] }), 201);
    const other = ok(await as('recruiter').post('/staffing/clients').send({ name: 'Other Client' }), 201);
    expect((await as('recruiter').post('/staffing/bids').send(bid({ rateCardId: usd.id }))).body.error.code).toBe('rate_card_currency');
    expect((await as('recruiter').post('/staffing/bids').send(bid({ clientId: other.id, rateCardId: card.id }))).body.error.code).toBe('rate_card_client');

    const fees = [{ label: 'Sourcing drive', amount: '200000', cost: '50000', billing: 'on_signing' }];
    const b = ok(await as('recruiter').post('/staffing/bids').send(bid({ rateCardId: card.id, fees, lines: [{ roleTitle: 'recruiter', headcount: 5, payMonthly: '40000', billMonthly: '55000' }] })), 201);
    expect(b).toMatchObject({ rateCardId: card.id, rateCardName: 'Acme standard', fees });
    expect(b.pricing.lines[0]).toMatchObject({ rateCardBill: '60000.00', belowRateCard: true });
    expect(b.pricing).toMatchObject({ feesTotal: '200000.00', feesCost: '50000.00', contractRevenue: '1850000.00', belowRateCard: 1 });
    const listed = (ok(await as('recruiter').get('/staffing/bids')) as unknown as { id: string; contractRevenue: string }[]).find((x) => x.id === b.id);
    expect(listed?.contractRevenue).toBe('1850000.00');
    ok(await as('recruiter').post(`/staffing/bids/${b.id}/submit`));
    const inbox = ok(await as('finance').get('/approvals/inbox')) as unknown as { summary: string }[];
    expect(inbox.find((i) => i.summary.startsWith(b.code))?.summary).toMatch(/plus INR 2,00,000\.00 in one-off fees.*1 role\(s\) below the rate card/);
    const pdf = await binary(as('recruiter').get(`/staffing/bids/${b.id}/proposal.pdf`));
    expect(pdf.status).toBe(200);
    // Archiving a card keeps the bids that used it as they are.
    expect((await as('recruiter').delete(`/staffing/rate-cards/${card.id}`)).status).toBe(204);
    expect((ok(await as('recruiter').get('/staffing/rate-cards')) as unknown as { id: string }[]).map((x) => x.id)).toEqual([usd.id]);
    expect(ok(await as('recruiter').get(`/staffing/bids/${b.id}`)).pricing.belowRateCard).toBe(1);
  });
});
