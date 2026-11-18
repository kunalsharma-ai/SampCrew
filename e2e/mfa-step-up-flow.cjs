/**
 * MFA step-up end-to-end flow: actions that need two-step verification ask for it in place, then go through.
 *
 *   pnpm db:reset && pnpm dev:api & pnpm dev:web &
 *   node e2e/mfa-step-up-flow.cjs
 *
 * 1. The demo owner, who has not turned MFA on, saves Billing details. Before, the form only said "This action needs
 *    multi-factor authentication" with no way forward. Now a "Verify it's you" dialog walks through turning MFA on
 *    and the same save goes through.
 * 2. Payroll settings open, and the statutory settings for the legal entity are saved from the India starting values,
 *    so payroll can run.
 * 3. A session opened without a code (as with single sign-on or an invitation link) that opens Payroll settings gets
 *    the code form on the "no access" page and goes straight back to Payroll settings after verifying.
 *
 * Run it on a fresh database right after e2e:session. It turns the owner's MFA off again at the end, so the flows
 * after it (e2e:web enrols the owner itself) start as before.
 */
const path = require('node:path');
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const OWNER = 'owner@demo.crew.local';
const ok = (msg) => console.log(`  ok  ${msg}`);

/** An unsigned token whose expiry is now: the middleware then refreshes, and the new token carries the session's MFA state. */
const expiringToken = () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) })}.x`;
};

(async () => {
  const browser = await chromium.launch();
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const db = mongo.db();
  const user = await db.collection('users').findOne({ email: OWNER });
  if (!user) throw new Error('demo owner missing: run pnpm db:reset with CREW_SEED_DEMO=true');
  if (user.mfa_enabled) throw new Error('run this on a fresh database: the demo owner already has MFA on');
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${WEB}/login`);
    await page.fill('input[name=email]', OWNER);
    await page.fill('input[name=password]', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => u.pathname !== '/login');

    // 1. Billing details: the save asks for MFA, MFA is turned on in the dialog, and the save goes through.
    await page.goto(`${WEB}/settings/billing`);
    const card = page.getByTestId('billing-profile');
    await card.getByLabel('Legal name').fill('ABC');
    await card.getByLabel('Invoice email').fill('accounts@abc.test');
    await card.getByLabel('Country').fill('IN');
    await card.getByLabel('State').selectOption('07');
    await card.getByLabel(/^Address(?! line)/).fill('Pitampura Rohini');
    await card.getByLabel('City').fill('Delhi');
    await card.getByLabel('Postal code').fill('110085');
    await page.getByTestId('billing-profile-save').click();
    const dialog = page.getByTestId('mfa-step-up-dialog');
    await dialog.waitFor({ timeout: 10000 });
    await dialog.getByTestId('mfa-step-up-setup').click();
    const secret = (await dialog.getByTestId('mfa-step-up-secret').textContent()).trim();
    await dialog.getByTestId('mfa-step-up-code').fill(authenticator.generate(secret));
    await dialog.getByTestId('mfa-step-up-submit').click();
    await card.getByText('Billing details saved').waitFor({ timeout: 15000 });
    const tenant = await db.collection('tenants').findOne({ slug: 'demo-northwind' });
    const profile = await db.collection('billing_profiles').findOne({ tenant_id: tenant._id });
    if (!profile || profile.legal_name !== 'ABC' || profile.state_code !== '07') throw new Error(`billing details not stored: ${JSON.stringify(profile)}`);
    if (!(await db.collection('users').findOne({ _id: user._id })).mfa_enabled) throw new Error('MFA was not turned on');
    ok('billing details ask for MFA in place, MFA is turned on, and the same save is stored');

    // 2. Statutory settings from the India starting values. The demo data saves them already; a real new workspace
    //    has none, which is the case to test.
    if (await db.collection('payroll_runs').countDocuments({ tenant_id: tenant._id })) throw new Error('run this on a fresh database: payroll runs exist');
    await db.collection('statutory_settings').deleteMany({ tenant_id: tenant._id });
    await page.goto(`${WEB}/settings/payroll`);
    if (new URL(page.url()).pathname !== '/settings/payroll') throw new Error(`payroll settings did not open: ${page.url()}`);
    await page.getByText('Not saved yet').first().waitFor();
    await page.getByRole('button', { name: 'I have checked these values. Save.' }).click();
    await page.getByRole('cell', { name: /Attendance|Unpaid leave/ }).first().waitFor({ timeout: 15000 });
    const saved = await db.collection('statutory_settings').countDocuments({ tenant_id: tenant._id });
    if (saved < 1) throw new Error('statutory settings were not stored');
    ok('statutory settings are saved for the legal entity from the India starting values');

    // 3. A session without a code: "no access" offers the code form and goes back to the page.
    await db.collection('sessions').updateMany({ user_id: user._id, revoked_at: null }, { $set: { mfa_verified: false } });
    await context.addCookies([{ name: 'crew_at', value: expiringToken(), domain: new URL(WEB).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(`${WEB}/settings/payroll`);
    await page.waitForURL((u) => u.pathname === '/no-access');
    if (new URL(page.url()).searchParams.get('from') !== '/settings/payroll') throw new Error(`no access does not know where to go back: ${page.url()}`);
    const form = page.getByTestId('no-access-mfa');
    await new Promise((r) => setTimeout(r, 31000)); // next TOTP window, so the code differs from the one used above
    await form.getByTestId('mfa-step-up-code').fill(authenticator.generate(secret));
    await form.getByTestId('mfa-step-up-submit').click();
    await page.waitForURL((u) => u.pathname === '/settings/payroll', { timeout: 15000 });
    await page.getByRole('heading', { name: 'Payroll settings' }).waitFor();
    if (!(await db.collection('audit_events').countDocuments({ tenant_id: tenant._id, action: 'auth.mfa_step_up' }))) throw new Error('the step-up was not audited');
    ok('a session without a code verifies on "no access" and returns to Payroll settings');

    if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  } catch (e) {
    await page.screenshot({ path: 'mfa-step-up-failure.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    // Leave the owner as the later flows expect: MFA not turned on yet.
    await db.collection('users').updateOne({ _id: user._id }, { $set: { mfa_enabled: false, mfa_secret_enc: null } });
    await context.close();
    await browser.close();
    await mongo.close();
  }
  console.log('mfa step-up flow: OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
