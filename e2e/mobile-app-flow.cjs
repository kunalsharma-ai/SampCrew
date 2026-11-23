/**
 * One centralized mobile app controlled by the Super Workspace, end to end: the Web Portal (:3000), the API (:4000)
 * and the mobile app's browser build (served here on 8081, like e2e/mobile-flow.cjs).
 *
 *   pnpm db:reset && node apps/api/dist/main.js & pnpm --filter @crew/web start &
 *   pnpm --filter @crew/mobile export:web
 *   node e2e/mobile-app-flow.cjs
 *
 * 1. An employee opens Email on the phone (the company has no email server, so it says so), so Email is "in use".
 * 2. The Super Workspace hides Email in Settings > Mobile app: the preview shows it gone, publishing warns that people
 *    use it and needs a confirmation.
 * 3. The phone loses Email from More without reinstalling; its address says it is not available; the API refuses
 *    the phone's Email requests (mobile_module_off) while the Web Portal session of the same person still works.
 * 4. Attendance with a break: check in, start and end a break, check out; a break that was never started is refused.
 * 5. Chat: the employee messages the plant head from the phone; the plant head reads it and the phone shows "Read".
 * 6. Learning: HR assigns a course; the employee starts and completes it on the phone; HR sees it completed.
 * 7. Login and sessions shows this sign-in; leave is applied from the More menu.
 * 8. The Super Workspace shows Email again: it comes back on the phone, and History lists both versions.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));
const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';

const API = (process.env.API_URL ?? 'http://localhost:4000') + '/api/v1';
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const PORT = Number(process.env.MOBILE_PORT ?? 8081);
const APP = process.env.MOBILE_URL ?? `http://localhost:${PORT}`;
const DIST = path.join(__dirname, '..', 'apps', 'mobile', 'dist-web');
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const SHOTS = process.env.SHOTS;
const EMPLOYEE = 'qa.lead@demo.crew.local';
const OWNER = 'owner@demo.crew.local';

const ok = (m) => console.log(`ok - ${m}`);
const assert = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
};
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  // Refused requests (a hidden module answers 403 on purpose) are logged by the browser; they are checked explicitly.
  p.on('console', (m) => m.type() === 'error' && !/status of 40[34]|Failed to load resource/.test(m.text()) && errs.push(`${who} ${m.text()}`));
};
const save = async (p, name) => {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
};

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

/** A request with a token; returns { status, body } so refusals can be checked. */
async function call(token, method, p, body, client) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + p, {
      method,
      headers: { 'content-type': 'application/json', ...(client ? { 'x-crew-client': client } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}
async function api(token, method, p, body, client) {
  const r = await call(token, method, p, body, client);
  if (r.status >= 400) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function apiLogin(email, client) {
  const r = await api(null, 'POST', '/auth/login', { email, password: PASSWORD }, client);
  if (r.status !== 'ok') throw new Error(`${email} needs ${r.status} to sign in through the API; run on a fresh database (pnpm db:reset)`);
  return r.accessToken;
}

async function phone(b) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 2 : 1, geolocation: { latitude: 18.5205, longitude: 73.8566, accuracy: 15 }, permissions: ['geolocation'] });
  const p = await ctx.newPage();
  watch(p, 'phone');
  for (let attempt = 0; ; attempt++) {
    await p.goto(APP + '/login');
    await p.getByLabel('Work email').fill(EMPLOYEE);
    await p.getByLabel('Password').fill(PASSWORD);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    const r = await Promise.race([
      p.getByText(/^Good (morning|afternoon|evening)/).waitFor({ timeout: 20000 }).then(() => 'in'),
      p.getByText('Too many attempts').waitFor({ timeout: 20000 }).then(() => 'limited'),
    ]);
    if (r === 'in') return { ctx, p };
    if (attempt >= 4) throw new Error('phone sign-in stayed rate limited');
    await p.waitForTimeout(20000);
  }
}

async function web(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const p = await ctx.newPage();
  watch(p, 'web');
  for (let attempt = 0; ; attempt++) {
    await p.goto(WEB + '/login');
    await p.fill('input[name=email]', email);
    await p.fill('input[name=password]', PASSWORD);
    await p.click('button[type=submit]');
    const r = await Promise.race([
      p.waitForURL((u) => u.pathname === '/', { timeout: 15000 }).then(() => 'in'),
      p.locator('text=Too many requests').waitFor({ timeout: 15000 }).then(() => 'limited'),
    ]);
    if (r === 'in') return { ctx, p };
    if (attempt >= 4) throw new Error(`web sign-in for ${email} stayed rate limited`);
    await p.waitForTimeout(20000);
  }
}

/** A row link (IconRow) by its title; a row with a subtitle is named by all its visible text. */
const rowLink = (list, title) => list.getByRole('link').filter({ has: list.page().getByText(title, { exact: true }) });

/** The More menu's module names on the phone. */
async function moreNames(p) {
  await p.goto(APP + '/more');
  await p.getByTestId('more-list').waitFor();
  return p.getByTestId('more-list').locator('[data-testid$="-title"]').allInnerTexts();
}

(async () => {
  const server = await serve();
  const b = await chromium.launch();
  // The demo owner is the Super Workspace; an earlier flow (e2e:web) turned on their MFA. Off for this run, restored after.
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const users = mongo.db().collection('users');
  const ownerBefore = await users.findOne({ email: OWNER });
  await users.updateOne({ _id: ownerBefore._id }, { $set: { mfa_enabled: false, mfa_secret_enc: null } });
  let ph;
  let owner;
  try {
    const ownerApi = await apiLogin(OWNER);
    const start = await api(ownerApi, 'GET', '/mobile-app');
    assert(start.published.config.modules.email.enabled, 'Email starts shown on phones (run on a fresh database)');
    const firstVersion = start.published.version;

    // 1. The employee opens Email on the phone.
    ph = await phone(b);
    const p = ph.p;
    assert((await moreNames(p)).includes('Email'), 'Email is in More');
    await rowLink(p.getByTestId('more-list'), 'Email').click();
    await p.getByTestId('email-setup').getByText('Email is not set up yet').waitFor();
    await save(p, 'phone-email-setup');
    ok('the phone lists Email in More and says email is not set up yet');

    // 2. The Super Workspace hides Email.
    owner = await web(b, OWNER);
    const w = owner.p;
    await w.goto(WEB + '/settings/mobile-app');
    await w.getByTestId('mobile-app-manager').waitFor();
    await w.getByTestId('switch-email').click();
    await w.getByTestId('preview-more').waitFor();
    assert(!(await w.getByTestId('preview-more').innerText()).includes('Email'), 'the preview no longer shows Email');
    await w.getByRole('button', { name: 'Review and publish' }).click();
    await w.getByText('People use these on their phones').waitFor();
    assert(await w.getByTestId('confirm-publish').isDisabled(), 'publishing waits for the confirmation');
    await w.getByLabel('Hide it anyway').check();
    await w.getByPlaceholder('Why this change').fill('Email moves to the Web Portal only');
    await save(w, 'web-publish-dialog');
    await w.getByTestId('confirm-publish').click();
    await w.getByText(/Version \d+ published/).waitFor({ timeout: 20000 });
    const after = await api(ownerApi, 'GET', '/mobile-app');
    assert(after.published.version === firstVersion + 1 && !after.published.config.modules.email.enabled, 'a new version without Email is published');
    ok('the Super Workspace hid Email: the preview follows, publishing asks to confirm because people use it');

    // 3. The phone follows without reinstalling, and the server refuses the module.
    await p.goto(APP + '/');
    await p.getByText(/^Good (morning|afternoon|evening)/).waitFor();
    let names = [];
    for (let i = 0; i < 10; i++) {
      names = await moreNames(p);
      if (!names.includes('Email')) break;
      await p.waitForTimeout(1500);
    }
    assert(!names.includes('Email'), `Email left More (${names.join(', ')})`);
    await p.goto(APP + '/email');
    await p.getByTestId('module-off').getByText('Not available in the app').waitFor();
    await save(p, 'phone-module-off');
    const phoneToken = JSON.parse(await p.evaluate(() => localStorage.getItem('crew.tokens'))).accessToken;
    const refused = await call(phoneToken, 'GET', '/communication/emails/inbox');
    assert(refused.status === 403 && refused.body?.error?.code === 'mobile_module_off', `the phone's Email request is refused (${refused.status})`);
    const webToken = await apiLogin(EMPLOYEE);
    assert((await call(webToken, 'GET', '/communication/emails/inbox')).status === 200, 'the same person still reads Email on the Web Portal');
    ok('the phone lost Email at once; its address and its API are refused; the Web Portal is unchanged');

    // 4. Attendance with a break.
    await p.goto(APP + '/attendance');
    await p.getByTestId('punches-card').waitFor();
    await p.waitForTimeout(1500);
    // Start from "checked out", whatever an earlier run left (an open break, or still checked in).
    for (let i = 0; i < 3; i++) {
      await p.waitForTimeout(1500);
      if (await p.getByTestId('break-button').getByText('End break').isVisible().catch(() => false)) {
        await p.getByTestId('break-button').click();
        await p.getByTestId('punch-result').getByText(/Break ended at/).waitFor();
        await p.getByTestId('punch-button').getByText('Punch out').waitFor();
      }
      if (await p.getByTestId('punch-button').getByText('Punch out').isVisible().catch(() => false)) {
        await p.getByTestId('punch-button').click();
        await p.getByTestId('punch-result').getByText(/Punched out at/).waitFor();
      }
    }
    await p.getByTestId('punch-button').getByText('Punch in').waitFor();
    await p.getByTestId('punch-button').click();
    await p.getByTestId('punch-result').getByText(/Punched in at/).waitFor();
    await p.getByTestId('break-button').getByText('Start break').click();
    await p.getByTestId('punch-result').getByText(/Break started at/).waitFor();
    // During a break only "End break" is offered (no check-in or check-out).
    await p.getByTestId('punch-button').waitFor({ state: 'detached' });
    await p.getByTestId('break-button').getByText('End break').waitFor();
    await save(p, 'phone-on-break');
    await p.getByTestId('break-button').getByText('End break').click();
    await p.getByTestId('punch-result').getByText(/Break ended at/).waitFor();
    await p.getByTestId('punch-button').getByText('Punch out').click();
    await p.getByTestId('punch-result').getByText(/Punched out at/).waitFor();
    const today = await api(phoneToken, 'GET', '/attendance/today', undefined, 'mobile');
    const purposes = today.punches.slice(-4).map((x) => `${x.direction}:${x.purpose ?? '-'}`);
    assert(purposes.join(' ') === 'in:work out:break in:break out:work', `punches carry their purpose (${purposes.join(' ')})`);
    const device = (await api(phoneToken, 'GET', '/mobile/devices')).filter((d) => !d.revokedAt).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
    const run = `e2e-run-${Date.now()}`;
    const wrong = await api(phoneToken, 'POST', '/mobile/punches', { deviceId: device.id, sentElapsedMs: 1, sentRunId: run, punches: [{ sequence: 900000 + (Date.now() % 99999), direction: 'in', purpose: 'break', capturedAt: new Date().toISOString(), capturedElapsedMs: 1, capturedRunId: run, offline: false }] });
    assert(wrong.results[0].status === 'rejected' && wrong.results[0].reason === 'no_break', `ending a break never started is refused (${JSON.stringify(wrong.results[0])})`);
    ok('checked in, took a break and checked out; a break that was never started is refused');

    // 5. Chat.
    const head = await apiLogin('plant.head@demo.crew.local');
    const headMe = await api(head, 'GET', '/me');
    const headName = headMe.user.fullName;
    const text = `Line 2 changeover done ${Date.now()}`;
    await p.goto(APP + '/chat/new');
    await p.getByTestId('people-search').fill(headName.split(' ')[0]);
    const headRow = rowLink(p.getByTestId('people-list'), headName);
    await headRow.waitFor();
    await headRow.click();
    await p.getByTestId('chat-input').fill(text);
    await p.getByTestId('chat-send').click();
    await p.getByTestId('chat-message').filter({ hasText: text }).waitFor();
    const convs = await api(head, 'GET', '/communication/conversations');
    const conv = convs.items.find((c) => c.lastMessage?.body === text);
    assert(conv && conv.unread >= 1, 'the plant head has the message unread');
    await api(head, 'POST', `/communication/conversations/${conv.id}/read`);
    await p.getByTestId('chat-message').filter({ hasText: text }).getByText(/Read/).waitFor({ timeout: 20000 });
    await save(p, 'phone-chat');
    ok('messaged the plant head from the phone; they read it and the phone shows Read');

    // 6. Learning.
    const hr = await apiLogin('hr.admin@demo.crew.local');
    const me = (await api(webToken, 'GET', '/me')).employee;
    const course = await api(hr, 'POST', '/learning/courses', { title: `Forklift safety ${Date.now()}`, format: 'online', durationMinutes: 20, selfEnrol: false });
    await api(hr, 'POST', '/learning/assignments', { employeeIds: [me.id], courseId: course.id, dueOn: null });
    await p.goto(APP + '/learning');
    const card = p.locator('[data-testid^="assignment-"]').filter({ hasText: 'Forklift safety' }).first();
    await card.getByTestId('learning-start').click();
    await p.getByTestId('learning-message').getByText(/Started/).waitFor();
    await p.locator('[data-testid^="assignment-"]').filter({ hasText: 'Forklift safety' }).first().getByTestId('learning-complete').click();
    await p.getByTestId('learning-message').getByText(/Completed/).waitFor();
    await save(p, 'phone-learning');
    const done = (await api(hr, 'GET', `/learning/assignments?view=team&courseId=${course.id}`)).find((a) => a.employeeId === me.id);
    assert(done?.status === 'completed', `HR sees the course completed (${done?.status})`);
    ok('HR assigned a course; the employee started and completed it on the phone; HR sees it completed');

    // 7. Sessions and leave from More.
    await p.goto(APP + '/sessions');
    await p.getByTestId('sign-in-history').getByText('(this device)').waitFor();
    await save(p, 'phone-sessions');
    await moreNames(p);
    await rowLink(p.getByTestId('more-list'), 'Leave').click();
    await p.getByTestId('apply-leave').waitFor();
    ok('Login and sessions shows this sign-in; Leave opens from More');

    // 8. Show Email again; History lists both versions with who published them.
    await w.reload();
    await w.getByTestId('switch-email').click();
    await w.getByRole('button', { name: 'Review and publish' }).click();
    await w.getByTestId('confirm-publish').click();
    await w.getByText(/Version \d+ published/).waitFor({ timeout: 20000 });
    await w.getByRole('tab', { name: 'History' }).click();
    await w.getByTestId('versions').getByText('Email moves to the Web Portal only').waitFor();
    await save(w, 'web-history');
    const restored = await api(ownerApi, 'GET', '/mobile-app');
    assert(restored.published.config.modules.email.enabled && restored.published.version === firstVersion + 2, 'a third version with Email is published');
    for (let i = 0; i < 10; i++) {
      names = await moreNames(p);
      if (names.includes('Email')) break;
      await p.waitForTimeout(1500);
    }
    assert(names.includes('Email'), 'Email is back in More');
    assert((await call(phoneToken, 'GET', '/communication/emails/inbox')).status === 200, 'the phone may read Email again');
    ok('Email shown again: it is back on the phone, and History lists every version');

    assert(errs.length === 0, `no browser errors:\n${errs.join('\n')}`);
    ok('no browser errors');
  } catch (e) {
    if (ph) await ph.p.screenshot({ path: process.env.SHOT ?? '/tmp/mobile-app-fail.png', fullPage: true }).catch(() => {});
    if (owner) await owner.p.screenshot({ path: '/tmp/mobile-app-web-fail.png', fullPage: true }).catch(() => {});
    console.error(e);
    if (errs.length) console.error(errs.join('\n'));
    process.exitCode = 1;
  } finally {
    await users.updateOne({ _id: ownerBefore._id }, { $set: { mfa_enabled: ownerBefore.mfa_enabled ?? false, mfa_secret_enc: ownerBefore.mfa_secret_enc ?? null } });
    await mongo.close();
    await b.close();
    server?.close();
  }
})();
