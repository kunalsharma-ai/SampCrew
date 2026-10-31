/**
 * Super Admin Console end-to-end smoke test, through a real browser against running API, web and console apps.
 *
 *   pnpm db:reset                                         # fresh database with the bootstrap admin and demo workspace
 *   pnpm dev:api & pnpm dev:web & pnpm dev:console &
 *   node e2e/console-smoke.cjs
 *
 * Signs in as the bootstrap super admin (from CREW_BOOTSTRAP_ADMIN_EMAIL / _PASSWORD), is forced through MFA
 * enrolment, opens every console page, creates a tenant, adjusts a subscription, suspends and reactivates a
 * workspace, and changes a price. It then runs the support-access flow across both apps: the console requests
 * access, the support view stays locked, the demo owner approves it in the Web Portal, and the console can then
 * open the read-only support view, which is written to the customer's audit trail.
 */
const { chromium } = require('playwright');
const { authenticator } = require('otplib');

const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
const DEMO_PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !DEMO_PASSWORD) throw new Error('Set CREW_BOOTSTRAP_ADMIN_EMAIL, CREW_BOOTSTRAP_ADMIN_PASSWORD and CREW_DEMO_PASSWORD (source .env)');

const shot = async (p, name) => process.env.E2E_SHOTS && p.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true });
const ok = (msg) => console.log(`  ok  ${msg}`);
const errors = [];
const watch = (p) => {
  p.on('pageerror', (e) => errors.push(`${p.url()}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errors.push(`${p.url()}: ${m.text()}`));
};

(async () => {
  const browser = await chromium.launch();
  const admin = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  watch(admin);

  // Sign in; a fresh admin is sent to mandatory MFA enrolment and cannot reach any console page first.
  await admin.goto(`${CONSOLE}/login`);
  await admin.fill('input[name=email]', ADMIN_EMAIL);
  await admin.fill('input[name=password]', ADMIN_PASSWORD);
  await admin.click('button[type=submit]');
  await admin.waitForURL(/\/enrol$/);
  await admin.goto(`${CONSOLE}/tenants`);
  if (!admin.url().endsWith('/enrol')) throw new Error('reached console without MFA');
  ok('un-enrolled admin is held at MFA enrolment');
  await admin.click('text=Show QR code');
  const secret = (await admin.locator('code').first().textContent()).trim();
  await admin.fill('input[name=code]', authenticator.generate(secret));
  await admin.click('text=Turn on and continue');
  await admin.waitForURL(`${CONSOLE}/`);
  await shot(admin, 'console-overview');
  ok('MFA enrolled, overview loads');

  for (const path of ['/tenants', '/plans', '/health', '/audit', '/admins']) {
    const r = await admin.goto(CONSOLE + path);
    if (r.status() !== 200 || (await admin.locator('h1').count()) === 0) throw new Error(`${path} failed`);
  }
  ok('all console pages render');

  // Create a tenant (sales-assisted onboarding).
  const slug = `smoke-${Date.now().toString(36)}`;
  await admin.goto(`${CONSOLE}/tenants`);
  await admin.click('text=New tenant');
  await admin.fill('input[name=companyName]', 'Smoke Test Industries');
  await admin.fill('input[name=slug]', slug);
  await admin.fill('input[name=ownerName]', 'Smoke Owner');
  await admin.fill('input[name=ownerEmail]', `owner@${slug}.example`);
  await admin.click('text=Create tenant');
  await admin.waitForSelector('text=Smoke Test Industries created');
  ok('tenant created with an owner invitation link');

  // Subscription override, suspend and reactivate on the new tenant.
  await admin.click('a:has-text("Smoke Test Industries")'); // the table link, not the success banner
  await admin.waitForURL(/\/tenants\/[0-9a-f-]{36}$/);
  await admin.click('text=Adjust subscription');
  await admin.fill('dialog input[type=number]', '40');
  await admin.click('dialog >> text=Save');
  await admin.waitForSelector('text=Subscription updated.');
  await admin.waitForSelector('text=/\\/ 40/');
  ok('subscription seats overridden');
  await admin.click('button:has-text("Suspend")');
  if (await admin.locator('dialog >> button:has-text("Suspend workspace")').isEnabled()) throw new Error('suspend allowed without a reason');
  await admin.fill('dialog textarea', 'Smoke test: verifying suspension');
  await admin.click('dialog >> text=Suspend workspace');
  await admin.waitForSelector('text=This workspace is suspended');
  await admin.click('button:has-text("Reactivate")');
  await admin.fill('dialog textarea', 'Smoke test: restoring access');
  await admin.click('dialog >> button:has-text("Reactivate")');
  await admin.waitForSelector('text=Tenant reactivated.');
  ok('suspend (reason required) and reactivate');

  // Price change.
  await admin.goto(`${CONSOLE}/plans`);
  await admin.click('[aria-label="Edit Starter USD price"]');
  await admin.fill('dialog input >> nth=0', 'abc');
  await admin.click('text=Save price');
  await admin.waitForSelector('text=Use a number with up to 2 decimals');
  await admin.fill('dialog input >> nth=0', '6.50');
  await admin.click('text=Save price');
  await admin.waitForSelector('text=Existing subscriptions keep their price');
  ok('price validation and update');

  // Support access: request, locked until approved.
  await admin.goto(`${CONSOLE}/tenants?q=demo-northwind`);
  await admin.click('a:has-text("Northwind Manufacturing (Demo)")');
  await admin.waitForURL(/\/tenants\/[0-9a-f-]{36}$/);
  const tenantUrl = admin.url();
  await admin.click('text=Request support access');
  await admin.fill('dialog textarea', 'Smoke test: checking department structure for ticket 42');
  await admin.click('text=Send request');
  await admin.waitForSelector('text=must approve');
  if (await admin.locator('text=Support view (read-only)').count()) throw new Error('support view visible before approval');
  ok('support access requested; workspace data stays locked');

  // Customer approves in the Web Portal (owner enrols MFA first, since approving needs it).
  const owner = await (await browser.newContext()).newPage();
  watch(owner);
  await owner.goto(`${WEB}/login`);
  await owner.fill('input[name=email]', 'owner@demo.crew.local');
  await owner.fill('input[name=password]', DEMO_PASSWORD);
  await owner.click('button[type=submit]');
  await owner.waitForURL(`${WEB}/`);
  await owner.goto(`${WEB}/settings/security`);
  await owner.click('text=Set up two-step verification');
  const ownerSecret = (await owner.locator('code').first().textContent()).trim();
  await owner.fill('input[name=code]', authenticator.generate(ownerSecret));
  await owner.click('text=Turn on');
  await owner.waitForSelector('text=/two-step verification is on/i');
  await owner.goto(`${WEB}/settings/support`);
  await owner.click('button:has-text("Approve")');
  await owner.waitForSelector('text=End access');
  ok('customer approved the request in the Web Portal');

  await admin.goto(tenantUrl);
  await admin.waitForSelector('text=Support view (read-only)');
  await shot(admin, 'console-support-view');
  ok('console shows the read-only support view');

  await owner.goto(`${WEB}/settings/audit`);
  const actions = await owner.locator('tbody code').allTextContents();
  for (const a of ['support_access.viewed', 'support_access.approved', 'support_access.requested']) if (!actions.includes(a)) throw new Error(`customer audit trail is missing ${a}`);
  ok('customer audit trail shows request, approval and the view');

  // Customer ends access early; the console loses the view.
  await owner.goto(`${WEB}/settings/support`);
  owner.on('dialog', (d) => d.accept());
  await owner.click('text=End access');
  await owner.waitForSelector('text=revoked');
  await admin.goto(tenantUrl);
  if (await admin.locator('text=Support view (read-only)').count()) throw new Error('support view still visible after revoke');
  ok('revoked access removes the support view');

  await browser.close();
  if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`);
  console.log('\nConsole smoke test passed.');
})().catch((e) => {
  console.error('FAILED', e.message);
  process.exit(1);
});
