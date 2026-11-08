/**
 * Plans decide features, end to end through a real browser. SAMPLEDGE sets what each plan includes in the Super
 * Admin Console; the demo workspace (on Business) can then use only those modules, in the Web Portal and the API.
 *
 *   pnpm db:reset            # fresh demo workspace and bootstrap console admin (the admin must not have MFA yet)
 *   API on :4000, Web Portal on :3000, Console on :3001, then: pnpm e2e:plans
 *
 * 1. The console admin enrols MFA and opens Plans & pricing.
 * 2. Business loses Goals & reviews and Email signatures in "Modules & limits". HR's navigation loses Goals,
 *    Reviews and Email signatures, /goals says "Not included in your plan", and the owner's Compare plans table
 *    shows Business without them.
 * 3. A new plan "Pilot" is created as a copy of Business and made visible; the owner sees it on Plan & billing.
 * 4. The owner (after turning on two-step verification) requests Enterprise; the request shows on the owner's
 *    page and in the Console, where it is approved. The workspace is then on Enterprise and Single sign-on appears.
 * 5. Business gets its modules back.
 */
const { chromium } = require('playwright');
const { authenticator } = require('otplib');

const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !PASSWORD) throw new Error('Set CREW_BOOTSTRAP_ADMIN_EMAIL, CREW_BOOTSTRAP_ADMIN_PASSWORD and CREW_DEMO_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());
const errs = [];
const watch = (page) => {
  page.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
  page.on('dialog', (d) => d.accept());
};

async function signIn(page, email) {
  for (let attempt = 1; ; attempt++) {
    await page.goto(WEB + '/login');
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', PASSWORD);
    await page.click('button[type=submit]');
    const r = await Promise.race([
      page.waitForURL((u) => u.pathname === '/', { timeout: 15000 }).then(() => 'in'),
      page.locator('text=Too many requests').waitFor({ timeout: 15000 }).then(() => 'limited'),
    ]);
    if (r === 'in') return;
    if (attempt >= 4) throw new Error('sign-in stayed rate limited');
    await page.waitForTimeout(20000);
  }
}

const navLinks = async (page) => page.locator('nav[aria-label] a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));

async function setModules(admin, planKey, want) {
  await admin.goto(`${CONSOLE}/plans`);
  await admin.getByTestId(`plan-edit-contents-${planKey}`).click();
  for (const [key, on] of Object.entries(want)) {
    const sw = admin.getByTestId(`plan-switch-${key}`);
    if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click();
  }
  await admin.getByTestId('plan-contents-save').click();
  await admin.getByText(/saved.*Applies now to \d+ workspace/).waitFor({ timeout: 15000 });
}

(async () => {
  const b = await chromium.launch();
  const admin = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const hr = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const owner = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [admin, hr, owner]) watch(p);
  let current = admin;
  try {
    // 1. Console sign-in with mandatory MFA, then Plans & pricing.
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
    await admin.goto(`${CONSOLE}/plans`);
    await admin.getByTestId('plan-business').waitFor();
    await admin.getByTestId('plan-requests').waitFor();
    ok('console admin opens Plans & pricing with every plan and the request list');

    // Baseline in the Web Portal.
    current = hr;
    await signIn(hr, 'hr.admin@demo.crew.local');
    let links = await navLinks(hr);
    expect(links.includes('/goals') && links.includes('/settings/signature'), `HR should start with Goals and Email signature: ${links}`);

    // 2. Business loses Goals & reviews and Email signatures.
    current = admin;
    await admin.getByTestId('plan-edit-contents-business').click();
    expect(await admin.getByTestId('plan-switch-core_hr').isDisabled(), 'Core HR must be locked on');
    await shot(admin, 'plans-builder');
    await admin.keyboard.press('Escape');
    await setModules(admin, 'business', { performance: false, email_signatures: false });
    await admin.getByText(/removed .*Goals, performance reviews and feedback/).waitFor();
    ok('Business no longer includes Goals & reviews or Email signatures');

    current = hr;
    await hr.goto(WEB + '/');
    links = await navLinks(hr);
    expect(!links.includes('/goals') && !links.includes('/reviews') && !links.includes('/settings/signature'), `HR should lose Goals, Reviews and Email signature: ${links}`);
    expect(links.includes('/learning'), `Learning stays: ${links}`);
    await hr.goto(WEB + '/goals');
    await hr.getByText('Not included in your plan').waitFor();
    await shot(hr, 'plans-web-not-in-plan');
    ok('HR loses the modules at once and /goals says they are not in the plan');

    current = owner;
    await signIn(owner, 'owner@demo.crew.local');
    await owner.goto(WEB + '/settings/billing');
    await owner.getByRole('heading', { name: 'Compare plans' }).waitFor();
    const row = owner.getByTestId('compare-performance');
    expect(await row.getByLabel('Not in Business').count() === 1, 'Compare plans should show Business without Goals & reviews');
    expect(await row.getByLabel('Included in Enterprise').count() === 1, 'Enterprise still has Goals & reviews');
    ok('the owner sees what Business includes now on Compare plans');

    // 3. A new plan, copied from Business and visible to workspaces.
    current = admin;
    await admin.goto(`${CONSOLE}/plans`);
    await admin.getByTestId('plan-create').click();
    await admin.getByTestId('plan-create-name').fill('Pilot');
    await admin.getByTestId('plan-create-copy').selectOption('business');
    await admin.getByLabel('Visible to workspace admins now').check();
    await admin.getByTestId('plan-create-save').click();
    await admin.getByTestId('plan-pilot').waitFor({ timeout: 15000 });
    await admin.keyboard.press('Escape');
    ok('Pilot plan created from a copy of Business');
    current = owner;
    await owner.reload();
    await owner.getByTestId('plan-choose-pilot').waitFor();
    ok('the owner can buy the new plan');

    // 4. Enterprise is requested by the owner and approved in the Console.
    await owner.goto(WEB + '/settings/security');
    await owner.click('text=Set up two-step verification');
    const ownerSecret = (await owner.locator('code').first().textContent()).trim();
    await owner.fill('input[name=code]', authenticator.generate(ownerSecret));
    await owner.click('text=Turn on');
    await owner.waitForSelector('text=/two-step verification is on/i', { timeout: 8000 });
    await owner.goto(WEB + '/settings/billing');
    await owner.getByTestId('plan-request-enterprise').click();
    await owner.locator('dialog input[type=number]').fill('300');
    await owner.locator('dialog textarea').fill('We need single sign-on for 300 people.');
    await owner.getByTestId('plan-request-send').click();
    await owner.getByText(/Request for Enterprise sent to SAMPLEDGE/).waitFor({ timeout: 15000 });
    await shot(owner, 'plans-web-request');
    ok('the owner sends a request for Enterprise');

    current = admin;
    await admin.goto(`${CONSOLE}/plans`);
    const req = admin.getByTestId('plan-requests').locator('tr', { hasText: 'We need single sign-on' });
    await req.waitFor();
    await shot(admin, 'plans-console-request');
    await req.getByRole('button', { name: 'Approve' }).click();
    await admin.getByText('Request approved').waitFor({ timeout: 15000 });
    ok('SAMPLEDGE approves the request in the Console');

    current = owner;
    await owner.goto(WEB + '/settings/billing');
    expect((await owner.getByTestId('billing-plan-enterprise').getAttribute('data-current')) === 'true', 'Enterprise should be the current plan');
    expect((await navLinks(owner)).includes('/settings/single-sign-on'), 'Single sign-on should appear on Enterprise');
    ok('the workspace is on Enterprise and Single sign-on is available');

    // 5. Business gets its modules back.
    current = admin;
    await setModules(admin, 'business', { performance: true, email_signatures: true });
    await admin.getByText(/added .*Goals, performance reviews and feedback/).waitFor();
    ok('Business includes Goals & reviews and Email signatures again');
  } catch (e) {
    await shot(current, 'plans-failure').catch(() => {});
    console.error(`FAILED on ${current.url()}: ${e.message}`);
    await b.close();
    process.exit(1);
  }
  await b.close();
  if (errs.length) {
    console.error(`Browser errors:\n${errs.join('\n')}`);
    process.exit(1);
  }
  console.log('Plans flow passed.');
})();
