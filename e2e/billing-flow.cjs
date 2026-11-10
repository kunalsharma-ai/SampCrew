/**
 * Billing end to end through a real browser, with online payment through Razorpay, and no change to the server's
 * environment: the payment keys are typed into Console > Integrations. A local stand-in for Razorpay runs on 4060
 * (e2e/payments-stub.cjs, started by this script), so no real keys, money or network are involved.
 *
 *   pnpm db:reset            # fresh demo workspace (Business, 30-day trial) and bootstrap console admin, no MFA yet
 *   API on :4000, Web Portal on :3000, Console on :3001, then:
 *   pnpm e2e:billing
 *
 * 1. Console > Integrations > Razorpay: a wrong key secret fails the connection test; the right one passes. Switching
 *    on without the webhook secret is refused; with it, Razorpay is saved and the webhook address is shown.
 * 2. Console > Billing & revenue > Settings: SAMPLEDGE's GSTIN in Maharashtra is saved, so invoices carry GST.
 *    Add-ons: a module add-on is created.
 * 3. Web Portal, the demo owner: Plan & billing shows the trial, usage meters and the add-on. Locked modules appear
 *    in the navigation with a lock and open Plan & billing. Billing details (GSTIN, Maharashtra) are saved.
 * 4. Buying the Business plan shows a quote with CGST and SGST, goes to the Razorpay page, and after paying comes back
 *    to "Payment received": the trial is over, the plan is active and the invoice is paid with a GST invoice PDF.
 * 5. Console: the invoice is paid by Razorpay, the payment event was processed, and the workspace's Billing tab shows
 *    it. An invoice issued by hand reaches the owner, who pays it online too.
 */
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const { createPaymentsStub, RAZORPAY_SECRET } = require('./payments-stub.cjs');

const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.API_URL ?? 'http://localhost:4000';
const ADMIN_EMAIL = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !PASSWORD) throw new Error('Set CREW_BOOTSTRAP_ADMIN_EMAIL, CREW_BOOTSTRAP_ADMIN_PASSWORD and CREW_DEMO_PASSWORD (source .env)');
const PORT = Number(process.env.PAYMENTS_STUB_PORT ?? 4060);
const WEBHOOK_SECRET = 'e2e-razorpay-webhook-secret';

const ok = (m) => console.log(`ok - ${m}`);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());
const errs = [];
const watch = (page) => {
  page.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
};

async function razorpayCard(page) {
  const c = page.getByTestId('integration-razorpay');
  await c.waitFor();
  if ((await c.locator('button[aria-expanded]').getAttribute('aria-expanded')) !== 'true') await c.locator('button[aria-expanded]').click();
  return c;
}

async function payOnStub(page) {
  await page.waitForURL((u) => u.port === String(PORT) && u.pathname.startsWith('/pay/razorpay/'), { timeout: 20000 });
  await page.getByTestId('stub-pay').click();
  await page.waitForURL((u) => u.origin === new URL(WEB).origin && u.pathname === '/settings/billing', { timeout: 20000 });
  await page.getByText('Payment received').waitFor({ timeout: 30000 });
}

(async () => {
  const stub = createPaymentsStub({ sendWebhooks: true, apiUrl: API, razorpayWebhookSecret: WEBHOOK_SECRET });
  const stubUrl = await stub.listen(PORT);
  const b = await chromium.launch();
  const admin = await (await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
  const owner = await (await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
  for (const p of [admin, owner]) watch(p);
  let current = admin;
  try {
    // 1. Console sign-in with MFA, then Razorpay keys in Integrations.
    await admin.goto(`${CONSOLE}/login`);
    await admin.fill('input[name=email]', ADMIN_EMAIL);
    await admin.fill('input[name=password]', ADMIN_PASSWORD);
    await admin.click('button[type=submit]');
    await admin.waitForURL(/\/enrol$/);
    await admin.click('text=Show QR code');
    const secret = (await admin.locator('code').first().textContent()).trim();
    await admin.fill('input[name=code]', authenticator.generate(secret));
    await admin.click('text=Turn on and continue');
    await admin.waitForURL(`${CONSOLE}/`);
    await admin.goto(`${CONSOLE}/integrations`);
    let c = await razorpayCard(admin);
    await c.getByTestId('razorpay-keyId').fill('rzp_test_e2e123456');
    await c.getByTestId('razorpay-keySecret').fill('not-the-secret');
    await c.getByTestId('razorpay-baseUrl').fill(stubUrl);
    await c.getByRole('button', { name: 'Test connection' }).click();
    await c.getByText('Connection failed').waitFor();
    await c.getByTestId('razorpay-keySecret').fill(RAZORPAY_SECRET);
    await c.getByRole('button', { name: 'Test connection' }).click();
    await c.getByText('Connection works').waitFor();
    const sw = c.getByTestId('razorpay-enabled');
    if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
    await c.getByRole('button', { name: 'Save', exact: true }).click();
    await c.getByText(/webhook secret/i).first().waitFor();
    await c.getByTestId('razorpay-webhookSecret').fill(WEBHOOK_SECRET);
    await c.getByRole('button', { name: 'Save', exact: true }).click();
    await admin.getByTestId('integration-razorpay').getByText('Set in Console', { exact: true }).waitFor();
    c = await razorpayCard(admin);
    const hook = await c.getByTestId('webhook-url').textContent();
    expect(/\/api\/v1\/billing\/webhooks\/razorpay$/.test(hook ?? ''), `webhook address shown: ${hook}`);
    expect(!(await admin.content()).includes(RAZORPAY_SECRET), 'the key secret must never come back to the page');
    await shot(admin, 'console-razorpay');
    ok('Console: Razorpay keys tested (wrong secret fails), webhook secret required, saved and switched on');

    // 2. Billing settings (GSTIN) and an add-on.
    await admin.goto(`${CONSOLE}/billing?tab=settings`);
    await admin.getByTestId('seller-gstin').fill('27AAPFU0939F1ZV');
    await admin.getByTestId('billing-settings-save').click();
    await admin.getByText('Billing settings saved').waitFor();
    await admin.goto(`${CONSOLE}/billing?tab=addons`);
    await admin.getByTestId('addon-new').click();
    await admin.getByTestId('addon-name').fill('Single sign-on');
    await admin.getByTestId('addon-key').fill('sso_addon');
    await admin.getByTestId('addon-feature').selectOption('sso');
    await admin.getByTestId('addon-price-INR').fill('2500');
    await admin.getByTestId('addon-save').click();
    await admin.getByTestId('console-addon-sso_addon').waitFor();
    ok('Console: seller GSTIN saved and a module add-on created');

    // 3. The demo owner's Plan & billing.
    current = owner;
    await owner.goto(`${WEB}/login`);
    await owner.fill('input[name=email]', 'owner@demo.crew.local');
    await owner.fill('input[name=password]', PASSWORD);
    await owner.click('button[type=submit]');
    await owner.waitForURL((u) => u.pathname === '/', { timeout: 20000 });
    await owner.goto(`${WEB}/settings/security`);
    await owner.click('text=Set up two-step verification');
    const s2 = (await owner.locator('code').first().textContent()).trim();
    await owner.fill('input[name=code]', authenticator.generate(s2));
    await owner.click('text=Turn on');
    await owner.waitForSelector('text=/two-step verification is on/i', { timeout: 8000 });

    await owner.goto(`${WEB}/settings/billing`);
    await owner.getByTestId('billing-trial').waitFor();
    await owner.getByTestId('usage-max_employees').waitFor();
    await owner.getByTestId('addon-sso_addon').waitFor();
    const locked = owner.locator('nav[aria-label] a', { has: owner.getByTestId('nav-locked') });
    expect((await locked.count()) > 0, 'modules outside the plan should show in the navigation with a lock');
    const lockedHref = await locked.first().getAttribute('href');
    expect(/^\/settings\/billing\?upgrade=/.test(lockedHref ?? ''), `a locked module opens Plan & billing: ${lockedHref}`);
    await owner.goto(`${WEB}/settings/billing?upgrade=sso`);
    await owner.getByText(/^Single sign-on.* is not in your plan$/).waitFor();

    const profile = owner.getByTestId('billing-profile');
    await profile.getByLabel('Legal name').fill('Northwind Manufacturing Pvt Ltd');
    await profile.getByLabel('Invoice email').fill('accounts@northwind.test');
    await profile.getByLabel('State').selectOption('27');
    await profile.getByLabel('GSTIN').fill('27AAACN1234F1Z5');
    await profile.getByLabel(/^Address( \*)?$/).fill('Plot 12, Chakan MIDC');
    await profile.getByLabel('City').fill('Pune');
    await profile.getByLabel('Postal code').fill('410501');
    await owner.getByTestId('billing-profile-save').click();
    await owner.getByText('Billing details saved').waitFor();
    ok('Web Portal: trial, usage and add-on shown; locked modules lead to Plan & billing; GST billing details saved');

    // 4. Buy the plan through Razorpay.
    await owner.getByTestId('billing-plan-business').getByRole('button', { name: 'Buy this plan' }).click();
    const quote = owner.getByTestId('quote-summary');
    await quote.waitFor();
    await quote.getByText(/CGST 9%/).waitFor();
    await quote.getByText(/SGST 9%/).waitFor();
    const total = (await owner.getByTestId('quote-total').textContent()).trim();
    await shot(owner, 'web-quote');
    await owner.getByTestId('plan-confirm').click();
    await payOnStub(owner);
    await owner.waitForSelector('[data-testid="billing-trial"]', { state: 'detached', timeout: 20000 });
    const paidRow = owner.locator('[data-testid^="invoice-SC"]').first();
    await paidRow.getByText('paid', { exact: true }).waitFor();
    const [dl] = await Promise.all([owner.waitForEvent('download'), paidRow.getByTestId('invoice-pdf').click()]);
    expect(/^SC\d{4}-\d{6}\.pdf$/.test(dl.suggestedFilename()), `invoice PDF name: ${dl.suggestedFilename()}`);
    await shot(owner, 'web-billing-paid');
    ok(`Web Portal: quote ${total} with CGST and SGST, paid on Razorpay, plan active, GST invoice PDF ${dl.suggestedFilename()}`);

    // 5. The Console sees the payment; an invoice issued by hand is paid online by the owner.
    current = admin;
    await admin.goto(`${CONSOLE}/billing?tab=invoices&status=paid`);
    await admin.locator('[data-testid^="console-invoice-SC"]').first().getByText('Razorpay').waitFor();
    await admin.goto(`${CONSOLE}/billing?tab=events`);
    await admin.getByText('payment_link.paid').first().waitFor();
    await admin.getByText('processed').first().waitFor();
    await admin.goto(`${CONSOLE}/billing?tab=revenue`);
    await admin.getByTestId('revenue-mrr').waitFor();
    await admin.goto(`${CONSOLE}/tenants`);
    await admin.getByRole('link', { name: /Northwind/ }).first().click();
    await admin.getByTestId('ws-tab-billing').click();
    await admin.getByTestId('tenant-mrr').waitFor();
    await admin.getByTestId('manual-invoice').click();
    await admin.getByTestId('manual-invoice-description').fill('Payroll migration, one-off');
    await admin.getByTestId('manual-invoice-amount').fill('15000');
    await admin.getByTestId('manual-invoice-save').click();
    await admin.getByText(/Invoice SC\d{4}-\d{6} issued/).waitFor();
    ok('Console: paid invoice, processed Razorpay event, revenue, and an invoice issued by hand');

    current = owner;
    await owner.goto(`${WEB}/settings/billing`);
    const open = owner.locator('[data-testid^="invoice-SC"]', { hasText: 'open' }).first();
    await open.getByTestId('invoice-pay').click();
    await payOnStub(owner);
    await owner.goto(`${WEB}/settings/billing`);
    expect((await owner.locator('[data-testid^="invoice-SC"]', { hasText: 'open' }).count()) === 0, 'no open invoice should be left');
    ok('Web Portal: the invoice issued by hand was paid online');

    expect(errs.length === 0, `browser errors:\n${errs.join('\n')}`);
    ok('no browser errors');
  } catch (e) {
    await current.screenshot({ path: 'billing-failure.png', fullPage: true }).catch(() => {});
    console.error(`FAILED at ${current.url()}`);
    throw e;
  } finally {
    await b.close();
    await stub.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
