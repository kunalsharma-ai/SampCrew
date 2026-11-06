/**
 * SAMPLEDGE Super Admin control of a workspace, end to end through real browsers and the real API:
 *
 *   pnpm db:reset            # fresh demo workspace and bootstrap console admin (the admin must not have MFA yet)
 *   API on :4000, Web Portal on :3000, Console on :3001, then: pnpm e2e:superadmin
 *
 * 1. The Console is in the neon design: deep sidebar, gradient KPI tiles, workspace tabs.
 * 2. Subscription: billing cycle, negotiated price and a custom employee limit are saved and shown, with history.
 * 3. Apps: the mobile app is switched off for the workspace and a mobile sign-in is refused; Leave is switched off
 *    in the mobile app only and stays on the web. Both are switched back.
 * 4. Users: the recruiter is signed out everywhere, suspended (sign-in refused) and reactivated, each with a reason.
 * 5. Activity: mobile sign-ins and the recruiter's suspension appear in the workspace's activity; the suspension opens
 *    with its recorded contents, and that read is itself in the customer's trail.
 * 6. Attendance machines: HR registers a Hikvision face reader on the SampCrew device API in the Web Portal, sees its
 *    token once, and the machine sends punches. The Console sees it online, pauses it (pushes refused, HR sees
 *    "Paused by SAMPLEDGE"), resumes it, then switches the Hikvision integration off and on again.
 */
const { chromium } = require('playwright');
const { authenticator } = require('otplib');

const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API = (process.env.CREW_API_URL ?? 'http://localhost:4000') + '/api/v1';
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
const stamp = Date.now();

/** Signs in through the API as one app, the way the Web Portal and the mobile app identify themselves. Waits out the rate limit. */
/** A public API call (sign-in steps), as the web client. */
async function api(_token, method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', 'x-crew-client': 'web' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function apiSignIn(email, client) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-crew-client': client }, body: JSON.stringify({ email, password: PASSWORD }) });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 429) return { status: res.status, body };
    if (attempt >= 4) throw new Error('API sign-in stayed rate limited');
    await new Promise((r) => setTimeout(r, 20000));
  }
}
const me = (token) => fetch(`${API}/me`, { headers: { authorization: `Bearer ${token}` } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

async function webSignIn(page, email) {
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

async function toggle(page, testId, want) {
  const sw = page.getByTestId(testId);
  await sw.waitFor();
  if ((await sw.getAttribute('aria-checked')) !== String(want)) {
    await sw.click();
    await page.waitForFunction(([id, v]) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-checked') === v, [testId, String(want)], { timeout: 15000 });
  }
}

async function userAction(page, email, action, reason) {
  await page.getByTestId(`act-${action}-${email}`).click();
  const d = page.locator('dialog[open]');
  await d.locator('textarea').fill(reason);
  await d.locator('footer button, button').filter({ hasText: /Sign out everywhere|Suspend|Reactivate|Reset two-step|Resend invitation|Reset password|Force password change|Lock account|Unlock account/ }).last().click();
  await page.locator('[role=alert], .crew-alert').filter({ hasText: 'done for' }).first().waitFor({ timeout: 15000 }).catch(async () => {
    await page.getByText('done for').first().waitFor({ timeout: 5000 });
  });
}

(async () => {
  const b = await chromium.launch();
  const admin = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const hr = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [admin, hr]) watch(p);
  let current = admin;
  try {
    // 1. Console sign-in with mandatory MFA. The neon design is on.
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
    expect((await admin.locator('html').getAttribute('data-style')) === 'neon', 'Console should default to the neon style');
    const sidebarBg = await admin.locator('aside.crew-sidebar').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(/gradient/.test(sidebarBg), `neon sidebar should have its gradient, got ${sidebarBg}`);
    const tileBg = await admin.locator('.crew-tile').first().evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(/gradient/.test(tileBg), 'KPI tiles should be gradient tiles');
    await shot(admin, 'sa-01-overview');
    ok('Console opens in the neon design (night sidebar, gradient KPI tiles)');

    await admin.goto(`${CONSOLE}/tenants`);
    await admin.click('a:has-text("Northwind")');
    await admin.waitForURL(/\/tenants\/[0-9a-f-]{36}$/);
    const tenantUrl = admin.url();
    for (const tab of ['overview', 'access', 'users', 'activity', 'devices']) await admin.getByTestId(`ws-tab-${tab}`).waitFor();
    ok('Workspace has Overview, Features & permissions, Users, Activity and Attendance machines tabs');

    // 2. Subscription controls.
    await admin.click('button:has-text("Adjust subscription")');
    const sd = admin.locator('dialog[open]');
    await sd.getByLabel('Billing cycle').selectOption('annual');
    await sd.getByLabel(/Price per seat per month/).fill('333.00');
    await sd.getByLabel('Employees included').fill('750');
    await sd.locator('button:has-text("Save")').click();
    await admin.getByText('Subscription updated.').waitFor();
    await admin.waitForFunction(() => /annual/.test(document.querySelector('[data-testid="sub-billing"]')?.textContent ?? '') && /333\.00/.test(document.querySelector('[data-testid="sub-billing"]')?.textContent ?? ''));
    await admin.getByText('Employees included: 750 (custom)').waitFor();
    await admin.getByRole('table', { name: 'Subscription history' }).getByText('Subscription changed').first().waitFor();
    await shot(admin, 'sa-02-subscription');
    ok('Subscription: annual billing, a negotiated price and a custom employee limit saved, with history');

    // 3. Apps: switch the mobile app off, then Leave off in the mobile app only.
    await admin.goto(`${tenantUrl}/access?tab=apps`);
    await toggle(admin, 'switch-app-mobile', false);
    const refused = await apiSignIn('uk.sales@demo.crew.local', 'mobile');
    expect(refused.status === 403 && refused.body.error?.code === 'app_switched_off', `mobile sign-in should be refused, got ${refused.status} ${JSON.stringify(refused.body)}`);
    const webOk = await apiSignIn('uk.sales@demo.crew.local', 'web');
    expect(webOk.body.status === 'ok', 'web sign-in should still work');
    await shot(admin, 'sa-03-apps-mobile-off');
    await toggle(admin, 'switch-app-mobile', true);
    ok('Mobile app switched off: mobile sign-in refused, web still works; switched back on');

    await toggle(admin, 'switch-mobile-leave', false);
    const mob = await apiSignIn('uk.sales@demo.crew.local', 'mobile');
    expect(mob.body.status === 'ok', 'mobile sign-in should work again');
    const mobMe = await me(mob.body.accessToken);
    expect(!mobMe.body.features.includes('leave') && mobMe.body.featureBlocks.leave === 'channel_off', 'Leave should be off in the mobile app');
    const webMe = await me(webOk.body.accessToken);
    expect(webMe.body.features.includes('leave'), 'Leave should stay on in the Web Portal');
    await toggle(admin, 'switch-mobile-leave', true);
    expect((await me(mob.body.accessToken)).body.features.includes('leave'), 'Leave should be back in the mobile app');
    ok('Leave switched off in the mobile app only (web keeps it), then back on');

    // 4. Users: sign out, suspend, reactivate.
    await admin.goto(`${tenantUrl}/users`);
    const rec = 'recruiter@demo.crew.local';
    await admin.getByTestId(`user-${rec}`).waitFor();
    const recSession = await apiSignIn(rec, 'web');
    await userAction(admin, rec, 'sign_out', 'E2E: ticket 1001, lost laptop');
    expect((await me(recSession.body.accessToken)).status === 401, 'recruiter session should have ended');
    await userAction(admin, rec, 'suspend', 'E2E: customer asked us to');
    expect((await apiSignIn(rec, 'web')).body.status !== 'ok', 'suspended recruiter should not sign in');
    await admin.getByTestId(`user-${rec}`).getByText('suspended').waitFor();
    await shot(admin, 'sa-04-users');
    await userAction(admin, rec, 'reactivate', 'E2E: customer asked us to');
    expect((await apiSignIn(rec, 'web')).body.status === 'ok', 'reactivated recruiter should sign in');
    ok('Users: recruiter signed out everywhere, suspended (sign-in refused) and reactivated, each with a reason');

    // Password control: passwords are hashed, so the Console resets them; the new one is shown once.
    await userAction(admin, rec, 'reset_password', 'E2E: ticket 1002, forgot password');
    const temp = (await admin.getByTestId('console-temporary-password').textContent()).trim();
    expect(temp.length === 16, `temporary password looks wrong: ${temp}`);
    expect((await apiSignIn(rec, 'web')).status === 401, 'the old password should stop working after a reset');
    const first = await api(null, 'POST', '/auth/login', { email: rec, password: temp });
    expect(first.body.status === 'password_change_required', `expected a forced password change, got ${first.body.status}`);
    const chosen = 'Recruiter-New-Pass-2026';
    expect((await api(null, 'POST', '/auth/initial-password', { changeToken: first.body.changeToken, newPassword: chosen })).body.status === 'ok', 'could not choose a new password');
    await admin.reload();
    await userAction(admin, rec, 'lock_account', 'E2E: ticket 1003, suspicious sign-ins');
    expect((await api(null, 'POST', '/auth/login', { email: rec, password: chosen })).body.status !== 'ok', 'a locked account should not sign in');
    await userAction(admin, rec, 'unlock_account', 'E2E: ticket 1003 closed');
    expect((await api(null, 'POST', '/auth/login', { email: rec, password: chosen })).body.status === 'ok', 'an unlocked account should sign in');
    ok('Users: password reset shown once (old one refused, new one forced at sign-in), account locked and unlocked');

    await admin.goto(`${CONSOLE}/users?q=demo.crew.local`);
    await admin.getByTestId(`user-${rec}`).getByRole('link', { name: /Northwind/ }).waitFor();
    ok('All users lists the workspace\'s people with their workspace');

    // 5. Activity.
    await admin.goto(`${tenantUrl}/activity`);
    const mobileSignIns = Number((await admin.getByTestId('tile-mobile-signins').textContent()).replace(/\D/g, ''));
    expect(mobileSignIns >= 1, 'mobile sign-ins should be counted');
    await admin.getByRole('table', { name: 'Activity' }).getByText('membership.suspend_by_sampledge').first().waitFor();
    await shot(admin, 'sa-05-activity');
    ok('Activity shows mobile sign-ins and SAMPLEDGE\'s own actions in the customer\'s trail');

    // Open the suspension: its recorded contents (the reason given) and the person's history, and the read is logged.
    const suspendRow = admin.getByRole('table', { name: 'Activity' }).getByRole('row').filter({ hasText: 'membership.suspend_by_sampledge' }).first();
    await suspendRow.getByRole('link', { name: /View changes/ }).click();
    await admin.getByText('This view is recorded').waitFor();
    await admin.getByRole('table', { name: 'What changed' }).getByText('E2E: customer asked us to').first().waitFor();
    await admin.getByRole('table', { name: 'History of this record' }).getByText('membership.reactivate_by_sampledge').waitFor();
    await shot(admin, 'sa-05b-activity-contents');
    await admin.goto(`${tenantUrl}/activity?area=activity`);
    await admin.getByRole('table', { name: 'Activity' }).getByText('activity.contents_viewed_by_sampledge').first().waitFor();
    ok('Activity: an event opens with its recorded contents and history, and the read appears in the customer\'s trail');

    // 6. Attendance machines: HR registers a Hikvision reader on the device API.
    current = hr;
    await webSignIn(hr, 'hr.admin@demo.crew.local');
    await hr.goto(`${WEB}/settings/devices`);
    await hr.getByTestId('integration-hikvision').getByText('Available').waitFor();
    await hr.click('text=Register device');
    const dd = hr.locator('dialog[open]');
    await dd.locator('input[name=name]').fill('Main gate face reader');
    await dd.locator('select[name=vendor]').selectOption('hikvision');
    await dd.locator('input[name=serialNumber]').fill(`HK${stamp}`);
    await dd.locator('select[name=locationId]').selectOption({ label: 'Pune Plant' });
    await dd.locator('button[type=submit]').click();
    const token = (await hr.getByTestId('device-token').textContent()).trim();
    expect(token.startsWith('crewdev_'), 'machine token should be shown once');
    await shot(hr, 'sa-06-web-token');
    await hr.click('button:has-text("Done")');
    await hr.waitForURL(/\/settings\/devices\/[0-9a-f-]{36}/);
    await hr.getByText('Setup: SampCrew device API').waitFor();
    const send = (path, body) => fetch(`${API}/device-api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect((await send('heartbeat', { firmware: 'V3.4.2' })).status === 200, 'heartbeat should be accepted');
    const today = new Date(Date.now() - 60 * 60_000).toISOString().slice(0, 19) + 'Z';
    const up = await (await send('punches', { punches: [{ userId: '9001', time: today, direction: 'in', verify: 'face', id: `e2e-${stamp}` }] })).json();
    expect(up.accepted === 1, `punch should be accepted, got ${JSON.stringify(up)}`);
    await hr.reload();
    await hr.getByText('Online').first().waitFor();
    await shot(hr, 'sa-07-web-device');
    ok('HR registered a Hikvision reader on the SampCrew device API; it sent a heartbeat and a punch');

    current = admin;
    await admin.goto(`${CONSOLE}/devices`);
    await admin.getByTestId(`device-HK${stamp}`).getByText('online').waitFor();
    await shot(admin, 'sa-08-all-machines');
    await admin.getByTestId(`pause-HK${stamp}`).click();
    const pd = admin.locator('dialog[open]');
    await pd.locator('textarea').fill('E2E: unexpected traffic');
    await pd.locator('button:has-text("Pause machine")').click();
    await admin.getByTestId(`device-HK${stamp}`).getByText('paused').waitFor();
    expect((await send('heartbeat', {})).status === 403, 'paused machine should be refused');
    current = hr;
    await hr.reload();
    await hr.getByText('Paused by SAMPLEDGE').first().waitFor();
    await hr.getByText('E2E: unexpected traffic').first().waitFor();
    ok('Console paused the machine: its pushes are refused and HR sees why');

    current = admin;
    await admin.getByTestId(`resume-HK${stamp}`).click();
    await admin.getByTestId(`device-HK${stamp}`).getByText('online').waitFor();
    expect((await send('heartbeat', {})).status === 200, 'resumed machine should be accepted');
    await admin.goto(`${tenantUrl}/devices`);
    await toggle(admin, 'switch-int-hikvision', false);
    expect((await send('heartbeat', {})).status === 403, 'machine of a switched-off integration should be refused');
    current = hr;
    await hr.goto(`${WEB}/settings/devices`);
    await hr.getByTestId('integration-hikvision').getByText('Switched off by SAMPLEDGE').waitFor();
    current = admin;
    await shot(admin, 'sa-09-integrations');
    await toggle(admin, 'switch-int-hikvision', true);
    expect((await send('heartbeat', {})).status === 200, 'machine should be accepted again');
    ok('Hikvision integration switched off (machine refused, HR told) and back on');

    const real = errs.filter((e) => !/hydrat|Download the React DevTools/.test(e));
    if (real.length) throw new Error(`Browser errors:\n${real.join('\n')}`);
    console.log('\nSuper Admin control flow passed.');
  } catch (e) {
    await current.screenshot({ path: 'superadmin-failure.png', fullPage: true }).catch(() => {});
    console.error('FAILED:', e.message, '\nat', current.url());
    process.exitCode = 1;
  } finally {
    await b.close();
  }
})();
