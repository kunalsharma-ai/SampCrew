import { createRequire } from 'node:module';
import type { INestApplication } from '@nestjs/common';
import { mongo } from '@crew/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { addMember, adminPool, api, createApp, createTenant, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

const require = createRequire(import.meta.url);
const { createPaymentsStub, RAZORPAY_SECRET, STRIPE_KEY } = require('../../../e2e/payments-stub.cjs') as {
  createPaymentsStub: (o: Record<string, unknown>) => { listen: (p?: number) => Promise<string>; close: () => Promise<void>; state: { charges: unknown[] }; config: Record<string, unknown> };
  RAZORPAY_SECRET: string;
  STRIPE_KEY: string;
};

const RZP_WEBHOOK = 'rzp_webhook_secret_for_tests';
const STRIPE_WEBHOOK = 'whsec_stripe_secret_for_tests';
const SELLER = { legalName: 'SAMPLEDGE Technologies Pvt Ltd', addressLine1: '5 Business Park', city: 'Mumbai', stateCode: '27', postalCode: '400001', countryCode: 'IN', gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F', email: 'billing@sampledge.test', sac: '998314' };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const days = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

/**
 * Subscription billing end to end against local stand-ins for Razorpay and Stripe: keys in Console > Integrations,
 * checkout and signed webhooks, GST invoices, proration, scheduled downgrades, renewals with saved cards, reminders
 * and the read-only lock, add-ons, trials, usage and overage, coupons, contract deals and the revenue report.
 */
describe('Billing: payments, invoices, add-ons, trials, usage, coupons and revenue', () => {
  let app: INestApplication;
  let pool: TestDb;
  let stub: ReturnType<typeof createPaymentsStub>;
  let stubUrl: string;
  let superToken: string;
  const stamp = Date.now().toString(36);

  async function platformToken(role: string) {
    const email = `billing.${role}.${stamp}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: `Billing ${role}`, password_hash: await hashPassword(PASSWORD), role });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    return (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken as string;
  }
  const owner = async (t: TestTenant) => (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
  /** Delivers the webhook the stub's hosted page would send for a checkout, as the provider does. */
  async function pay(provider: 'razorpay' | 'stripe', checkoutUrl: string) {
    const cid = checkoutUrl.split('/').pop()!;
    const hook = (await (await fetch(`${stubUrl}/__pay/${provider}/${cid}`, { method: 'POST' })).json()) as { body: string; headers: Record<string, string> };
    const res = await request(app.getHttpServer()).post(`/api/v1/billing/webhooks/${provider}`).set(hook.headers).send(hook.body);
    return { res, hook };
  }
  const run = (tenantId: string, asOf?: string) => api(app, superToken).post('/platform/billing/run').send({ tenantId, ...(asOf ? { asOf } : {}) });
  const sub = (tenantId: string) => pool.one('subscriptions', { tenant_id: tenantId });
  async function usdTenant(plan = 'business') {
    const slug = `u-${Math.random().toString(36).slice(2, 10)}`;
    const ownerEmail = `owner@${slug}.test`;
    const passwordHash = await hashPassword(PASSWORD);
    const t = await pool.platform((tx) => mongo.provisionTenantMongo(tx, {
      name: `US ${slug}`, slug, countryCode: 'US', currency: 'USD', timezone: 'America/New_York',
      owner: { email: ownerEmail, fullName: 'US Owner', passwordHash },
      plan: { key: plan, seats: 30, billingCycle: 'monthly', trialDays: 0 },
    }));
    return { id: t.tenantId, slug, legalEntityId: t.legalEntityId, ownerEmail, ownerMembershipId: t.ownerMembershipId } as TestTenant;
  }
  /** Puts the workspace mid-way through a 30-day period that was paid. */
  async function midPeriod(tenantId: string, daysIn = 15) {
    await pool.update('subscriptions', { tenant_id: tenantId }, { $set: { current_period_start: days(-daysIn), current_period_end: days(30 - daysIn), period_paid: true, status: 'active', trial_ends_on: null } });
  }

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    stub = createPaymentsStub({ sendWebhooks: false, razorpayWebhookSecret: RZP_WEBHOOK, stripeWebhookSecret: STRIPE_WEBHOOK });
    stubUrl = await stub.listen();
    superToken = await platformToken('super_admin');
    expect((await api(app, superToken).put('/platform/billing/settings').send({ seller: SELLER, invoicePrefix: 'SC', gstRate: '18', exportZeroRated: true, otherTaxRate: '0', otherTaxLabel: 'Tax', paymentTermsDays: 7, reminderDays: [1, 3, 7], graceDays: 14, lockAfterGrace: true, trialReminderDays: [7, 3, 1], gateways: { INR: 'razorpay', USD: 'stripe' } })).status).toBe(200);
  });
  afterAll(async () => {
    // Leave the installation as other test files expect: no gateways.
    await api(app, superToken).delete('/platform/integrations/razorpay');
    await api(app, superToken).delete('/platform/integrations/stripe');
    await pool.delete('billing_settings', {});
    await stub.close();
    await app.close();
    await pool.end();
  });

  describe('payment gateways in Console > Integrations', () => {
    it('tests Razorpay keys against the API, needs the webhook secret to switch on, and never returns secrets', async () => {
      const bad = await api(app, superToken).post('/platform/integrations/razorpay/test').send({ values: { enabled: true, keyId: 'rzp_test_abcdef123456', keySecret: 'wrong', baseUrl: stubUrl } });
      expect(bad.body).toMatchObject({ ok: false });
      expect(bad.body.detail).toMatch(/refused the API key/);
      const good = await api(app, superToken).post('/platform/integrations/razorpay/test').send({ values: { enabled: true, keyId: 'rzp_test_abcdef123456', keySecret: RAZORPAY_SECRET, baseUrl: stubUrl } });
      expect(good.body).toMatchObject({ ok: true });
      expect(good.body.detail).toMatch(/Signed in to Razorpay \(test mode\)/);
      const noHook = await api(app, superToken).put('/platform/integrations/razorpay').send({ enabled: true, keyId: 'rzp_test_abcdef123456', keySecret: RAZORPAY_SECRET, baseUrl: stubUrl });
      expect(noHook.status).toBe(422);
      expect(JSON.stringify(noHook.body)).toMatch(/webhook secret/);
      const saved = await api(app, superToken).put('/platform/integrations/razorpay').send({ enabled: true, keyId: 'rzp_test_abcdef123456', keySecret: RAZORPAY_SECRET, webhookSecret: RZP_WEBHOOK, baseUrl: stubUrl });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ key: 'razorpay', enabled: true, source: 'console', secrets: { keySecret: { set: true }, webhookSecret: { set: true } } });
      expect(saved.body.webhookUrl).toMatch(/\/api\/v1\/billing\/webhooks\/razorpay$/);
      expect(JSON.stringify(saved.body)).not.toContain(RAZORPAY_SECRET);
      // Stored encrypted.
      const row = await pool.one('platform_integrations', { key: 'razorpay' });
      expect(row!.secrets_enc).not.toContain(RAZORPAY_SECRET);
    });

    it('tests and saves Stripe keys the same way', async () => {
      const bad = await api(app, superToken).post('/platform/integrations/stripe/test').send({ values: { enabled: false, secretKey: 'sk_test_wrong', baseUrl: stubUrl } });
      expect(bad.body.ok).toBe(false);
      expect((await api(app, superToken).put('/platform/integrations/stripe').send({ enabled: true, secretKey: 'pk_test_notasecret', webhookSecret: STRIPE_WEBHOOK, baseUrl: stubUrl })).status).toBe(422);
      const saved = await api(app, superToken).put('/platform/integrations/stripe').send({ enabled: true, secretKey: STRIPE_KEY, webhookSecret: STRIPE_WEBHOOK, baseUrl: stubUrl });
      expect(saved.status).toBe(200);
      const test = await api(app, superToken).post('/platform/integrations/stripe/test').send({ values: { enabled: true, baseUrl: stubUrl } });
      expect(test.body).toMatchObject({ ok: true, recorded: true });
      expect(test.body.detail).toMatch(/Stripe \(test mode\)/);
    });

    it('refuses webhooks with a wrong signature, from an unknown provider, and replays', async () => {
      const r = await request(app.getHttpServer()).post('/api/v1/billing/webhooks/razorpay').set({ 'content-type': 'application/json', 'x-razorpay-signature': 'deadbeef' }).send('{"event":"payment_link.paid"}');
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('bad_signature');
      expect((await request(app.getHttpServer()).post('/api/v1/billing/webhooks/paypal').send({})).status).toBe(404);
      // A Stripe event signed long ago is refused even with the right secret.
      const { createHmac } = await import('node:crypto');
      const body = JSON.stringify({ id: 'evt_old', type: 'checkout.session.completed', data: { object: {} } });
      const t = Math.floor(Date.now() / 1000) - 3600;
      const old = await request(app.getHttpServer()).post('/api/v1/billing/webhooks/stripe').set({ 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${createHmac('sha256', STRIPE_WEBHOOK).update(`${t}.${body}`).digest('hex')}` }).send(body);
      expect(old.status).toBe(400);
      expect(old.body.error.message).toMatch(/too old/);
      expect(await pool.count('audit_events', { tenant_id: null, action: 'platform.payment_webhook_rejected' })).toBeGreaterThanOrEqual(2);
    });
  });

  describe('upgrades through Razorpay, with GST and proration', () => {
    let t: TestTenant;
    let token: string;

    beforeAll(async () => {
      t = await createTenant(pool, { plan: 'professional' });
      token = await owner(t);
      await midPeriod(t.id);
      expect((await api(app, token).put('/billing/profile').send({ legalName: 'Acme India Pvt Ltd', gstin: '27AAACA1234A1Z5', addressLine1: '12 MG Road', city: 'Pune', stateCode: '27', postalCode: '411001', countryCode: 'IN', email: 'ap@acme.test' })).status).toBe(200);
    });

    it('quotes the days left on the new plan less the unused part, with CGST and SGST within Maharashtra', async () => {
      const q = (await api(app, token).post('/billing/quote').send({ planKey: 'business', billingCycle: 'monthly', seats: 50 })).body;
      expect(q).toMatchObject({ mode: 'now', gateway: 'razorpay', currency: 'INR' });
      // Professional 299 x 50 = 14950, Business 499 x 50 = 24950 per 30 days; 15 days left: 12475 - 7475.
      expect(q.lines.map((l: { kind: string; amount: string }) => [l.kind, l.amount])).toEqual([['plan', '12475.00'], ['credit', '-7475.00']]);
      expect(q.subtotal).toBe('5000.00');
      expect(q.tax.lines.map((l: { label: string; amount: string }) => [l.label, l.amount])).toEqual([['CGST', '450.00'], ['SGST', '450.00']]);
      expect(q.total).toBe('5900.00');
    });

    it('sends the admin to Razorpay and applies the plan only when the signed payment arrives', async () => {
      const res = await api(app, token).put('/billing/subscription').send({ planKey: 'business', billingCycle: 'monthly', seats: 50 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ mode: 'checkout', provider: 'razorpay', total: '5900.00', currency: 'INR' });
      expect(res.body.url).toContain('/pay/razorpay/plink_');
      expect((await api(app, token).get('/billing/subscription')).body.subscription.planKey).toBe('professional');
      expect((await api(app, token).get(`/billing/orders/${res.body.orderId}`)).body.status).toBe('created');

      const { res: hook, hook: sent } = await pay('razorpay', res.body.url);
      expect(hook.status).toBe(200);
      expect(hook.body.status).toBe('processed');
      const after = (await api(app, token).get('/billing/subscription')).body.subscription;
      expect(after).toMatchObject({ planKey: 'business', status: 'active', provider: 'razorpay' });
      expect((await api(app, token).get(`/billing/orders/${res.body.orderId}`)).body.status).toBe('paid');
      const invoices = (await api(app, token).get('/billing/invoices')).body;
      expect(invoices[0]).toMatchObject({ status: 'paid', kind: 'upgrade', total: '5900.00', tax: '900.00' });
      expect(invoices[0].number).toMatch(/^SC\d{4}-\d{6}$/);
      expect((await api(app, token).get('/me')).body.features).toContain('payroll');

      // The same event again changes nothing.
      const again = await request(app.getHttpServer()).post('/api/v1/billing/webhooks/razorpay').set(sent.headers).send(sent.body);
      expect(again.body.status).toBe('duplicate');
      expect((await api(app, token).get('/billing/invoices')).body).toHaveLength(invoices.length);
    });

    it('produces a GST tax invoice PDF with both GSTINs', async () => {
      const inv = (await api(app, token).get('/billing/invoices')).body[0];
      const pdf = await api(app, token).get(`/billing/invoices/${inv.id}/pdf`).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      const stored = await pool.one('invoices', { id: inv.id });
      expect(stored!.seller.gstin).toBe(SELLER.gstin);
      expect(stored!.buyer.gstin).toBe('27AAACA1234A1Z5');
      expect(stored!.place_of_supply).toBe('Maharashtra (27)');
    });

    it('waits for the period end to move to a cheaper plan, and the renewal applies it and invoices the new period', async () => {
      const res = await api(app, token).put('/billing/subscription').send({ planKey: 'professional', billingCycle: 'monthly', seats: 50 });
      expect(res.body).toMatchObject({ mode: 'scheduled', plan: 'professional' });
      const s = (await api(app, token).get('/billing/subscription')).body.subscription;
      expect(s.planKey).toBe('business');
      expect(s.scheduledChange).toMatchObject({ planKey: 'professional', seats: 50 });
      // Cancelling it and asking again works.
      expect((await api(app, token).delete('/billing/scheduled-change')).status).toBe(200);
      expect((await api(app, token).put('/billing/subscription').send({ planKey: 'professional', billingCycle: 'monthly', seats: 50 })).body.mode).toBe('scheduled');

      const end = (await sub(t.id))!.current_period_end as string;
      const out = (await run(t.id, end)).body;
      expect(out[0]).toMatchObject({ renewed: 1 });
      const after = await sub(t.id);
      expect(after).toMatchObject({ current_period_start: end, scheduled_change: null, period_paid: false });
      expect((await api(app, token).get('/billing/subscription')).body.subscription.planKey).toBe('professional');
      const renewal = (await api(app, token).get('/billing/invoices')).body.find((i: { kind: string }) => i.kind === 'renewal');
      expect(renewal).toMatchObject({ status: 'open', subtotal: '14950.00', tax: '2691.00', total: '17641.00' });
      expect(await pool.count('billing_events', { tenant_id: t.id, kind: 'downgrade' })).toBe(1);

      // Paying the renewal invoice online.
      const p = await api(app, token).post(`/billing/invoices/${renewal.id}/pay`);
      expect(p.body).toMatchObject({ mode: 'checkout', provider: 'razorpay', total: '17641.00' });
      // Asking again reuses the same checkout.
      expect((await api(app, token).post(`/billing/invoices/${renewal.id}/pay`)).body.orderId).toBe(p.body.orderId);
      expect((await pay('razorpay', p.body.url)).res.body.status).toBe('processed');
      expect((await pool.one('invoices', { id: renewal.id }))!.status).toBe('paid');
      expect((await sub(t.id))!.period_paid).toBe(true);
    });
  });

  describe('Stripe: saved cards renew automatically', () => {
    let t: TestTenant;
    let token: string;

    beforeAll(async () => {
      t = await usdTenant('professional');
      token = await owner(t);
      await midPeriod(t.id, 10);
    });

    it('pays an upgrade on Stripe Checkout and saves the card, with no GST on an export', async () => {
      const res = await api(app, token).put('/billing/subscription').send({ planKey: 'business', billingCycle: 'monthly', seats: 30 });
      expect(res.body).toMatchObject({ mode: 'checkout', provider: 'stripe', currency: 'USD' });
      const { res: hook } = await pay('stripe', res.body.url);
      expect(hook.body.status).toBe('processed');
      const s = (await api(app, token).get('/billing/subscription')).body.subscription;
      expect(s).toMatchObject({ planKey: 'business', provider: 'stripe', savedCard: true });
      const inv = (await api(app, token).get('/billing/invoices')).body[0];
      expect(inv).toMatchObject({ status: 'paid', currency: 'USD', tax: '0.00' });
      expect((await pool.one('invoices', { id: inv.id }))!.note).toMatch(/export of services/);
    });

    it('charges the saved card at renewal; a declined card leaves the invoice open and tells the admins', async () => {
      const end = (await sub(t.id))!.current_period_end as string;
      const charges = stub.state.charges.length;
      const out = (await run(t.id, end)).body[0];
      expect(out).toMatchObject({ renewed: 1, autoCharged: 1 });
      expect(stub.state.charges.length).toBe(charges + 1);
      expect((await api(app, token).get('/billing/invoices')).body[0]).toMatchObject({ kind: 'renewal', status: 'paid', total: '420.00' });

      await fetch(`${stubUrl}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ declineCharges: true }) });
      const next = (await sub(t.id))!.current_period_end as string;
      expect((await run(t.id, next)).body[0]).toMatchObject({ renewed: 1, autoCharged: 0 });
      await fetch(`${stubUrl}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ declineCharges: false }) });
      expect((await api(app, token).get('/billing/invoices')).body[0]).toMatchObject({ kind: 'renewal', status: 'open' });
      expect(await pool.count('billing_events', { tenant_id: t.id, kind: 'payment_failed' })).toBe(1);
      expect(await pool.count('notifications', { tenant_id: t.id, kind: 'billing.payment_failed' })).toBeGreaterThan(0);
    });
  });

  describe('unpaid invoices: reminders, then read-only', () => {
    it('reminds on the set days, locks after the grace period, keeps reading and paying open, and unlocks when paid', async () => {
      const t = await createTenant(pool, { plan: 'professional' });
      const token = await owner(t);
      const created = await api(app, superToken).post(`/platform/billing/tenants/${t.id}/invoices`).send({ description: 'Onboarding services', amount: '10000', currency: 'INR' });
      expect(created.status).toBe(201);
      const invoice = (await pool.one('invoices', { id: created.body.id }))!;
      expect(invoice).toMatchObject({ status: 'open', subtotal: '10000.00', tax: '1800.00', total: '11800.00' });
      // Due 7 days after issue. 3 days late: past due and one reminder (the 3-day one).
      const due = iso(invoice.due_at as Date);
      const late = (n: number) => iso(new Date(Date.parse(`${due}T00:00:00Z`) + n * 86_400_000));
      expect((await run(t.id, late(3))).body[0]).toMatchObject({ remindersSent: 1, lockedNow: false });
      expect((await sub(t.id))!.status).toBe('past_due');
      expect((await run(t.id, late(4))).body[0]).toMatchObject({ remindersSent: 0 });
      expect((await run(t.id, late(14))).body[0]).toMatchObject({ lockedNow: true });

      const s = (await api(app, token).get('/billing/subscription')).body.subscription;
      expect(s).toMatchObject({ locked: true, status: 'past_due' });
      const blocked = await api(app, token).post('/org/departments').send({ name: 'New team' });
      expect(blocked.status).toBe(402);
      expect(blocked.body.error.code).toBe('workspace_read_only');
      expect((await api(app, token).get('/org/departments')).status).toBe(200);
      expect((await api(app, token).put('/billing/profile').send({ legalName: 'Locked Co', addressLine1: '1 Road', city: 'Delhi', stateCode: '07', postalCode: '110001', countryCode: 'IN', email: 'a@b.test' })).status).toBe(200);

      // SAMPLEDGE records the bank transfer: open again.
      expect((await api(app, superToken).post(`/platform/billing/invoices/${invoice.id}/mark-paid`).send({ reference: 'NEFT UTR 1234567' })).status).toBe(200);
      expect(await sub(t.id)).toMatchObject({ status: 'active', locked_at: null, past_due_since: null });
      expect((await api(app, token).post('/org/departments').send({ name: 'New team' })).status).not.toBe(402);
      expect(await pool.count('billing_events', { tenant_id: t.id, kind: { $in: ['locked', 'unlocked'] } })).toBe(2);
    });

    it('lets SAMPLEDGE lift the lock for 7 days and void an invoice', async () => {
      const t = await createTenant(pool, { plan: 'starter' });
      const created = (await api(app, superToken).post(`/platform/billing/tenants/${t.id}/invoices`).send({ description: 'Setup', amount: '500', currency: 'INR' })).body;
      const due = iso((await pool.one('invoices', { id: created.id }))!.due_at as Date);
      const at = (n: number) => iso(new Date(Date.parse(`${due}T00:00:00Z`) + n * 86_400_000));
      await run(t.id, at(20));
      expect((await sub(t.id))!.locked_at).not.toBeNull();
      expect((await api(app, superToken).post(`/platform/billing/tenants/${t.id}/unlock`).send({ reason: 'Customer sent the payment proof' })).status).toBe(200);
      const paused = (await sub(t.id))!;
      expect(paused.locked_at).toBeNull();
      expect(Math.abs(new Date(paused.lock_paused_until as Date).getTime() - (Date.now() + 7 * 86_400_000))).toBeLessThan(60_000);
      // The billing clock here runs ahead of the real one: move the pause to 7 days after the simulated day 20.
      await pool.update('subscriptions', { tenant_id: t.id }, { $set: { lock_paused_until: new Date(`${at(27)}T00:00:00Z`) } });
      await run(t.id, at(21));
      expect((await sub(t.id))!.locked_at).toBeNull();
      await run(t.id, at(28));
      expect((await sub(t.id))!.locked_at).not.toBeNull();
      expect((await api(app, superToken).post(`/platform/billing/invoices/${created.id}/void`).send({ reason: 'Raised by mistake' })).status).toBe(200);
      expect(await sub(t.id)).toMatchObject({ status: 'active', locked_at: null });
    });
  });

  describe('add-ons', () => {
    it('sells a module and more employees on top of a plan, and ends them with the period when removed', async () => {
      expect((await api(app, superToken).post('/platform/billing/addons').send({ key: `payroll_${stamp}`, name: 'Payroll add-on', kind: 'module', featureKey: 'payroll', prices: [{ currency: 'INR', monthly: '99', annualPerMonth: '79' }], planKeys: ['starter', 'professional'] })).status).toBe(201);
      expect((await api(app, superToken).post('/platform/billing/addons').send({ key: `seats_${stamp}`, name: '100 more employees', kind: 'limit', featureKey: 'max_employees', unitQuantity: 100, prices: [{ currency: 'INR', monthly: '1000', annualPerMonth: '800' }] })).status).toBe(201);
      expect((await api(app, superToken).post('/platform/billing/addons').send({ key: `bad_${stamp}`, name: 'Bad', kind: 'module', featureKey: 'max_employees', prices: [{ currency: 'INR', monthly: '1', annualPerMonth: '1' }] })).status).toBe(422);

      // A USD workspace on Professional has no INR price: it is not sold to it. An INR one without a gateway pays by invoice.
      await api(app, superToken).put('/platform/billing/settings').send({ seller: SELLER, invoicePrefix: 'SC', gstRate: '18', exportZeroRated: true, otherTaxRate: '0', otherTaxLabel: 'Tax', paymentTermsDays: 7, reminderDays: [1, 3, 7], graceDays: 14, lockAfterGrace: true, trialReminderDays: [7, 3, 1], gateways: { INR: 'none', USD: 'stripe' } });
      const t = await createTenant(pool, { plan: 'professional' });
      const token = await owner(t);
      await midPeriod(t.id);
      const offer = (await api(app, token).get('/billing/addons')).body as { key: string; price: string | null }[];
      expect(offer.map((a) => a.key)).toEqual(expect.arrayContaining([`payroll_${stamp}`, `seats_${stamp}`]));
      expect((await api(app, token).get('/payroll/runs')).status).toBe(402);

      const bought = await api(app, token).post('/billing/addons').send({ addonKey: `payroll_${stamp}`, quantity: 1 });
      expect(bought.status).toBe(201);
      expect(bought.body.mode).toBe('applied');
      // 99 x 50 seats? No: a module add-on is priced per month, prorated for the 15 days left: 49.50 + 18% GST.
      expect(bought.body.invoice).toMatchObject({ status: 'open', total: '58.41' });
      expect((await api(app, token).get('/me')).body.features).toContain('payroll');
      expect((await api(app, token).get('/payroll/runs')).status).toBe(200);

      const limitBefore = ((await api(app, token).get('/billing/usage')).body as { key: string; limit: number }[]).find((m) => m.key === 'max_employees')!.limit;
      expect((await api(app, token).post('/billing/addons').send({ addonKey: `seats_${stamp}`, quantity: 2 })).status).toBe(201);
      expect(((await api(app, token).get('/billing/usage')).body as { key: string; limit: number }[]).find((m) => m.key === 'max_employees')!.limit).toBe(limitBefore + 200);

      expect((await api(app, token).delete(`/billing/addons/payroll_${stamp}`)).body.endsOn).toBe((await sub(t.id))!.current_period_end);
      expect((await api(app, token).get('/me')).body.features).toContain('payroll');
      const end = (await sub(t.id))!.current_period_end as string;
      await run(t.id, end);
      expect((await api(app, token).get('/me')).body.features).not.toContain('payroll');
      const renewal = (await api(app, token).get('/billing/invoices')).body.find((i: { kind: string }) => i.kind === 'renewal');
      // Plan 14950 + 2 x 1000 employees add-on = 16950, + 18% GST.
      expect(renewal).toMatchObject({ subtotal: '16950.00', total: '20001.00' });
      // A module the plan already has cannot be bought.
      const biz = await createTenant(pool, { plan: 'business' });
      await midPeriod(biz.id);
      expect((await api(app, await owner(biz)).post('/billing/addons').send({ addonKey: `payroll_${stamp}`, quantity: 1 })).status).toBe(400);
    });
  });

  describe('trials', () => {
    it('tries a plan with the modules SAMPLEDGE chose, reminds before the end, then goes back', async () => {
      expect((await api(app, superToken).put('/platform/billing/plans/business').send({ trialDays: 14, trialFeatures: ['payroll', 'performance'], overage: {} })).status).toBe(200);
      const t = await createTenant(pool, { plan: 'starter' });
      const token = await owner(t);
      await midPeriod(t.id);
      const plans = (await api(app, token).get('/billing/plans')).body as { key: string; trialDays: number }[];
      expect(plans.find((p) => p.key === 'business')!.trialDays).toBe(14);

      const started = await api(app, token).post('/billing/trial').send({ planKey: 'business' });
      expect(started.status).toBe(201);
      expect(started.body.endsOn).toBe(days(14));
      const me = (await api(app, token).get('/me')).body.features as string[];
      expect(me).toEqual(expect.arrayContaining(['payroll', 'performance', 'core_hr']));
      expect(me).not.toContain('ai_copilot');
      expect((await api(app, token).post('/billing/trial').send({ planKey: 'business' })).status).toBe(409);

      expect((await run(t.id, days(10))).body[0]).toMatchObject({ remindersSent: 1 });
      expect((await run(t.id, days(11))).body[0]).toMatchObject({ remindersSent: 1 });
      expect((await run(t.id, days(11))).body[0]).toMatchObject({ remindersSent: 0 });
      expect((await run(t.id, days(14))).body[0]).toMatchObject({ trialsEnded: 1 });
      const s = (await api(app, token).get('/billing/subscription')).body.subscription;
      expect(s).toMatchObject({ planKey: 'starter', status: 'active', trialUsed: true });
      expect((await api(app, token).post('/billing/trial').send({ planKey: 'business' })).body.error.code).toBe('trial_used');
      await api(app, superToken).put('/platform/billing/plans/business').send({ trialDays: 0, trialFeatures: [], overage: {} });
    });

    it('converts a sign-up trial by paying for the plan, or invoices the first period when the trial ends', async () => {
      const t = await createTenant(pool, { plan: 'professional', trialDays: 14 });
      const token = await owner(t);
      const q = (await api(app, token).post('/billing/quote').send({ planKey: 'professional', billingCycle: 'monthly', seats: 50 })).body;
      expect(q).toMatchObject({ mode: 'now', trialConversion: true, subtotal: '14950.00' });
      const paid = await api(app, token).put('/billing/subscription').send({ planKey: 'professional', billingCycle: 'monthly', seats: 50 });
      expect(paid.body.mode).toBe('applied');
      expect((await sub(t.id))!.status).toBe('active');
      expect(await pool.count('billing_events', { tenant_id: t.id, kind: 'trial_converted' })).toBe(1);

      const u = await createTenant(pool, { plan: 'professional', trialDays: 14 });
      expect((await run(u.id, days(14))).body[0]).toMatchObject({ trialsEnded: 1 });
      expect(await pool.one('invoices', { tenant_id: u.id })).toMatchObject({ kind: 'subscription', status: 'open', subtotal: '14950.00' });
    });
  });

  describe('usage and overage', () => {
    it('warns at 80% and 100% once, and a plan that bills overage lets the workspace go on and invoices the extra', async () => {
      const plan = `over_${stamp}`;
      expect((await api(app, superToken).post('/platform/plans').send({ key: plan, name: 'Overage', copyFrom: 'starter', isPublic: true, minimumSeats: 1 })).status).toBe(201);
      await api(app, superToken).put(`/platform/plans/${plan}/entitlements`).send({ features: ['core_hr', 'leave'], limits: { max_employees: 5, max_legal_entities: 1, ai_credits_monthly: 0, storage_gb: 1 } });
      const t = await createTenant(pool, { plan });
      await pool.update('subscriptions', { tenant_id: t.id }, { $set: { seats: 10 } });
      const token = await owner(t);
      for (let i = 0; i < 3; i++) await addMember(pool, t);
      // 4 of 5: 80%.
      expect((await run(t.id)).body[0].usageNotices).toBe(1);
      expect((await run(t.id)).body[0].usageNotices).toBe(0);
      await addMember(pool, t);
      expect((await run(t.id)).body[0].usageNotices).toBe(1);
      const invite = () => api(app, token).post('/members/invite').send({ email: `x${Math.random().toString(36).slice(2, 8)}@${t.slug}.test`, fullName: 'Extra Person', roleKeys: ['employee'] });
      expect((await invite()).body.error?.code).toBe('plan_limit_reached');

      expect((await api(app, superToken).put(`/platform/billing/plans/${plan}`).send({ trialDays: 0, trialFeatures: [], overage: { max_employees: { policy: 'overage', prices: { INR: '50' } } } })).status).toBe(200);
      const usage = ((await api(app, token).get('/billing/usage')).body as { key: string; policy: string; percent: number }[]).find((m) => m.key === 'max_employees')!;
      expect(usage).toMatchObject({ policy: 'overage', percent: 100 });
      expect((await invite()).status).toBe(201);
      await addMember(pool, t);
      await addMember(pool, t);
      const end = (await sub(t.id))!.current_period_end as string;
      await run(t.id, end);
      const renewal = await pool.one('invoices', { tenant_id: t.id, kind: 'renewal' });
      const lines = await pool.find('invoice_lines', { invoice_id: renewal!.id });
      // 8 people (owner, 4 members, the invited one, 2 more) on a limit of 5.
      expect(lines.find((l) => l.kind === 'overage')).toMatchObject({ quantity: '3.0000', amount: '150.00' });
    });
  });

  describe('coupons and contract deals', () => {
    it('applies a coupon once per workspace, up to its limit, and rejects bad codes', async () => {
      const code = `WELCOME${stamp}`.toUpperCase();
      const c = await api(app, superToken).post('/platform/billing/coupons').send({ code, name: 'Welcome 20%', kind: 'percent', value: '20', duration: 'repeating', cycles: 2, maxRedemptions: 1, partner: 'Partner One' });
      expect(c.status).toBe(201);
      const t = await createTenant(pool, { plan: 'starter' });
      const token = await owner(t);
      await midPeriod(t.id);
      expect((await api(app, token).post('/billing/coupons/check').send({ code: 'NOPE123' })).body.error.code).toBe('coupon_invalid');
      expect((await api(app, token).post('/billing/coupons/check').send({ code: code.toLowerCase() })).body).toMatchObject({ code, kind: 'percent' });
      const q = (await api(app, token).post('/billing/quote').send({ planKey: 'professional', billingCycle: 'monthly', seats: 50, couponCode: code })).body;
      const discount = q.lines.find((l: { kind: string }) => l.kind === 'discount');
      expect(discount.description).toMatch(/20% off/);
      const res = await api(app, token).put('/billing/subscription').send({ planKey: 'professional', billingCycle: 'monthly', seats: 50, couponCode: code });
      expect(res.body.mode).toBe('applied');
      expect(await sub(t.id)).toMatchObject({ coupon_cycles_left: 1 });
      // The renewal uses the last cycle.
      await run(t.id, (await sub(t.id))!.current_period_end);
      const renewal = await pool.one('invoices', { tenant_id: t.id, kind: 'renewal' });
      expect(renewal).toMatchObject({ subtotal: '11960.00' });
      expect(await sub(t.id)).toMatchObject({ coupon_cycles_left: 0 });
      // Used up.
      const other = await createTenant(pool, { plan: 'starter' });
      expect((await api(app, await owner(other)).post('/billing/coupons/check').send({ code })).body.error.message).toMatch(/maximum/);
    });

    it('bills a contract price, discount and extra modules until the contract ends', async () => {
      const t = await createTenant(pool, { plan: 'professional' });
      const token = await owner(t);
      await midPeriod(t.id);
      const d = await api(app, superToken).put(`/platform/billing/tenants/${t.id}/deal`).send({ unitPrice: '250', discountPercent: '10', features: ['ai_copilot'], endsOn: days(400), partner: 'Reseller X', note: 'Two-year contract' });
      expect(d.status).toBe(200);
      expect((await api(app, token).get('/me')).body.features).toContain('ai_copilot');
      expect((await api(app, token).get('/billing/subscription')).body.subscription).toMatchObject({ unitPrice: '250', deal: { discountPercent: '10', partner: 'Reseller X' } });
      await run(t.id, (await sub(t.id))!.current_period_end);
      const renewal = await pool.one('invoices', { tenant_id: t.id, kind: 'renewal' });
      // 250 x 50 = 12500, less 10% = 11250.
      expect(renewal).toMatchObject({ subtotal: '11250.00' });
      const detail = (await api(app, superToken).get(`/platform/billing/tenants/${t.id}`)).body;
      expect(detail).toMatchObject({ dealActive: true, mrr: '11250.00' });
      expect((await api(app, superToken).put(`/platform/billing/tenants/${t.id}/deal`).send({ features: [] })).body.deal).toBeNull();
      expect((await api(app, token).get('/me')).body.features).not.toContain('ai_copilot');
    });
  });

  describe('revenue report', () => {
    it('reports MRR, ARR, movements, trial conversion, collected and outstanding money and plans', async () => {
      const viewer = await platformToken('viewer');
      const r = await api(app, viewer).get('/platform/billing/revenue');
      expect(r.status).toBe(200);
      expect(Number(r.body.mrr.INR)).toBeGreaterThan(0);
      expect(r.body.arr.INR).toBe((Number(r.body.mrr.INR) * 12).toFixed(2));
      expect(r.body.last30Days.upgrades.count).toBeGreaterThan(0);
      expect(r.body.last30Days.downgrades.count).toBeGreaterThan(0);
      expect(r.body.trialConversion90Days.converted).toBeGreaterThan(0);
      expect(r.body.collected.length).toBeGreaterThan(0);
      expect(r.body.outstanding.INR.count).toBeGreaterThan(0);
      expect(r.body.plans.map((p: { key: string }) => p.key)).toEqual(expect.arrayContaining(['business', 'professional']));
      expect(r.body.addons.length).toBeGreaterThan(0);
      // Viewers see the report but cannot change billing.
      expect((await api(app, viewer).post('/platform/billing/coupons').send({ code: 'VIEWER1', name: 'x', kind: 'percent', value: '5', duration: 'once' })).status).toBe(403);
      expect((await api(app, viewer).get('/platform/billing/payment-events')).body.length).toBeGreaterThan(0);
    });
  });
});
