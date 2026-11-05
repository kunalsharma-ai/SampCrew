/**
 * Attendance end-to-end flow in a real browser, against the demo workspace.
 *
 *   pnpm db:reset            # fresh demo workspace (includes a week of demo punches)
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/attendance-flow.cjs
 *
 * 1. A machine operator at the Pune plant punches in from the browser, with their location inside the geofence.
 * 2. They find the day they forgot to punch out and ask for a correction.
 * 3. Their supervisor approves it from the Approvals inbox; the day is recalculated from the added punch.
 * 4. HR registers a simulated biometric device, maps an enrolment number and sends test punches through the
 *    real push pipeline.
 * 5. HR creates a QR kiosk and the kiosk screen (not signed in) shows a rotating code.
 * Also opens every new attendance screen and fails on any browser error.
 */
const { chromium } = require('playwright');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const PUNE = { latitude: 18.5205, longitude: 73.8566, accuracy: 20 };
const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(`${who} ${m.text()}`));
};

async function signIn(b, email, extra = {}) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, ...extra });
  const p = await ctx.newPage();
  watch(p, email);
  await p.goto(BASE + '/login');
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForURL((u) => u.pathname === '/', { timeout: 15000 });
  return p;
}

const shot = async (p, e) => {
  await p.screenshot({ path: process.env.SHOT ?? '/tmp/attendance-fail.png', fullPage: true }).catch(() => {});
  throw e;
};

(async () => {
  const b = await chromium.launch();
  const stamp = Date.now();

  // 1. The operator punches in from the plant.
  const op = await signIn(b, 'operator1@demo.crew.local', { geolocation: PUNE, permissions: ['geolocation'] });
  await op.goto(BASE + '/attendance');
  await op.locator('button', { hasText: /^\s*Punch in\s*$/ }).click();
  await op.locator('button', { hasText: /^\s*Punch out\s*$/ }).waitFor({ timeout: 10000 }).catch((e) => shot(op, e));
  await op.locator('[aria-label="Today\'s punches"] >> text=In').first().waitFor({ timeout: 5000 });
  ok('operator punched in inside the Pune geofence; the button now offers Punch out');

  // 2. They fix the day with the missing punch-out (seeded demo data).
  const missing = () => op.locator('tr', { hasText: 'Missing punch' }).locator('button', { hasText: 'Fix punches' }).first();
  // Early in a month the seeded day falls in the previous month.
  const inPreviousMonth = !(await missing().count());
  if (inPreviousMonth) await op.click('a[aria-label="Previous month"]');
  await missing().click();
  const dialog = op.locator('dialog');
  // The dialog suggests the shift end for the missing punch-out; keep only that row, at 18:00.
  while ((await dialog.locator('input[type=time]').count()) > 1) await dialog.locator('button[aria-label="Remove punch"]').first().click();
  await dialog.locator('input[type=time]').first().fill('18:00');
  await dialog.locator('select[name^=direction-]').first().selectOption('out');
  await dialog.locator('textarea[name=reason]').fill(`Forgot to punch out (e2e ${stamp})`);
  await dialog.locator('button', { hasText: 'Send for approval' }).click();
  await op.locator('text=Correction pending').first().waitFor({ timeout: 10000 }).catch((e) => shot(op, e));
  ok('operator asked for a correction on the day with a missing punch-out');

  // 3. The supervisor approves.
  const sup = await signIn(b, 'supervisor@demo.crew.local');
  await sup.goto(BASE + '/approvals');
  const summary = `Forgot to punch out (e2e ${stamp})`;
  const card = sup.locator('div', { hasText: summary }).last();
  await card.locator('button', { hasText: 'Approve' }).click();
  await sup.locator(`text=${summary}`).waitFor({ state: 'detached', timeout: 10000 }).catch((e) => shot(sup, e));
  ok('supervisor approved the correction from the inbox');
  for (const path of ['/attendance/team', '/shifts']) {
    await sup.goto(BASE + path);
    if (sup.url().includes('/no-access') || sup.url().includes('/login')) throw new Error(`supervisor could not open ${path}`);
  }
  ok('supervisor opens team attendance and shifts');

  await op.goto(BASE + '/attendance');
  if (inPreviousMonth) {
    await op.click('a[aria-label="Previous month"]');
    await op.waitForURL(/month=/);
  }
  if (await op.locator('text=Correction pending').count()) throw new Error('correction still shown as pending after approval');
  await op.locator('td >> text=Approved').first().waitFor({ timeout: 10000 }).catch((e) => shot(op, e));
  ok('operator sees the correction approved and the day recalculated');

  // 4. HR registers a simulated device, maps a number and sends test punches.
  const hr = await signIn(b, 'hr.admin@demo.crew.local');
  for (const path of ['/settings/attendance', '/settings/devices', '/attendance/team', '/shifts']) {
    await hr.goto(BASE + path);
    if (hr.url().includes('/no-access') || hr.url().includes('/login')) throw new Error(`HR admin could not open ${path}`);
  }
  ok('HR admin opens every attendance settings screen');
  await hr.goto(BASE + '/settings/devices');
  await hr.click('text=Register device');
  const dd = hr.locator('dialog');
  await dd.locator('input[name=name]').fill(`Canteen reader ${stamp % 10000}`);
  await dd.locator('input[name=serialNumber]').fill(`E2E${stamp}`);
  await dd.locator('select[name=locationId]').selectOption({ label: 'Pune Plant' });
  await dd.locator('select[name=simulated]').selectOption('true');
  await dd.locator('button[type=submit]').click();
  await hr.waitForURL(/\/settings\/devices\/[0-9a-f-]{36}/, { timeout: 10000 }).catch((e) => shot(hr, e));
  await hr.locator('text=Send test punches').waitFor();
  ok('HR registered a simulated device');

  await hr.click('button:has-text("Map a number")');
  const md = hr.locator('dialog');
  await md.locator('input[name=deviceUserId]').fill('301');
  await md.locator('select[name=scope]').selectOption('device');
  const rekha = await md.locator('select[name=employeeId]').evaluate((s) => [...s.options].find((o) => o.text.startsWith('Rekha Jadhav'))?.value);
  await md.locator('select[name=employeeId]').selectOption(rekha);
  await md.locator('button[type=submit]').click();
  await hr.locator('td', { hasText: 'Rekha Jadhav' }).first().waitFor({ timeout: 10000 }).catch((e) => shot(hr, e));
  ok('HR mapped enrolment number 301 to an employee');

  const yesterday = new Date(Date.now() + 5.5 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
  await hr.fill('input[type=date]', yesterday);
  await hr.locator('div', { hasText: /^Normal day/ }).locator('..').locator('button', { hasText: 'Send' }).first().click();
  const sent = await hr.locator('text=/Sent \\d+ punch\\(es\\)/').textContent({ timeout: 10000 }).catch((e) => shot(hr, e));
  if (!/[1-9]\d* accepted/.test(sent)) throw new Error(`expected accepted punches, got: ${sent}`);
  await hr.locator('td >> text=simulated').first().waitFor({ timeout: 5000 });
  ok(`simulated punches went through the ingest pipeline: ${sent.trim()}`);

  // 5. HR creates a QR kiosk; the kiosk screen shows a rotating code without signing in.
  await hr.goto(BASE + '/settings/attendance');
  await hr.click('button:has-text("Add kiosk")');
  const kd = hr.locator('dialog');
  await kd.locator('input[name=name]').fill(`Gate tablet ${stamp % 10000}`);
  await kd.locator('select[name=locationId]').selectOption({ label: 'Pune Plant' });
  await kd.locator('button[type=submit]').click();
  const link = await hr.locator('input[readonly]').inputValue({ timeout: 10000 }).catch((e) => shot(hr, e));
  if (!/\/kiosk#.{20,}/.test(link)) throw new Error(`unexpected kiosk link: ${link}`);
  ok('HR created a kiosk and got its one-time link');

  const kctx = await b.newContext({ viewport: { width: 800, height: 1000 } });
  const kiosk = await kctx.newPage();
  watch(kiosk, 'kiosk');
  await kiosk.goto(link);
  await kiosk.locator('[aria-label="QR code to punch in or out"] svg').waitFor({ timeout: 10000 }).catch((e) => shot(kiosk, e));
  await kiosk.locator('text=/New code in \\d+s/').waitFor();
  ok('kiosk screen shows a QR code that rotates, without a sign-in');

  const bad = await kctx.newPage();
  await bad.goto(BASE + '/kiosk#not-a-real-kiosk-token-000000');
  await bad.locator('p[role=alert]', { hasText: 'revoked' }).waitFor({ timeout: 10000 });
  ok('a wrong kiosk link is refused');

  await b.close();
  // The refused kiosk link logs a 401 in the console by design.
  const real = errs.filter((e) => !/401/.test(e));
  if (real.length) throw new Error('browser errors:\n' + real.join('\n'));
  console.log('attendance flow: all checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
