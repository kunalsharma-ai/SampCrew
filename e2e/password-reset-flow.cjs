/**
 * Forgot password at every level, end to end in Chromium against the real API, Web Portal, Console and the phone
 * app's browser build.
 *
 *   pnpm db:reset
 *   node apps/api/dist/main.js &  pnpm --filter @crew/web start &  pnpm --filter @crew/console start &
 *   pnpm --filter @crew/mobile export:web      # optional: the phone part runs when apps/mobile/dist-web exists
 *   node e2e/password-reset-flow.cjs
 *
 * 1. Web Portal (an Employee Workspace person): "Forgot password?" on sign-in, the emailed link opens the reset page,
 *    the new password works, the old one and the old session do not, and the link cannot be used twice.
 * 2. Phone app: "Forgot password?", the 6-digit code from the email and a new password, then sign-in with it.
 * 3. Super Workspace: Administration > Password resets lists both, as they happen, with level and status.
 * 4. Console: a Console Admin resets their own password from the Console sign-in page, signs in with it (two-step
 *    verification is still asked), and Console > Password resets shows every level.
 *
 * The emails are read from the database queue (no mail server in CI). Uses its own new people and Console admin, so it
 * leaves the demo accounts alone. Fails on any browser error.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
require('./delete-password.cjs');
const { authenticator } = require('otplib');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const API = (process.env.CREW_API_URL ?? 'http://localhost:4000') + '/api/v1';
const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const PORT = Number(process.env.MOBILE_PORT ?? 8081);
const DIST = path.join(__dirname, '..', 'apps', 'mobile', 'dist-web');
const SHOTS = process.env.SHOTS_DIR;
const stamp = Date.now().toString(36);
const NEW_PASSWORD = 'Fresh-Start-Pass-29!';

const ok = (m) => console.log(`  ok  ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(`${who} ${m.text()}`);
  });
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
};
const shot = async (p, name) => {
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};

async function api(token, method, p, body, headers = {}) {
  const res = await fetch(API + p, { method, headers: { 'content-type': 'application/json', ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** A new Employee Workspace person in the demo workspace, invited by the owner, who has accepted with a password. */
async function newPerson(ownerToken, name) {
  const email = `reset.${name.toLowerCase().replace(/\W+/g, '')}.${stamp}@demo.crew.local`;
  const invited = await api(ownerToken, 'POST', '/members/invite', { email, fullName: name });
  const token = new URL(invited.inviteUrl).searchParams.get('token');
  await api(null, 'POST', '/auth/invitations/accept', { token, fullName: name, password: PASSWORD });
  return email;
}

/** The newest reset email to an address in the outgoing queue, with its link token and 6-digit code. */
async function resetEmail(db, email, after) {
  for (let i = 0; i < 40; i++) {
    const m = await db.collection('email_messages').findOne({ to_email: email.toLowerCase(), template: 'password_reset', created_at: { $gt: after } }, { sort: { created_at: -1 } });
    if (m) return { link: /(https?:\/\/\S+\/reset-password\?token=[\w-]+)/.exec(m.text_body)[1], code: /: (\d{6})\s*$/m.exec(m.text_body)[1] };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no reset email reached the queue for ${email}`);
}

function serveMobile() {
  if (process.env.MOBILE_URL) return Promise.resolve(null);
  if (!fs.existsSync(path.join(DIST, 'index.html'))) return Promise.resolve(undefined);
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

(async () => {
  const browser = await chromium.launch();
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const db = mongo.db();
  const server = await serveMobile();
  try {
    const owner = await api(null, 'POST', '/auth/login', { email: 'owner@demo.crew.local', password: PASSWORD });
    if (owner.status !== 'ok') throw new Error(`the demo owner needs ${owner.status}; run on a fresh database (pnpm db:reset)`);

    // 1. Web Portal, with the emailed link.
    const webEmail = await newPerson(owner.accessToken, 'Riya Web');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    watch(page, 'web');
    await page.goto(`${WEB}/login`);
    await page.fill('input[name=email]', webEmail);
    await page.fill('input[name=password]', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => u.pathname !== '/login');
    const oldCookies = await ctx.cookies();
    ok('Employee Workspace person signed in with their password');

    const web = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const p = await web.newPage();
    watch(p, 'web-reset');
    await p.goto(`${WEB}/login`);
    await shot(p, '01-web-login-forgot-link');
    await p.getByTestId('forgot-password-link').click();
    await p.waitForURL(/\/forgot-password$/);
    let since = new Date();
    await p.fill('input[name=email]', webEmail);
    await shot(p, '02-web-forgot-password');
    await p.getByRole('button', { name: 'Send reset link' }).click();
    await p.getByTestId('forgot-sent').waitFor();
    await shot(p, '03-web-check-your-email');
    const webMail = await resetEmail(db, webEmail, since);
    assert(webMail.link.startsWith(`${WEB}/reset-password?token=`), `link points at the Web Portal: ${webMail.link}`);
    ok('"Forgot password?" on the Web Portal sign-in emails a link and a code');

    // The same answer for an address with no account.
    await p.goto(`${WEB}/forgot-password`);
    await p.fill('input[name=email]', `nobody.${stamp}@nowhere.example`);
    await p.getByRole('button', { name: 'Send reset link' }).click();
    await p.getByTestId('forgot-sent').waitFor();
    ok('an unknown email gets the same answer (no account leak)');

    await p.goto(webMail.link);
    await p.getByTestId('reset-form').waitFor();
    await p.fill('input[name=newPassword]', NEW_PASSWORD);
    await p.fill('input[name=confirmPassword]', 'Not-The-Same-Pass-1!');
    await p.getByRole('button', { name: 'Save new password' }).click();
    await p.getByText('The two passwords do not match', { exact: true }).waitFor();
    await p.fill('input[name=confirmPassword]', NEW_PASSWORD);
    await shot(p, '04-web-choose-new-password');
    await p.getByRole('button', { name: 'Save new password' }).click();
    await p.getByTestId('reset-done').waitFor();
    await shot(p, '05-web-password-changed');
    ok('the emailed link opens the reset page and saves the new password');

    await p.goto(webMail.link);
    await p.getByTestId('reset-invalid').waitFor();
    ok('the link cannot be used twice');

    // The session from before the reset is over.
    const fresh = await browser.newContext();
    await fresh.addCookies(oldCookies);
    const stale = await fresh.newPage();
    await stale.goto(`${WEB}/`);
    await stale.waitForURL((u) => u.pathname === '/login');
    await fresh.close();
    ok('the session opened before the reset was signed out');

    await p.goto(`${WEB}/login`);
    await p.fill('input[name=email]', webEmail);
    await p.fill('input[name=password]', PASSWORD);
    await p.click('button[type=submit]');
    await p.getByText('Email or password is incorrect').waitFor();
    await p.fill('input[name=password]', NEW_PASSWORD);
    await p.click('button[type=submit]');
    await p.waitForURL((u) => u.pathname !== '/login');
    ok('the old password is refused and the new one signs in');
    await ctx.close();
    await web.close();

    // 2. Phone app, with the 6-digit code.
    let phoneEmail = null;
    if (server !== undefined) {
      phoneEmail = await newPerson(owner.accessToken, 'Arjun Phone');
      const APP = process.env.MOBILE_URL ?? `http://localhost:${PORT}`;
      const pc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const m = await pc.newPage();
      watch(m, 'phone');
      await m.goto(`${APP}/login`);
      await m.getByTestId('forgot-start').click();
      await m.getByTestId('forgot-email').fill(phoneEmail);
      await shot(m, '06-phone-forgot-password');
      since = new Date();
      await m.getByTestId('forgot-send').click();
      await m.getByTestId('forgot-code').waitFor();
      const mail = await resetEmail(db, phoneEmail, since);
      await m.getByTestId('forgot-code').fill(mail.code);
      await m.getByTestId('forgot-new-password').fill(NEW_PASSWORD);
      await m.getByTestId('forgot-confirm-password').fill(NEW_PASSWORD);
      await shot(m, '07-phone-enter-code');
      await m.getByTestId('forgot-save').click();
      // "login-info" already shows the "code sent" note, so wait for the code form to close instead.
      await m.getByTestId('forgot-save').waitFor({ state: 'detached', timeout: 20000 });
      await m.getByTestId('login-info').waitFor();
      await shot(m, '08-phone-password-changed');
      await m.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
      await m.getByRole('button', { name: 'Sign in', exact: true }).click();
      await m.waitForURL((u) => u.pathname !== '/login', { timeout: 20000 });
      const row = await db.collection('password_resets').findOne({ email: phoneEmail, status: 'completed' });
      assert(row && row.client === 'mobile', 'the phone reset is recorded as from the phone app');
      ok('phone app: "Forgot password?", the 6-digit code and a new password, then signed in with it');
      await pc.close();
    } else {
      console.log('  --  phone app part skipped: build it with pnpm --filter @crew/mobile export:web');
    }

    // 3. Super Workspace sees its people's resets.
    const sw = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const s = await sw.newPage();
    watch(s, 'super');
    await s.goto(`${WEB}/login`);
    await s.fill('input[name=email]', 'owner@demo.crew.local');
    await s.fill('input[name=password]', PASSWORD);
    await s.click('button[type=submit]');
    await s.waitForURL((u) => u.pathname !== '/login');
    await s.goto(`${WEB}/settings/password-resets`);
    await s.getByTestId('password-resets').waitFor();
    const rows = s.getByTestId('password-reset-row');
    await rows.filter({ hasText: webEmail }).filter({ hasText: 'Password changed' }).waitFor();
    if (phoneEmail) await rows.filter({ hasText: phoneEmail }).filter({ hasText: 'Phone app' }).waitFor();
    assert(!(await s.getByText(`nobody.${stamp}@nowhere.example`).count()), 'a workspace never sees unknown addresses');
    await shot(s, '09-super-workspace-password-resets');
    const navLink = await s.locator('a[href="/settings/password-resets"]').count();
    assert(navLink > 0, 'Password resets is in the Super Workspace menu');
    ok('Super Workspace > Password resets lists its people\'s resets with level and status');
    await sw.close();

    // 4. Console Admin.
    const adminEmail = `reset.console.${stamp}@sampledge.test`;
    const now = new Date();
    await db.collection('platform_admins').insertOne({ _id: randomUUID(), email: adminEmail, full_name: 'Reset Console Admin', password_hash: 'forgotten', role: 'support', status: 'active', mfa_enabled: false, mfa_secret_enc: null, must_change_password: false, failed_login_count: 0, locked_until: null, last_login_at: null, created_at: now, updated_at: now });
    const cc = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const c = await cc.newPage();
    watch(c, 'console');
    await c.goto(`${CONSOLE}/login`);
    await c.getByTestId('forgot-password-link').click();
    await c.waitForURL(/\/forgot-password$/);
    since = new Date();
    await c.fill('input[name=email]', adminEmail);
    await shot(c, '10-console-forgot-password');
    await c.getByRole('button', { name: 'Send reset link' }).click();
    await c.getByTestId('forgot-sent').waitFor();
    const cMail = await resetEmail(db, adminEmail, since);
    assert(cMail.link.startsWith(`${CONSOLE}/reset-password?token=`), `Console link points at the Console: ${cMail.link}`);
    await c.goto(cMail.link);
    await c.fill('input[name=newPassword]', NEW_PASSWORD);
    await c.fill('input[name=confirmPassword]', NEW_PASSWORD);
    await c.getByRole('button', { name: 'Save new password' }).click();
    await c.getByTestId('reset-done').waitFor();
    await c.getByTestId('reset-sign-in').click();
    await c.waitForURL(/\/login/);
    await c.fill('input[name=email]', adminEmail);
    await c.fill('input[name=password]', NEW_PASSWORD);
    await c.click('button[type=submit]');
    await c.waitForURL(/\/enrol$/);
    await c.click('text=Show QR code');
    const secret = (await c.locator('code').first().textContent()).trim();
    await c.fill('input[name=code]', authenticator.generate(secret));
    await c.click('text=Turn on and continue');
    await c.waitForURL(`${CONSOLE}/`);
    ok('Console Admin reset their password from the Console sign-in page and signed in (two-step verification still asked)');

    await c.goto(`${CONSOLE}/password-resets`);
    await c.getByTestId('password-resets').waitFor();
    const crow = c.getByTestId('password-reset-row');
    await crow.filter({ hasText: adminEmail }).filter({ hasText: 'Console Admin' }).filter({ hasText: 'Password changed' }).waitFor();
    await crow.filter({ hasText: webEmail }).filter({ hasText: 'Employee Workspace' }).waitFor();
    await crow.filter({ hasText: `nobody.${stamp}@nowhere.example` }).filter({ hasText: 'No account with this email' }).waitFor();
    await shot(c, '11-console-password-resets');
    await c.goto(`${CONSOLE}/password-resets?level=console`);
    await crow.filter({ hasText: adminEmail }).waitFor();
    assert(!(await crow.filter({ hasText: webEmail }).count()), 'the level filter keeps only Console Admins');
    ok('Console > Password resets shows every level, with filters');
    await cc.close();

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('password reset flow passed');
  } finally {
    await browser.close();
    await mongo.close();
    if (server) server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
