/**
 * Workspace access controls, end to end through a real browser: the Super Admin Console switches modules and
 * permissions active or inactive for the demo workspace and chooses the modules one person may use; the Web
 * Portal then hides what is off and the API refuses it. Everything is switched back at the end.
 *
 *   pnpm db:reset            # fresh demo workspace and bootstrap console admin (the admin must not have MFA yet)
 *   API on :4000, Web Portal on :3000, Console on :3001, then: pnpm e2e:access
 *
 * 1. The console admin enrols MFA, opens the demo workspace and its Features & permissions page.
 * 2. Modules: Staffing bids is switched off. The recruiter's navigation loses it, and opening it directly shows
 *    "This module is switched off".
 * 3. Permissions: "Configure leave types" (leave:configure) is switched off. HR's navigation loses Leave settings,
 *    and Settings > Roles shows the permission as switched off by SAMPLEDGE.
 * 4. People: the recruiter alone loses Recruitment. Their navigation has no Jobs and the page says it is not
 *    available to them; HR still has Jobs.
 * 5. Everything is switched back (reset to plan, activate all, allow all) and the recruiter has the modules again.
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

async function toggle(page, testId, want) {
  const sw = page.getByTestId(testId);
  await sw.waitFor();
  if ((await sw.getAttribute('aria-checked')) !== String(want)) {
    await sw.click();
    await page.waitForFunction(([id, v]) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-checked') === v, [testId, String(want)], { timeout: 15000 });
  }
}

(async () => {
  const b = await chromium.launch();
  const admin = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const rec = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const hr = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [admin, rec, hr]) watch(p);
  let current = admin;
  try {
    // 1. Console sign-in with mandatory MFA, then the demo workspace's access page.
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
    await admin.goto(`${CONSOLE}/tenants`);
    await admin.click('a:has-text("Northwind")');
    await admin.waitForURL(/\/tenants\/[0-9a-f-]{36}$/);
    const tenantUrl = admin.url();
    await admin.getByTestId('open-access').click();
    await admin.waitForURL(/\/access$/);
    await admin.getByRole('heading', { name: 'Features & permissions' }).waitFor();
    expect(await admin.getByTestId('switch-module-core_hr').isDisabled(), 'Core HR switch should be locked');
    await shot(admin, 'access-modules');
    ok('console admin opens Features & permissions for the demo workspace');

    // Baseline in the web portal.
    current = rec;
    await signIn(rec, 'recruiter@demo.crew.local');
    let links = await navLinks(rec);
    expect(links.includes('/staffing/bids') && links.includes('/recruitment'), `recruiter should start with bids and jobs: ${links}`);
    current = hr;
    await signIn(hr, 'hr.admin@demo.crew.local');
    expect((await navLinks(hr)).includes('/settings/leave'), 'HR should start with Leave settings');

    // 2. Switch Staffing bids off for the workspace.
    current = admin;
    await toggle(admin, 'switch-module-staffing_bids', false);
    await admin.getByTestId('module-staffing_bids').getByText('Forced off').waitFor();
    ok('Staffing bids switched off in the console');
    current = rec;
    await rec.goto(WEB + '/');
    links = await navLinks(rec);
    expect(!links.some((l) => l.startsWith('/staffing')), `staffing links should be hidden: ${links}`);
    await rec.goto(WEB + '/staffing/bids');
    await rec.getByText('This module is switched off').waitFor();
    await shot(rec, 'access-web-module-off');
    ok('recruiter no longer sees Staffing bids, and the page says it is switched off');

    // 3. Switch a permission off for every role.
    current = admin;
    await admin.goto(`${tenantUrl}/access?tab=permissions`);
    await toggle(admin, 'switch-perm-leave:configure', false);
    await shot(admin, 'access-permissions');
    ok('leave:configure switched off in the console');
    current = hr;
    await hr.goto(WEB + '/');
    expect(!(await navLinks(hr)).includes('/settings/leave'), 'Leave settings should be hidden for HR');
    await hr.goto(WEB + '/settings/roles');
    await hr.getByRole('button', { name: /HR Admin \d+$/ }).click();
    await hr.getByText('Switched off by SAMPLEDGE').first().waitFor();
    await shot(hr, 'access-web-roles');
    ok('HR loses Leave settings and Roles shows the permission as switched off by SAMPLEDGE');

    // 4. Take Recruitment away from the recruiter only.
    current = admin;
    await admin.goto(`${tenantUrl}/access?tab=people`);
    await admin.fill('input[placeholder="Search by name or email"]', 'recruiter@demo');
    await admin.getByRole('button', { name: 'Search' }).click();
    await admin.waitForURL(/q=recruiter/);
    const row = admin.getByTestId('member-recruiter@demo.crew.local');
    await row.getByRole('button', { name: 'Choose modules' }).click();
    const dlg = admin.getByRole('dialog');
    await dlg.getByTestId('member-switch-recruitment').click();
    expect((await dlg.getByTestId('member-switch-recruitment').getAttribute('aria-checked')) === 'false', 'recruitment switch should be off');
    await shot(admin, 'access-member-dialog');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await row.getByText('No Recruitment CRM and ATS').waitFor();
    await shot(admin, 'access-people');
    ok('recruiter blocked from Recruitment in the console');
    current = rec;
    await rec.goto(WEB + '/');
    links = await navLinks(rec);
    expect(!links.includes('/recruitment') && !links.includes('/recruitment/candidates'), `jobs should be hidden for the recruiter: ${links}`);
    await rec.goto(WEB + '/recruitment');
    await rec.getByText('This module is not available to you').waitFor();
    current = hr;
    await hr.goto(WEB + '/');
    expect((await navLinks(hr)).includes('/recruitment'), 'HR should still have Jobs');
    ok('only the recruiter loses Recruitment; HR keeps it');

    // 5. Switch everything back.
    current = admin;
    await admin.goto(`${tenantUrl}/access?tab=people&q=recruiter%40demo`);
    await admin.getByTestId('member-recruiter@demo.crew.local').getByRole('button', { name: 'Choose modules' }).click();
    await admin.getByRole('dialog').getByRole('button', { name: 'Allow all' }).click();
    await admin.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await admin.getByTestId('member-recruiter@demo.crew.local').getByText('All active modules').waitFor();
    await admin.goto(`${tenantUrl}/access?tab=permissions`);
    await admin.getByRole('button', { name: 'Activate all' }).click();
    await admin.getByTestId('permissions-off').getByText('0').waitFor();
    await admin.goto(`${tenantUrl}/access`);
    await admin.getByRole('button', { name: 'Reset all to plan' }).click();
    await admin.getByTestId('module-staffing_bids').getByText('Follows plan').waitFor();
    current = rec;
    await rec.goto(WEB + '/');
    links = await navLinks(rec);
    expect(links.includes('/staffing/bids') && links.includes('/recruitment'), `recruiter should have bids and jobs again: ${links}`);
    current = hr;
    await hr.goto(WEB + '/');
    expect((await navLinks(hr)).includes('/settings/leave'), 'HR should have Leave settings again');
    ok('everything switched back; the recruiter and HR have their modules again');

    expect(!errs.length, `browser errors:\n${errs.join('\n')}`);
    ok('no browser errors');
  } catch (e) {
    console.error(`FAILED at ${current.url()}`);
    await current.screenshot({ path: '/tmp/access-flow-failure.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await b.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
