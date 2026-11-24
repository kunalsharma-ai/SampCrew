/**
 * Delete permissions, end to end through a real browser: the Console allows deletes per Super Workspace, the Super
 * Workspace gives them to HR Workspace (and Employee Workspace) per area, and every delete asks for the person's own
 * password. Everything is switched back at the end.
 *
 *   pnpm db:reset            # fresh demo workspace and bootstrap console admin (the admin must not have MFA yet)
 *   API on :4000, Web Portal on :3000, Console on :3001, then: pnpm e2e:delete-permissions
 *
 * 1. The console admin enrols MFA and opens the demo workspace's Delete permissions tab.
 * 2. The Console switches "Company structure" off: the Super Workspace's own Archive buttons go, and Workspace
 *    Permissions shows the HR Workspace switch as not allowed by Console Admin. The Console switches it back on.
 * 3. The Super Workspace switches "Delete: Company structure" off for HR Workspace: HR has no Archive buttons.
 * 4. Switched on again, HR adds a location and archives it: the password dialog refuses a wrong password, and the
 *    right one archives it.
 */
const { chromium } = require('playwright');
const { manualDeletes } = require('./delete-password.cjs');
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
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|EventSource/.test(m.text()) && errs.push(m.text()));
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

/** Visible Archive buttons on the Organization page's Locations tab. */
async function archiveButtons(page) {
  await page.goto(WEB + '/organization?tab=locations');
  await page.getByRole('button', { name: 'Add location' }).first().waitFor();
  return page.locator('button[aria-label^="Archive "]').evaluateAll((bs) => bs.filter((b) => b.offsetParent !== null).length);
}

async function setHrDelete(owner, area, want) {
  await owner.goto(WEB + '/settings/workspace-permissions?level=hr&groupId=central');
  const cat = owner.getByTestId('perm-category-delete_permissions');
  await cat.waitFor();
  if (!(await cat.getByTestId(`perm-switch-delete.${area}`).count())) await cat.getByRole('button', { name: /Delete permissions/ }).first().click();
  const sw = cat.getByTestId(`perm-switch-delete.${area}`);
  if ((await sw.getAttribute('aria-checked')) !== String(want)) {
    await sw.click();
    await owner.getByTestId('perm-save').click();
    await owner.getByText('Permissions saved').waitFor();
  }
  return cat;
}

async function consoleSwitch(admin, area, want) {
  const sw = admin.getByTestId(`switch-delete-${area}`);
  await sw.waitFor();
  if ((await sw.getAttribute('aria-checked')) !== String(want)) {
    await sw.click();
    await admin.waitForFunction(([id, v]) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-checked') === v, [`switch-delete-${area}`, String(want)], { timeout: 15000 });
  }
}

(async () => {
  const b = await chromium.launch();
  const admin = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const owner = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const hr = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [admin, owner, hr]) watch(p);
  manualDeletes(hr);
  let current = admin;
  try {
    // 1. Console sign-in with mandatory MFA, then the demo workspace's Delete permissions tab.
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
    await admin.goto(`${tenantUrl}/access?tab=delete`);
    await admin.getByTestId('delete-rights').waitFor();
    await shot(admin, '01-console-delete-rights');
    ok('console admin opens Delete permissions for the demo workspace');

    // 2. The Console switches Company structure off for this Super Workspace.
    current = owner;
    await signIn(owner, 'owner@demo.crew.local');
    expect((await archiveButtons(owner)) > 0, 'the Super Workspace should start with Archive buttons on locations');
    current = admin;
    await consoleSwitch(admin, 'organization', false);
    await shot(admin, '02-console-organization-off');
    current = owner;
    expect((await archiveButtons(owner)) === 0, 'the Super Workspace still has Archive buttons after the Console switched deletes off');
    await owner.goto(WEB + '/settings/workspace-permissions?level=hr&groupId=central');
    const cat = owner.getByTestId('perm-category-delete_permissions');
    if (!(await cat.getByTestId('perm-switch-delete.organization').count())) await cat.getByRole('button', { name: /Delete permissions/ }).first().click();
    await cat.getByTestId('perm-item-delete.organization').getByText('Not allowed by Console Admin').waitFor();
    expect(await cat.getByTestId('perm-switch-delete.organization').isDisabled(), 'the Super Workspace can still give a delete the Console did not allow');
    await shot(owner, '03-super-workspace-blocked-by-console');
    current = admin;
    await consoleSwitch(admin, 'organization', true);
    ok('with Company structure off in the Console, the Super Workspace cannot archive locations or give it to HR Workspace');

    // 3. The Super Workspace switches it off for HR Workspace.
    current = owner;
    await setHrDelete(owner, 'organization', false);
    current = hr;
    await signIn(hr, 'hr.admin@demo.crew.local');
    expect((await archiveButtons(hr)) === 0, 'HR Workspace has Archive buttons without the delete permission');
    await shot(hr, '04-hr-workspace-no-delete');
    ok('without the Super Workspace\'s permission, HR Workspace sees no Archive buttons');

    // 4. Switched on: HR archives a new location with their password.
    current = owner;
    await setHrDelete(owner, 'organization', true);
    await shot(owner, '05-super-workspace-delete-permissions');
    current = hr;
    expect((await archiveButtons(hr)) > 0, 'HR Workspace has no Archive buttons after the Super Workspace allowed it');
    const name = `Delete Test Depot ${Date.now().toString(36)}`;
    await hr.click('text=Add location');
    await hr.fill('dialog input[name=name]', name);
    await hr.selectOption('dialog select[name=kind]', 'warehouse');
    await hr.locator('dialog select[name=legalEntityId]').selectOption({ index: 1 });
    const tz = hr.locator('dialog input[name=timezone]'); if (await tz.count()) await tz.fill('Asia/Kolkata');
    const cc = hr.locator('dialog [name=countryCode]'); if (await cc.count()) { const tag = await cc.evaluate((e) => e.tagName); tag === 'SELECT' ? await cc.selectOption('IN') : await cc.fill('IN'); }
    await hr.click('dialog button[type=submit]');
    await hr.getByText(name).first().waitFor();
    await hr.click(`[aria-label="Archive ${name}"]`);
    const form = hr.getByTestId('delete-password-form');
    await form.waitFor();
    expect((await form.getByTestId('delete-password-what').textContent()).includes(name), 'the dialog does not say what is deleted');
    await form.getByTestId('delete-password-input').fill('not-the-password');
    await form.getByTestId('delete-password-submit').click();
    await form.getByText('That password is not correct. Nothing was deleted.').waitFor();
    await shot(hr, '06-password-dialog-wrong-password');
    expect(await hr.getByText(name).first().isVisible(), 'the location went with a wrong password');
    await form.getByTestId('delete-password-input').fill(PASSWORD);
    await form.getByTestId('delete-password-submit').click();
    await hr.getByText(`${name} archived.`).waitFor({ timeout: 15000 });
    await shot(hr, '07-archived-after-password');
    ok('HR Workspace archived a location after the wrong password was refused and the right one accepted');

    expect(!errs.length, `browser errors:\n${errs.join('\n')}`);
    ok('no browser errors');
  } catch (e) {
    console.error(`FAILED at ${current.url()}`);
    await current.screenshot({ path: '/tmp/delete-permissions-flow-failure.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await b.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
