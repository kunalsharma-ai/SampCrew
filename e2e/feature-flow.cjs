/**
 * Feature management at every level, end to end through real browsers (API :4000, Web Portal :3000, Console :3001):
 *
 *   pnpm db:reset   # fresh demo workspace; the bootstrap console admin must not have MFA yet
 *   node e2e/feature-flow.cjs
 *
 * 1. Super Workspace (owner) switches Expenses off for the Employee Workspace level, after a confirmation.
 * 2. An employee loses Expenses from the menu, and typing its address shows that it is switched off for their level.
 * 3. HR Workspace (company-wide HR) sees Expenses as Restricted for Employee Workspace and cannot switch it on; it
 *    switches Announcements off for Employee Workspace in the central group. The employee loses it, HR keeps it.
 * 4. The Console switches one page (Rate cards) off for the whole application: the owner loses that page only, and
 *    its address says SAMPLEDGE switched it off.
 * 5. Super Workspace switches one button (Export the employee list) off: the People page stays, the export buttons go.
 * 6. The Console switches one button (Cancel a leave request) off for this company only, under Workspace > Features &
 *    permissions; Super Workspace sees it Restricted and cannot switch it on.
 * 7. Everything is switched back, and the employee has Expenses and Announcements again.
 */
const path = require('node:path');
const { chromium } = require('playwright');
require('./delete-password.cjs');
const { authenticator } = require('otplib');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
const ADMIN_EMAIL = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
if (!PASSWORD || !ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD, CREW_BOOTSTRAP_ADMIN_EMAIL and CREW_BOOTSTRAP_ADMIN_PASSWORD (source .env)');
const EMPLOYEE = process.env.FEATURE_EMPLOYEE ?? 'uk.sales@demo.crew.local';

const SHOTS = process.env.SHOTS;
const ok = (m) => console.log(`ok - ${m}`);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const errs = [];
const save = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' }); };

async function page(b, who) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  // A switched-off page answers 403 on purpose; the browser logs the refused request.
  p.on('console', (m) => m.type() === 'error' && !/status of 40[23]|Failed to load resource/.test(m.text()) && errs.push(`${who} ${m.text()}`));
  return p;
}

async function signIn(b, email) {
  const p = await page(b, email);
  for (let attempt = 0; ; attempt++) {
    await p.goto(WEB + '/login');
    await p.fill('input[name=email]', email);
    await p.fill('input[name=password]', PASSWORD);
    await p.click('button[type=submit]');
    const r = await Promise.race([
      p.waitForURL((u) => u.pathname === '/', { timeout: 15000 }).then(() => 'in'),
      p.locator('text=Too many requests').waitFor({ timeout: 15000 }).then(() => 'limited'),
    ]);
    if (r === 'in') return p;
    if (attempt >= 4) throw new Error(`sign-in for ${email} stayed rate limited`);
    await p.waitForTimeout(20000);
  }
}

/** Answers the "Verify it's you" dialog when it opens, turning MFA on the first time. */
async function stepUp(p) {
  const dialog = p.getByTestId('mfa-step-up-dialog');
  if (!(await dialog.waitFor({ timeout: 4000 }).then(() => true, () => false))) return;
  await dialog.getByTestId('mfa-step-up-setup').click();
  const secret = (await dialog.getByTestId('mfa-step-up-secret').textContent()).trim();
  await dialog.getByTestId('mfa-step-up-code').fill(authenticator.generate(secret));
  await dialog.getByTestId('mfa-step-up-submit').click();
  await dialog.waitFor({ state: 'hidden', timeout: 15000 });
}

const navLinks = (p) => p.locator('nav[aria-label] a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));

/** Flips a feature switch to `want`, confirming a switch-off, and waits until the board shows it. */
async function flip(p, testId, want, opts = {}) {
  const sw = p.getByTestId(testId);
  await sw.waitFor({ timeout: 15000 });
  if ((await sw.getAttribute('aria-checked')) === String(want)) return;
  await sw.click();
  if (!want) await p.getByTestId('confirm-switch-off').click();
  if (opts.mfa) await stepUp(p);
  await p.waitForFunction(([id, v]) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-checked') === v, [testId, String(want)], { timeout: 20000 });
}

async function openModule(p, key) {
  const row = p.getByTestId(`feature-${key}`);
  await row.waitFor({ timeout: 15000 });
  const btn = row.getByRole('button', { name: /Show the pages of/ });
  if (await btn.count()) await btn.click();
}

(async () => {
  const b = await chromium.launch();
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const users = mongo.db().collection('users');
  const ownerBefore = await users.findOne({ email: 'owner@demo.crew.local' });
  if (!ownerBefore) throw new Error('demo owner missing: run pnpm db:reset with CREW_SEED_DEMO=true');
  await users.updateOne({ _id: ownerBefore._id }, { $set: { mfa_enabled: false, mfa_secret_enc: null } });
  let current;
  let owner;
  let hr;
  let admin;
  try {
    // 1. Super Workspace: Expenses off for the Employee Workspace level.
    owner = current = await signIn(b, 'owner@demo.crew.local');
    await owner.goto(WEB + '/settings/hr-admin?tab=features');
    await owner.getByRole('heading', { name: 'Feature management' }).first().waitFor();
    await flip(owner, 'switch-expenses-employee', false, { mfa: true });
    expect((await owner.getByTestId('feature-expenses').textContent()).includes('Inactive'), 'Expenses should show Inactive for Employee Workspace');
    expect(await owner.getByTestId('switch-expenses-company').getAttribute('aria-checked') === 'true', 'Expenses stays on for the company');
    await save(owner, 'feature-01-super-matrix');
    ok('Super Workspace switches Expenses off for the Employee Workspace level, after confirming');

    // 2. The employee loses it, in the menu and on the direct address.
    const emp = current = await signIn(b, EMPLOYEE);
    expect(!(await navLinks(emp)).includes('/expenses'), 'the employee should not see Expenses');
    await emp.goto(WEB + '/expenses');
    await emp.getByText('This is switched off for your access level').waitFor({ timeout: 15000 });
    await save(emp, 'feature-02-employee-direct-url');
    ok('the employee loses Expenses from the menu, and its address says it is switched off');

    // 3. HR Workspace: Expenses restricted; Announcements off for Employee Workspace in the central group.
    hr = current = await signIn(b, 'hr.admin@demo.crew.local');
    expect((await navLinks(hr)).includes('/employee-features'), 'HR should see Employee features');
    await hr.goto(WEB + '/employee-features');
    await hr.getByTestId('feature-expenses').waitFor();
    expect((await hr.getByTestId('feature-expenses').textContent()).includes('Restricted'), 'Expenses should be Restricted for HR');
    expect(await hr.getByTestId('switch-expenses-employee').isDisabled(), 'HR cannot switch Expenses on');
    await flip(hr, 'switch-announcements-employee', false);
    await save(hr, 'feature-03-hr-employee-features');
    await emp.goto(WEB + '/');
    expect(!(await navLinks(emp)).includes('/announcements'), 'the employee should lose Announcements');
    await hr.goto(WEB + '/');
    expect((await navLinks(hr)).includes('/announcements'), 'HR keeps Announcements');
    ok('HR Workspace sees Expenses restricted, switches Announcements off for employees only');

    // 4. Console: one page off for the whole application.
    admin = current = await page(b, 'console');
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
    await admin.goto(`${CONSOLE}/features`);
    await openModule(admin, 'staffing_bids');
    await flip(admin, 'switch-staffing_bids.rate_cards-platform', false);
    await save(admin, 'feature-04-console');
    await owner.goto(WEB + '/');
    const links = await navLinks(owner);
    expect(!links.includes('/staffing/rate-cards') && links.includes('/staffing/bids'), 'the owner loses Rate cards only');
    await owner.goto(WEB + '/staffing/rate-cards');
    await owner.getByTestId('feature-off').waitFor({ timeout: 15000 });
    expect((await owner.getByTestId('feature-off').textContent()).includes('SAMPLEDGE has switched it off'), 'the page says SAMPLEDGE switched it off');
    await owner.goto(WEB + '/settings/hr-admin?tab=features');
    await openModule(owner, 'staffing_bids');
    expect((await owner.getByTestId('feature-staffing_bids.rate_cards').textContent()).includes('Restricted'), 'Super Workspace sees it Restricted');
    expect(await owner.getByTestId('switch-staffing_bids.rate_cards-company').isDisabled(), 'Super Workspace cannot switch it on');
    ok('the Console switches Rate cards off for every company; Super Workspace sees it restricted');

    // 5. Super Workspace: one button off, its page stays.
    current = owner;
    const exportButtons = () => owner.locator('[data-feature="core_hr.people_export"]');
    await owner.goto(WEB + '/employees');
    await exportButtons().first().waitFor({ timeout: 15000 });
    expect(await exportButtons().first().isVisible(), 'the export button shows while it is on');
    await owner.goto(WEB + '/settings/hr-admin?tab=features');
    await openModule(owner, 'core_hr');
    expect((await owner.getByTestId('feature-core_hr.people_export').textContent()).includes('Button'), 'the board lists the export as a button');
    await flip(owner, 'switch-core_hr.people_export-company', false, { mfa: true });
    await save(owner, 'feature-05-super-button-off');
    await owner.goto(WEB + '/employees');
    await exportButtons().first().waitFor({ state: 'attached', timeout: 15000 });
    expect(await exportButtons().count() > 0 && !(await exportButtons().first().isVisible()), 'the export buttons are hidden when the button is off');
    await owner.goto(WEB + '/settings/hr-admin?tab=features');
    await openModule(owner, 'core_hr');
    await flip(owner, 'switch-core_hr.people_export-company', true, { mfa: true });
    await owner.goto(WEB + '/employees');
    await exportButtons().first().waitFor({ state: 'visible', timeout: 15000 });
    ok('Super Workspace switches one button off: the page stays, the button goes, and comes back');

    // 6. Console: one button off for this company only.
    current = admin;
    const tenant = await mongo.db().collection('tenants').findOne({ slug: 'demo-northwind' });
    await admin.goto(`${CONSOLE}/tenants/${tenant._id ?? tenant.id}/access?tab=modules`);
    await admin.getByRole('heading', { name: 'Pages and buttons' }).waitFor({ timeout: 15000 });
    await openModule(admin, 'leave');
    await flip(admin, 'switch-leave.cancel-company', false);
    await save(admin, 'feature-06-console-company-button');
    await emp.goto(WEB + '/leave');
    const hidden = await emp.evaluate(() => [...document.querySelectorAll('style')].some((s) => s.textContent.includes('[data-feature="leave.cancel"]')));
    expect(hidden, 'the employee portal hides Cancel on leave requests');
    current = owner;
    await owner.goto(WEB + '/settings/hr-admin?tab=features');
    await openModule(owner, 'leave');
    expect((await owner.getByTestId('feature-leave.cancel').textContent()).includes('Restricted'), 'Super Workspace sees the button Restricted');
    expect(await owner.getByTestId('switch-leave.cancel-company').isDisabled(), 'Super Workspace cannot switch it on');
    current = admin;
    await flip(admin, 'switch-leave.cancel-company', true);
    await emp.goto(WEB + '/leave');
    expect(!(await emp.evaluate(() => [...document.querySelectorAll('style')].some((s) => s.textContent.includes('[data-feature="leave.cancel"]')))), 'Cancel is back for the employee');
    ok('the Console switches one button off for this company only; Super Workspace sees it restricted');

    // 7. Everything back.
    current = admin;
    await admin.goto(`${CONSOLE}/features`);
    await openModule(admin, 'staffing_bids');
    await flip(admin, 'switch-staffing_bids.rate_cards-platform', true);
    current = hr;
    await hr.goto(WEB + '/employee-features');
    await flip(hr, 'switch-announcements-employee', true);
    current = owner;
    await owner.goto(WEB + '/settings/hr-admin?tab=features');
    await flip(owner, 'switch-expenses-employee', true, { mfa: true });
    await emp.goto(WEB + '/');
    const back = await navLinks(emp);
    expect(back.includes('/expenses') && back.includes('/announcements'), 'the employee has Expenses and Announcements again');
    ok('everything is switched back and the employee has it all again');
    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('feature flow passed');
  } catch (e) {
    if (current) await current.screenshot({ path: process.env.SHOT ?? '/tmp/feature-fail.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await users.updateOne({ _id: ownerBefore._id }, { $set: { mfa_enabled: ownerBefore.mfa_enabled ?? false, mfa_secret_enc: ownerBefore.mfa_secret_enc ?? null } });
    await mongo.close();
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
