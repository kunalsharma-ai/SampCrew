/**
 * The Console command center, end to end through a real browser against the running API and Console.
 *
 *   pnpm db:reset            # fresh database: the bootstrap console admin has no MFA yet
 *   API on :4000, Console on :3001, then: pnpm e2e:console-command-center
 *
 * 1. The admin enrols MFA and lands on the Command center: tiles, range picker, the grouped menu and breadcrumbs.
 * 2. Ctrl+K search finds the demo company and opens it.
 * 3. Create Company: profile, first Super Workspace, review; the company shows in Clients with its status.
 * 4. Company 360: tabs, a second Super Workspace, a profile edit that shows up in Activity with before and after.
 * 5. Clients list: search, a bulk tag, and a CSV export that the API builds and audits.
 * 6. Notifications: the new company is there, Mark all as read, preferences (sound off by default, mute a category).
 * 7. Roles: a custom role with the audit permission shows in the matrix.
 * 8. Reports, audit log export, security sessions, settings saved with an audit entry, system status.
 * 9. Plans: impact preview, duplicate, retire and reopen (a plan with billing records is never deleted).
 * 10. The phone layout opens the menu and the Clients page without sideways scrolling.
 */
const { chromium } = require('playwright');
const { authenticator } = require('otplib');

const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const ADMIN_EMAIL = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error('Set CREW_BOOTSTRAP_ADMIN_EMAIL and CREW_BOOTSTRAP_ADMIN_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());
const errs = [];
const watch = (page) => {
  page.on('pageerror', (e) => errs.push(`PAGEERROR ${page.url()}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|EventSource/.test(m.text()) && errs.push(`${page.url()}: ${m.text()}`));
  page.on('dialog', (d) => d.accept());
};
const visibleForm = (p) => p.locator('form:not([hidden])');

(async () => {
  const b = await chromium.launch();
  let current;
  try {
    const admin = await (await b.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })).newPage();
    current = admin;
    watch(admin);

    // 1. Sign in, enrol MFA, land on the Command center.
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
    await admin.getByRole('heading', { name: 'Command center' }).waitFor();
    for (const id of ['home-customers', 'home-hr-workspaces', 'home-users', 'range-picker', 'console-alerts', 'console-activity', 'dashboard-notifications']) await admin.getByTestId(id).first().waitFor();
    const nav = admin.locator('aside nav[aria-label=Console]');
    for (const group of ['Overview', 'Clients', 'Revenue', 'Support', 'Security', 'Platform']) await nav.getByText(group, { exact: true }).first().waitFor();
    await admin.getByTestId('range-picker').getByRole('link', { name: '7 days' }).click();
    await admin.waitForURL(/range=7d/);
    await admin.getByRole('heading', { name: 'Command center' }).waitFor();
    await shot(admin, 'command-center');
    ok('command center loads with tiles, range picker, grouped menu, attention and activity');

    // 2. Global search.
    await admin.keyboard.press('Control+k');
    await admin.getByTestId('console-search-input').fill('Northwind');
    const hit = admin.getByTestId('console-search-hit').filter({ hasText: 'Northwind' }).first();
    await hit.waitFor({ timeout: 15000 });
    await hit.click();
    await admin.waitForURL(/\/(clients|tenants)\/[0-9a-f-]{36}/);
    await admin.getByTestId('breadcrumbs').waitFor();
    ok('Ctrl+K search finds the demo company and opens it, with breadcrumbs');

    // 3. Create Company.
    const stamp = Date.now().toString(36);
    const name = `Orbit Labs ${stamp}`;
    await admin.goto(`${CONSOLE}/clients/new`);
    await visibleForm(admin).locator('input[name=name]').fill(name);
    await visibleForm(admin).locator('input[name=website]').fill(`https://orbit-${stamp}.example`);
    await visibleForm(admin).locator('select[name=industry]').selectOption('it_services');
    await visibleForm(admin).getByTestId('wizard-next').click();
    await visibleForm(admin).locator('input[name=slug]').fill(`orbit-${stamp}`);
    await visibleForm(admin).locator('input[name=ownerName]').fill('Orbit Admin');
    await visibleForm(admin).locator('input[name=ownerEmail]').fill(`admin@orbit-${stamp}.example`);
    await visibleForm(admin).getByTestId('wizard-next').click();
    await admin.getByTestId('wizard-review').getByText(`orbit-${stamp}`).waitFor();
    await admin.getByTestId('wizard-create').click();
    await admin.getByTestId('client-created').waitFor({ timeout: 20000 });
    await admin.getByTestId('owner-invite-url').waitFor();
    await admin.getByRole('link', { name: 'Open the company' }).click();
    await admin.waitForURL(/\/clients\/[0-9a-f-]{36}$/);
    const companyUrl = admin.url();
    await admin.getByRole('heading', { name }).waitFor();
    await admin.getByTestId('client-tabs').waitFor();
    ok('Create Company wizard makes the company and its first Super Workspace');

    // 4. Company 360: second Super Workspace, profile edit, activity with before and after.
    await admin.getByTestId('client-tabs').getByRole('link', { name: /^Workspaces/ }).click();
    await admin.waitForURL(/\/workspaces$/);
    expect((await admin.getByTestId('client-workspace').count()) === 1, 'expected one Super Workspace');
    await admin.getByTestId('add-workspace').click();
    const add = admin.locator('#add-workspace');
    await add.locator('input[name=companyName]').fill(`${name} UK`);
    await add.locator('input[name=slug]').fill(`orbit-uk-${stamp}`);
    await add.locator('input[name=ownerName]').fill('Orbit UK Admin');
    await add.locator('input[name=ownerEmail]').fill(`uk@orbit-${stamp}.example`);
    await add.locator('input[name=countryCode]').fill('GB');
    await admin.getByRole('button', { name: 'Create Super Workspace' }).click();
    await admin.getByText('Super Workspace created').waitFor({ timeout: 20000 });
    await admin.getByRole('button', { name: 'Done' }).click();
    await admin.waitForFunction(() => document.querySelectorAll('[data-testid=client-workspace]').length === 2, null, { timeout: 15000 });
    ok('a company holds a second Super Workspace');

    await admin.goto(companyUrl);
    await admin.getByTestId('client-edit').click();
    await admin.locator('#client-profile select[name=companySize]').selectOption('51-200');
    await admin.locator('#client-profile input[name=legalName]').fill(`${name} Private Limited`);
    await admin.getByRole('button', { name: 'Save profile' }).click();
    await admin.getByText('51-200 people').waitFor();
    await admin.getByTestId('client-lookup').waitFor();
    await admin.getByTestId('client-tabs').getByRole('link', { name: 'Activity' }).click();
    const updated = admin.getByTestId('audit-row').filter({ hasText: 'platform.company_updated' }).first();
    await updated.waitFor();
    await updated.getByRole('button', { name: 'Details' }).click();
    await admin.getByTestId('audit-diff').getByText('company_size').waitFor();
    await shot(admin, 'company-activity');
    ok('profile edit is saved and shows in Activity with before and after values');

    // 5. Clients list: search, bulk tag, export.
    await admin.goto(`${CONSOLE}/clients`);
    await admin.getByTestId('client-status-tabs').waitFor();
    await admin.getByTestId('clients-search').fill(name);
    await admin.getByRole('button', { name: 'Search', exact: true }).click();
    await admin.waitForURL(/q=/);
    const row = admin.getByTestId('client-row').filter({ hasText: name });
    await row.waitFor();
    expect((await admin.getByTestId('client-row').count()) === 1, 'search should leave one company');
    await row.getByRole('checkbox').check();
    await admin.getByTestId('clients-bulk').getByRole('button', { name: 'Add tag' }).click();
    await admin.getByLabel('Tag').fill('pilot');
    await admin.getByTestId('bulk-confirm').click();
    await admin.goto(companyUrl);
    await admin.getByText('pilot', { exact: true }).first().waitFor();
    await admin.goto(`${CONSOLE}/clients?q=${encodeURIComponent(name)}`);
    const [csv] = await Promise.all([admin.waitForEvent('download'), admin.getByTestId('clients-export').getByRole('link', { name: 'CSV' }).click()]);
    const text = require('node:fs').readFileSync(await csv.path(), 'utf8');
    expect(text.includes('Company') && text.includes(name), 'client export misses the company');
    ok('clients search, bulk tag and CSV export work');

    // 6. Notifications.
    await admin.goto(`${CONSOLE}/notifications`);
    await admin.getByTestId('notifications-list').getByText(`New company: ${name}`).first().waitFor();
    if (await admin.getByTestId('notifications-read-all').count()) {
      await admin.getByTestId('notifications-read-all').click();
      await admin.getByTestId('notifications-read-all').waitFor({ state: 'detached' });
    }
    await admin.goto(`${CONSOLE}/notifications?tab=preferences`);
    expect((await admin.getByTestId('pref-sound').getAttribute('aria-checked')) === 'false', 'sound must be off by default');
    expect((await admin.getByTestId('pref-desktop').getAttribute('aria-checked')) === 'false', 'desktop notifications must be off by default');
    await admin.getByTestId('pref-clients').click();
    await admin.getByText('Preferences saved.').waitFor();
    await admin.reload();
    expect((await admin.getByTestId('pref-clients').getAttribute('aria-checked')) === 'false', 'muting a category did not stick');
    await admin.getByTestId('pref-clients').click();
    await admin.getByText('Preferences saved.').waitFor();
    ok('notification history, mark all as read, and preferences (sound off by default, mute sticks)');

    // 7. Roles.
    await admin.goto(`${CONSOLE}/roles`);
    await admin.getByTestId('role-matrix').waitFor();
    await admin.getByTestId('role-new').click();
    await admin.getByTestId('role-name').fill(`Auditor ${stamp}`);
    await admin.getByTestId('perm-audit:read').check();
    await admin.getByTestId('role-save').click();
    await admin.getByTestId('role-matrix').getByText(`Auditor ${stamp}`).waitFor();
    ok('a custom role is created and shows in the permission matrix');

    // 8. Reports, audit export, security, settings, status.
    await admin.goto(`${CONSOLE}/reports?kind=workspaces`);
    await admin.getByTestId('report').waitFor();
    const rep = await admin.request.get(`${CONSOLE}/export/reports/workspaces?format=csv`);
    expect(rep.ok() && /text\/csv/.test(rep.headers()['content-type'] ?? ''), `report CSV failed: ${rep.status()}`);
    const pdf = await admin.request.get(`${CONSOLE}/export/reports/business?format=pdf`);
    expect(pdf.ok() && /pdf/.test(pdf.headers()['content-type'] ?? ''), `report PDF failed: ${pdf.status()}`);
    await admin.goto(`${CONSOLE}/audit?area=companies`);
    await admin.getByTestId('audit-row').filter({ hasText: 'platform.company_created' }).first().waitFor();
    const xlsx = await admin.request.get(`${CONSOLE}/export/audit-log/export?format=xlsx&area=companies`);
    expect(xlsx.ok() && /spreadsheet/.test(xlsx.headers()['content-type'] ?? ''), `audit export failed: ${xlsx.status()}`);
    const bad = await admin.request.get(`${CONSOLE}/export/admins`);
    expect(bad.status() === 404, 'the export route must only serve its allowed paths');
    await admin.goto(`${CONSOLE}/security?tab=sessions`);
    await admin.getByTestId('session-row').filter({ hasText: 'This session' }).waitFor();
    await admin.goto(`${CONSOLE}/security`);
    await admin.getByTestId('suspicious').waitFor();
    await admin.goto(`${CONSOLE}/settings`);
    const notif = admin.getByTestId('settings-notifications');
    await notif.getByLabel('Renewal notice (days before)').fill('21');
    await notif.getByRole('button', { name: 'Save' }).click();
    await notif.getByText('Saved.').waitFor();
    await admin.goto(`${CONSOLE}/audit?area=settings`);
    await admin.getByTestId('audit-row').filter({ hasText: 'settings' }).first().waitFor();
    await admin.goto(`${CONSOLE}/health`);
    await admin.getByTestId('system-status').waitFor();
    for (const k of ['api', 'database']) await admin.getByTestId(`component-${k}`).waitFor();
    ok('reports and downloads, audit export, sessions, suspicious activity, settings with audit, system status');

    // 9. Plans lifecycle.
    await admin.goto(`${CONSOLE}/plans`);
    await admin.getByTestId('plan-impact-starter').click();
    await admin.getByTestId('plan-impact').waitFor();
    await admin.getByRole('button', { name: 'Close' }).click();
    await admin.getByTestId('plan-duplicate-starter').click();
    await admin.getByTestId('plan-duplicate-key').fill(`starter_${stamp.replace(/[^a-z0-9]/g, '')}`.slice(0, 40));
    await admin.getByTestId('plan-duplicate-save').click();
    const copyKey = `starter_${stamp.replace(/[^a-z0-9]/g, '')}`.slice(0, 40);
    await admin.getByTestId(`plan-${copyKey}`).waitFor();
    await admin.getByTestId(`plan-retire-${copyKey}`).click();
    await admin.getByLabel('Reason').fill('Pilot closed after the e2e run');
    await admin.getByTestId('plan-retire-confirm').click();
    await admin.getByTestId(`plan-${copyKey}`).getByText('Retired', { exact: true }).waitFor();
    await admin.getByTestId(`plan-unretire-${copyKey}`).click();
    await admin.getByTestId(`plan-${copyKey}`).getByText('Archived', { exact: true }).waitFor();
    ok('plan impact, duplicate, retire and reopen');

    // 10. Phone layout.
    const phone = await (await b.newContext({ viewport: { width: 390, height: 844 }, storageState: await admin.context().storageState() })).newPage();
    current = phone;
    watch(phone);
    await phone.goto(`${CONSOLE}/clients`);
    await phone.getByRole('heading', { name: 'Clients' }).waitFor();
    const wide = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(wide <= 1, `the Clients page scrolls sideways on a phone (${wide}px)`);
    await phone.getByRole('button', { name: 'Open menu' }).click();
    await phone.getByRole('link', { name: 'Reports' }).click();
    await phone.waitForURL(/\/reports/);
    ok('phone layout: menu opens and pages fit the screen');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('console command center flow passed');
  } catch (e) {
    if (current) await current.screenshot({ path: process.env.SHOT ?? '/tmp/console-command-center-fail.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
