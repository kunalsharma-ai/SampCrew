/**
 * Office, home and hybrid attendance end to end in a real browser, against a fresh demo workspace (it renames the
 * three attendance names and changes an office area, so CI runs it in its own step after `pnpm db:reset`).
 *
 *   pnpm db:reset
 *   node apps/api/dist/main.js & pnpm --filter @crew/web start &
 *   node e2e/work-mode-flow.cjs        (SHOTS=<dir> saves a screenshot of each main screen)
 *
 * 1. Super Workspace: office locations on the map, changes the Pune Plant area; renames hybrid attendance.
 * 2. Employee Workspace at the plant checks in: "Working From Office". Another from home: "Working From Home". A
 *    third with location refused: Pending verification, never home.
 * 3. Super Workspace: workforce dashboard (cards, donut, trend), the people behind the hybrid card, the register,
 *    verifies the pending day with a reason (day history), and downloads the 8-sheet report.
 * 4. HR Workspace sees the dashboard; Employee Workspace is sent back to its own attendance.
 * 5. Cleans up: names and area restored.
 * Fails on any browser error.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { unzipSync, strFromU8 } = require(require.resolve('fflate', { paths: [path.join(__dirname, '../apps/api')] }));

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const API = `${process.env.CREW_API_URL ?? 'http://localhost:4000'}/api/v1`;
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const PUNE = { latitude: 18.5205, longitude: 73.8566, accuracy: 20 };
const HOME = { latitude: 18.559, longitude: 73.7868, accuracy: 20 };

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/status of (404|502)/.test(m.text()) && !/map-tiles/.test(m.text()) && errs.push(`${who} ${m.text()}`));
};
const SHOTS = process.env.SHOTS;
const save = async (p, name) => {
  if (!SHOTS) return;
  await p.waitForTimeout(900); // let the charts finish drawing in
  await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' });
};
const fail = async (p, e) => {
  await p.screenshot({ path: process.env.SHOT ?? '/tmp/work-mode-fail.png', fullPage: true }).catch(() => {});
  throw e;
};
const see = (p, text, timeout = 20000) => p.getByText(text).first().waitFor({ timeout }).catch((e) => fail(p, e));

async function signIn(b, email, opts = {}) {
  const ctx = await b.newContext({ viewport: opts.viewport ?? { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, acceptDownloads: true, ...(opts.geolocation ? { geolocation: opts.geolocation, permissions: ['geolocation'] } : {}) });
  const p = await ctx.newPage();
  watch(p, email);
  for (let attempt = 0; ; attempt++) {
    await p.goto(BASE + '/login');
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

async function apiAs(email) {
  const r = await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) })).json();
  if (r.status !== 'ok') throw new Error(`${email} API sign-in needs ${r.status}`);
  return async (method, url, body) => {
    const res = await fetch(`${API}${url}`, { method, headers: { authorization: `Bearer ${r.accessToken}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

/** Checks in from the attendance page and waits for the status card to show the day where it counts. */
async function checkIn(p, state) {
  await p.goto(BASE + '/attendance');
  const card = p.getByTestId('work-mode-status');
  await card.waitFor().catch((e) => fail(p, e));
  const button = card.getByTestId('wm-punch');
  if ((await button.innerText()).includes('Check out')) {
    // Already checked in today (a re-run): check out and in again.
    await button.click();
    await card.getByText(/Checked out/).first().waitFor({ timeout: 15000 }).catch((e) => fail(p, e));
  }
  await card.getByTestId('wm-punch').getByText('Check in').waitFor();
  await card.getByTestId('wm-punch').click();
  await p.locator(`[data-testid="work-mode-status"][data-state="${state}"]`).waitFor({ timeout: 20000 }).catch((e) => fail(p, e));
}

(async () => {
  const b = await chromium.launch();
  const owner = await apiAs('owner@demo.crew.local');
  const places = await owner('GET', '/attendance/work-mode/places');
  const pune = places.offices.find((o) => o.name === 'Pune Plant');
  if (!pune) throw new Error('demo Pune Plant office missing');
  const before = (await owner('GET', '/attendance/work-mode/settings')).settings;
  try {
    // 1. Super Workspace: office locations and names.
    const sp = await signIn(b, 'owner@demo.crew.local');
    await sp.goto(BASE + '/attendance/offices');
    await sp.getByTestId('geo-map').first().waitFor().catch((e) => fail(sp, e));
    await see(sp, 'Pune Plant');
    await save(sp, '04-office-locations');
    await sp.getByTestId(`office-${pune.id}`).getByRole('button', { name: /Edit area|Set location/ }).click();
    const dlg = sp.locator('dialog[open]');
    await dlg.getByTestId('place-radius').fill('250');
    await save(sp, '05-office-geofence-editor');
    await dlg.getByTestId('save-office').click();
    await sp.getByTestId(`office-${pune.id}`).getByText('250 m').waitFor({ timeout: 10000 }).catch((e) => fail(sp, e));
    ok('Super Workspace sees offices on the map and changes the Pune Plant area to 250 m');

    await sp.goto(BASE + '/attendance/work-mode/settings');
    await sp.getByTestId('label-hybrid').fill('Flexible Attendance');
    await save(sp, '07-rules-and-names');
    await sp.getByTestId('save-work-mode-settings').click();
    await see(sp, 'Saved. New and recalculated days use these rules.');
    ok('Super Workspace renames hybrid attendance to "Flexible Attendance"');

    // 2. Employees check in: at the plant, from home, and with the location refused.
    const arjun = await signIn(b, 'operator1@demo.crew.local', { geolocation: PUNE });
    await checkIn(arjun, 'office');
    await see(arjun, "You're Working From Office today");
    await save(arjun, '01-employee-working-from-office');
    ok('operator at the plant checks in: "You\'re Working From Office today"');

    const neha = await signIn(b, 'operator2@demo.crew.local', { geolocation: HOME, viewport: { width: 400, height: 860 } });
    await checkIn(neha, 'remote');
    await see(neha, "You're Working From Home today");
    await neha.getByTestId('wm-update-location').waitFor();
    await save(neha, '02-employee-working-from-home-phone');
    ok('operator at home checks in: "You\'re Working From Home today", with Update my location');

    const sunita = await signIn(b, 'supervisor@demo.crew.local'); // no location permission
    await checkIn(sunita, 'pending_verification');
    await see(sunita, 'Your location is waiting for verification');
    ok('a check-in with the location refused waits for verification and is never counted as home');

    // Month summary on the employee view (demo history has office, home and hybrid days).
    await neha.goto(BASE + '/attendance?period=month');
    await neha.getByTestId('month-work-mode').waitFor({ timeout: 15000 }).catch(() => {});

    // 3. Super Workspace: dashboard, people, register, verification and the report.
    await sp.goto(BASE + '/attendance/work-mode');
    await sp.getByTestId('workforce-cards').waitFor().catch((e) => fail(sp, e));
    await sp.getByTestId('mode-donut').waitFor();
    await sp.getByTestId('mode-trend').waitFor().catch((e) => fail(sp, e));
    const total = Number((await sp.getByTestId('card-all').locator('div').nth(1).innerText()).trim());
    if (!(total > 10)) throw new Error(`total employees card shows ${total}`);
    await save(sp, '03-workforce-dashboard');
    await sp.getByTestId('card-pending').click();
    await sp.getByTestId('workforce-people').getByText(/Sunita/).first().waitFor({ timeout: 15000 }).catch((e) => fail(sp, e));
    ok(`workforce dashboard counts ${total} people; the Pending verification card lists the supervisor`);

    await sp.goto(BASE + '/attendance/work-mode/register?modes=pending_verification');
    const row = sp.getByTestId('register-row').filter({ hasText: /Sunita/ }).first();
    await row.waitFor().catch((e) => fail(sp, e));
    await save(sp, '06-register');
    await row.getByTestId('verify-day').click();
    const v = sp.locator('dialog[open]');
    await v.getByTestId('verify-mode').selectOption('office');
    await v.getByTestId('verify-reason').fill('Seen at the plant by the plant head (e2e)');
    await v.getByTestId('verify-save').click();
    await sp.getByTestId('register-row').filter({ hasText: /Sunita/ }).first().waitFor({ state: 'detached', timeout: 15000 }).catch((e) => fail(sp, e));
    await sp.goto(BASE + '/attendance/work-mode/register');
    await sp.getByTestId('register-row').filter({ hasText: /Sunita/ }).first().getByText(/corrected/).waitFor({ timeout: 15000 }).catch((e) => fail(sp, e));
    ok('Super Workspace verifies the pending day as office with a reason; the register shows it corrected');

    await sp.getByTestId('report-export').click();
    const rd = sp.getByTestId('report-dialog');
    await rd.waitFor();
    await save(sp, '08-export-report');
    const [d] = await Promise.all([sp.waitForEvent('download', { timeout: 30000 }), rd.getByTestId('report-download').click()]);
    const file = path.join(os.tmpdir(), `wm-${Date.now()}-${d.suggestedFilename()}`);
    await d.saveAs(file);
    const zip = unzipSync(new Uint8Array(fs.readFileSync(file)));
    const book = strFromU8(zip['xl/workbook.xml']);
    for (const name of ['Attendance Summary', 'Detailed Register', 'Employee Summary']) if (!book.includes(name)) throw new Error(`report has no "${name}" sheet`);
    const sheet2 = strFromU8(zip['xl/worksheets/sheet2.xml']);
    if (!/<pane [^>]*state="frozen"/.test(sheet2) || !/<autoFilter /.test(sheet2)) throw new Error('register sheet has no frozen header or filter');
    ok(`report ${d.suggestedFilename()} has the summary, register and employee sheets, frozen headers and filters`);

    // 4. HR Workspace sees the dashboard; Employee Workspace does not.
    const hr = await signIn(b, 'hr.admin@demo.crew.local');
    await hr.goto(BASE + '/attendance/work-mode');
    await hr.getByTestId('workforce-cards').waitFor().catch((e) => fail(hr, e));
    ok('HR Workspace opens the workforce dashboard');
    await arjun.goto(BASE + '/attendance/work-mode');
    await arjun.waitForURL((u) => u.pathname === '/attendance', { timeout: 15000 }).catch((e) => fail(arjun, e));
    ok('Employee Workspace is sent back to its own attendance');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
  } finally {
    // 5. Clean up.
    const { updatedAt: _u, classifyFrom: _c, ...rest } = before;
    await owner('PUT', '/attendance/work-mode/settings', rest).catch(() => {});
    await owner('PUT', `/attendance/work-mode/offices/${pune.id}`, { latitude: pune.latitude, longitude: pune.longitude, radiusM: pune.radiusM, active: true }).catch(() => {});
    await b.close();
  }
  ok('work-mode flow passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
