/**
 * Mobile app end-to-end flow. Runs the Expo web build of the app (apps/mobile/dist-web) in Chromium at a phone
 * size, against the real API and the demo workspace. The native iOS and Android builds share every screen and
 * all app logic with this build; what differs (keychain, biometrics, push, screenshot blocking) is not
 * exercised here.
 *
 *   pnpm db:reset
 *   pnpm dev:api &                          # CORS_ORIGINS must include http://localhost:8081
 *   pnpm --filter @crew/mobile export:web   # with EXPO_PUBLIC_CREW_API_URL=http://localhost:4000
 *   node e2e/mobile-flow.cjs
 *
 * 1. The QA lead signs in (a wrong password is refused first) and sees the demo workspace notice.
 * 2. Punches in online, then punches out with no connection: the punch is kept on the phone and sent when the
 *    connection is back, with its original time and the "offline" flag.
 * 3. Applies for leave with a preview of working days; their manager approves it from the mobile app.
 * 4. Asks HR a question. HR replies and asks for more, the employee answers, HR resolves, the employee rates
 *    the answer and confirms. Case text never appears in the audit trail.
 * 5. Reads and acknowledges an announcement that HR published.
 * 6. Opens a payslip, when payroll has published one.
 * 7. Another employee with two-step sign-in signs in with an authenticator code.
 * 8. Signs this phone out from the devices screen; the server refuses its old refresh token afterwards.
 * Fails on any browser error.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { authenticator } = require('otplib');

const API = (process.env.CREW_API_URL ?? 'http://localhost:4000') + '/api/v1';
const PORT = Number(process.env.MOBILE_PORT ?? 8081);
const APP = process.env.MOBILE_URL ?? `http://localhost:${PORT}`;
const DIST = path.join(__dirname, '..', 'apps', 'mobile', 'dist-web');
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => {
    // Requests made while the test has switched the network off fail on purpose.
    if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|Failed to fetch|Failed to load resource/.test(m.text())) errs.push(`${who} ${m.text()}`);
  });
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
};

/** Serves the exported app; unknown paths get index.html so deep links work. */
function serve() {
  if (process.env.MOBILE_URL) return null;
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`Build the app first: pnpm --filter @crew/mobile export:web (missing ${DIST})`);
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.normalize(path.join(DIST, url));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(PORT, () => r(server)));
}

// --- API helpers (the HR side of the flow) -------------------------------------------------------------------

async function api(token, method, p, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + p, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text}`);
    return json;
  }
}
async function apiLogin(email) {
  const r = await api(null, 'POST', '/auth/login', { email, password: PASSWORD });
  if (r.status !== 'ok') throw new Error(`${email} needs ${r.status} to sign in through the API; run on a fresh database (pnpm db:reset)`);
  return r.accessToken;
}

// --- App helpers -----------------------------------------------------------------------------------------------

async function phone(b, who) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 18.5205, longitude: 73.8566, accuracy: 15 }, permissions: ['geolocation'] });
  const p = await ctx.newPage();
  watch(p, who);
  return { ctx, p };
}

async function signIn(p, email, { code } = {}) {
  for (let attempt = 0; ; attempt++) {
    await p.goto(APP + '/login');
    await p.getByLabel('Work email').fill(email);
    await p.getByLabel('Password').fill(PASSWORD);
    await p.getByRole('button', { name: 'Sign in' }).click();
    if (code) {
      await p.getByText('Two-step sign-in').waitFor({ timeout: 15000 });
      await p.getByLabel('Code').fill(code());
      await p.getByRole('button', { name: 'Verify' }).click();
    }
    const r = await Promise.race([
      p.getByText(/^Hello/).waitFor({ timeout: 20000 }).then(() => 'in'),
      p.getByText('Too many attempts').waitFor({ timeout: 20000 }).then(() => 'limited'),
    ]);
    if (r === 'in') return;
    if (attempt >= 4) throw new Error(`sign-in for ${email} stayed rate limited`);
    await p.waitForTimeout(20000);
  }
}

const tab = (p, name) => p.getByRole('tab', { name }).or(p.getByRole('link', { name })).first().click();

const shot = async (p, e) => {
  await p.screenshot({ path: process.env.SHOT ?? '/tmp/mobile-fail.png', fullPage: true }).catch(() => {});
  throw e;
};

/** A weekday about three weeks ahead with no leave request yet (so the flow can run again). */
function futureWeekday(taken) {
  const d = new Date();
  d.setDate(d.getDate() + 21);
  const iso = () => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  while (d.getDay() === 0 || d.getDay() === 6 || taken.has(iso())) d.setDate(d.getDate() + 1);
  return iso();
}

(async () => {
  const server = await serve();
  const b = await chromium.launch();
  const hr = await apiLogin('hr.admin@demo.crew.local');
  const qaEmail = 'qa.lead@demo.crew.local';
  const { ctx, p } = await phone(b, 'qa.lead');
  try {
    // 1. Sign in: a wrong password is refused, the browser build says where tokens are kept.
    await p.goto(APP + '/');
    await p.getByTestId('web-preview-notice').waitFor();
    await p.getByLabel('Work email').fill(qaEmail);
    await p.getByLabel('Password').fill('not-the-password');
    await p.getByRole('button', { name: 'Sign in' }).click();
    await p.getByTestId('login-error').waitFor();
    await signIn(p, qaEmail);
    await p.getByTestId('demo-banner').waitFor();
    ok('QA lead signed in on the mobile app; wrong password refused; demo workspace labelled');
    const qa = JSON.parse(await p.evaluate(() => localStorage.getItem('crew.tokens'))).accessToken;
    const devices = await api(qa, 'GET', '/mobile/devices');
    assert(devices.some((d) => d.platform === 'web' && !d.revokedAt), 'this browser is registered as a device');

    // 2. Punch in online, punch out offline, then send.
    await tab(p, 'Attendance');
    // Works whether or not the QA lead has punched already today (reruns): first punch follows the server.
    const first = (await api(qa, 'GET', '/attendance/today')).nextDirection;
    const second = first === 'in' ? 'out' : 'in';
    const label = (d) => (d === 'in' ? 'Punch in' : 'Punch out');
    await p.getByTestId('punch-button').getByText(label(first)).waitFor();
    await p.getByTestId('punches-card').waitFor();
    await p.getByTestId('punch-button').click();
    await p.getByTestId('punch-result').getByText(new RegExp(`Punched ${first} at`)).waitFor();
    await p.getByTestId('punches-card').getByText(/Mobile app/).first().waitFor();
    ok(`punched ${first} online with the phone location`);

    await ctx.setOffline(true);
    await p.getByTestId('punch-button').getByText(label(second)).waitFor();
    await p.getByTestId('punch-button').click();
    await p.getByTestId('punch-result').getByText(/Saved on this phone/).waitFor({ timeout: 30000 });
    await p.getByTestId('queue-card').getByText('Waiting to send (1)').waitFor();
    const queuedAt = Date.now();
    ok(`punched ${second} with no connection: kept on the phone`);
    await p.waitForTimeout(1500);
    await ctx.setOffline(false);
    await p.getByTestId('sync-button').click();
    await p.getByTestId('queue-card').waitFor({ state: 'detached', timeout: 20000 });
    await p.getByTestId('punches-card').getByText(/Sent after being offline/).last().waitFor({ timeout: 20000 });
    const today = await api(qa, 'GET', '/attendance/today');
    const out = today.punches.filter((x) => x.direction === second).pop();
    assert(out && out.source === 'mobile' && out.flags.includes('offline'), 'the offline punch is stored with the offline flag');
    assert(Math.abs(Date.parse(out.at) - queuedAt) < 5000, `the punch keeps the time it was made (${out.at})`);
    ok('back online: queued punch sent with its original time and flagged as offline');

    // 3. Leave request with preview; approved by the manager on their phone.
    await tab(p, 'Leave');
    await p.getByTestId('apply-leave').click();
    await p.getByRole('radio', { name: /^Casual leave/ }).click();
    const mine = await api(qa, 'GET', '/leave/requests');
    const day = futureWeekday(new Set(mine.filter((r) => r.status !== 'cancelled' && r.status !== 'rejected').map((r) => r.startDate)));
    await p.getByLabel('From (YYYY-MM-DD)').fill(day);
    await p.getByLabel('To (YYYY-MM-DD)').fill(day);
    const reason = `Mobile e2e ${Date.now()}: family visit`;
    await p.getByLabel('Reason (optional)').fill(reason);
    await p.getByTestId('leave-preview').waitFor();
    await p.getByTestId('send-leave').click();
    await p.getByTestId('leave-requests').getByText(reason, { exact: false }).waitFor();
    await p.getByTestId('leave-requests').getByText('Waiting for approval').first().waitFor();
    ok(`applied for casual leave on ${day} with a preview of working days`);

    const mgr = await phone(b, 'plant.head');
    await signIn(mgr.p, 'plant.head@demo.crew.local');
    await mgr.p.getByTestId('home-approvals').click();
    const item = mgr.p.getByTestId('approval-item').filter({ hasText: reason });
    await item.getByRole('button', { name: 'Approve' }).click();
    await mgr.p.getByTestId('approval-message').getByText(/Approved/).waitFor();
    ok('the plant head approved it from the Approvals screen');
    await p.reload();
    await p.getByTestId('leave-requests').locator('div').filter({ hasText: reason }).filter({ hasText: 'Approved' }).last().waitFor();
    ok('the QA lead sees the leave approved');

    // 4. Helpdesk conversation.
    await tab(p, 'Ask HR');
    await p.getByTestId('new-case').click();
    await p.getByRole('radio', { name: 'Pay and payslips' }).click();
    const subject = `Mobile e2e ${Date.now()}: shift allowance missing`;
    await p.getByLabel('Subject').fill(subject);
    await p.getByLabel('Your question').fill('My night shift allowance for last month is not on my payslip. Can you check?');
    await p.getByTestId('send-case').click();
    await p.getByTestId('case-header').getByText(subject).waitFor();
    const caseId = p.url().split('/').pop();
    const created = await api(hr, 'GET', `/helpdesk/cases/${caseId}`);
    assert(/^HR-\d{4}$/.test(created.ref) && created.status === 'open', 'case is numbered and open');
    ok(`raised ${created.ref} from the app`);

    await api(hr, 'POST', `/helpdesk/cases/${caseId}/messages`, { body: 'Which dates did you work nights?', internal: false });
    await api(hr, 'POST', `/helpdesk/cases/${caseId}/messages`, { body: 'Check the roster export (internal)', internal: true });
    await api(hr, 'POST', `/helpdesk/cases/${caseId}/status`, { status: 'waiting_on_employee' });
    await p.reload();
    await p.getByText('HR is waiting for your reply.').waitFor();
    await p.getByText('Which dates did you work nights?').waitFor();
    assert((await p.getByText('Check the roster export (internal)').count()) === 0, 'internal note is hidden from the employee');
    await p.getByLabel('Reply').fill('The 14th to the 18th.');
    await p.getByTestId('send-reply').click();
    await p.getByTestId('conversation').getByText('The 14th to the 18th.').waitFor();
    assert((await api(hr, 'GET', `/helpdesk/cases/${caseId}`)).status === 'in_progress', 'employee reply moves the case back to in progress');
    ok('HR asked for more, the employee answered from the app; internal note stayed hidden');

    await api(hr, 'POST', `/helpdesk/cases/${caseId}/status`, { status: 'resolved', message: 'Added to this month as arrears.' });
    await p.reload();
    await p.getByText('Added to this month as arrears.').waitFor();
    const rate = p.getByTestId('rate-card');
    await rate.getByRole('radio', { name: '5' }).click();
    await rate.getByRole('button', { name: 'Send rating' }).click();
    await p.getByTestId('case-message').getByText('Thanks for the feedback.').waitFor();
    await p.getByTestId('move-closed').click();
    await p.getByTestId('case-message').getByText('Thanks. The case is closed.').waitFor();
    const closed = await api(hr, 'GET', `/helpdesk/cases/${caseId}`);
    assert(closed.status === 'closed' && closed.satisfaction === 5, 'case closed with rating 5');
    const trail = await api(await apiLogin('auditor@demo.crew.local'), 'GET', `/audit-events?resourceType=helpdesk_case&resourceId=${caseId}`);
    assert(JSON.stringify(trail).includes('helpdesk.'), 'case actions are audited');
    assert(!JSON.stringify(trail).includes('shift allowance') && !JSON.stringify(trail).includes('14th to the 18th'), 'case text is not in the audit trail');
    ok('HR resolved it; the employee rated and confirmed it from the app');

    // 5. Announcement with acknowledgement.
    const annTitle = `Mobile e2e ${Date.now()}: new canteen timings`;
    const ann = await api(hr, 'POST', '/announcements', { title: annTitle, body: 'Lunch is now served from 12:30 to 14:00.', requiresAck: true });
    await api(hr, 'POST', `/announcements/${ann.id}/publish`);
    await p.goto(APP + '/');
    const row = p.getByTestId('home-announcements').getByText(annTitle);
    await row.waitFor();
    await row.click();
    await p.getByTestId('acknowledge').click();
    await p.getByTestId('acknowledged').waitFor();
    const receipts = await api(hr, 'GET', `/announcements/manage/${ann.id}`);
    const me = receipts.people.find((x) => x.name.includes('Farhan'));
    assert(me && me.readAt && me.acknowledgedAt, 'HR sees the read and the acknowledgement');
    ok('read and acknowledged an announcement; HR sees the receipt');

    // 6. Payslip (present once the payroll flow has published one).
    const slips = await api(qa, 'GET', '/payslips?mine=true');
    if (slips.length) {
      await p.goto(APP + '/me');
      await p.getByTestId('payslips').getByText(/₹/).first().click();
      await p.getByTestId('net-pay').waitFor();
      const shown = await p.getByTestId('net-pay').textContent();
      assert(shown.replace(/[^\d.]/g, '') === slips[0].net, `net pay shown exactly (${shown} vs ${slips[0].net})`);
      ok('opened a payslip; net pay shown to the paisa');
    } else ok('# skip payslip: no published payslip for the QA lead yet (run after e2e:payroll)');

    // 7. Two-step sign-in with an authenticator code.
    const ukSales = 'uk.sales@demo.crew.local';
    const us = await apiLogin(ukSales);
    const { secret } = await api(us, 'POST', '/me/mfa/setup');
    await api(us, 'POST', '/me/mfa/enable', { code: authenticator.generate(secret) });
    const two = await phone(b, 'uk.sales');
    await signIn(two.p, ukSales, { code: () => authenticator.generate(secret) });
    await two.p.getByText('Hello, Oliver').waitFor();
    ok('an employee with two-step sign-in signed in with an authenticator code');
    await two.ctx.close();
    await mgr.ctx.close();

    // 8. Sign this phone out from the devices screen.
    const tokens = JSON.parse(await p.evaluate(() => localStorage.getItem('crew.tokens')));
    await p.goto(APP + '/me');
    await p.getByRole('button', { name: 'Signed-in devices' }).click();
    await p.getByText('(this device)', { exact: false }).waitFor();
    await p.getByTestId('sign-out-this-device').click();
    await p.getByLabel('Work email').waitFor();
    const refresh = await fetch(API + '/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: tokens.refreshToken }) });
    assert(refresh.status === 401, `old refresh token refused after sign-out (got ${refresh.status})`);
    const after = await api(await apiLogin(qaEmail), 'GET', '/mobile/devices');
    assert(after.every((d) => d.revokedAt), 'the device shows as signed out');
    ok('signed the phone out; the server refuses its old session');

    if (errs.length) throw new Error('browser errors:\n' + errs.join('\n'));
    console.log('mobile flow passed');
  } catch (e) {
    await shot(p, e);
  } finally {
    await b.close();
    server?.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
