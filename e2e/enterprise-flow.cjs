/**
 * Enterprise end-to-end flow in the Web Portal: single sign-on, SCIM provisioning and privacy requests, against the
 * demo workspace. The flow runs its own OIDC TEST STUB on 4030 (e2e/oidc-stub.cjs), which stands in for an identity
 * provider such as Microsoft Entra ID or Okta; no real provider is called. The API must be started with private
 * addresses allowed, because the stub's issuer is http://127.0.0.1:4030:
 *
 *   pnpm db:reset                          # fresh demo workspace and bootstrap console admin, nobody has MFA yet
 *   INTEGRATIONS_ALLOW_PRIVATE_URLS=true node apps/api/dist/main.js &
 *   pnpm --filter @crew/web start &
 *   node e2e/enterprise-flow.cjs
 *
 * 1. SAMPLEDGE moves the demo workspace to the Enterprise plan through the console API (Enterprise is quote-only).
 * 2. The owner enrols two-step verification and connects the provider in Settings. Switching on is refused until a
 *    test sign-in passes; the test goes to the provider and back, then single sign-on is switched on.
 * 3. HR signs in with single sign-on from the sign-in page. A tampered ID token (wrong nonce) is refused with the
 *    reason, and someone new to SampCrew gets an account on first sign-in.
 * 4. The owner requires single sign-on: a member's password sign-in is turned into the single sign-on step, and
 *    the member's open session ends.
 * 5. The owner creates a SCIM token; the "provider" creates a person, finds them, deactivates them, and every call
 *    shows in the provisioning log.
 * 6. HR (signed in through the provider, which reported MFA) logs an access request, prepares the export and
 *    downloads it; the file holds the person's records without secrets. An erasure request for someone still
 *    employed is refused and rejected with a reason.
 * Fails on any browser error.
 */
const { readFileSync } = require('node:fs');
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const stub = require('./oidc-stub.cjs');

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const API = (process.env.CREW_API_URL ?? 'http://localhost:4000') + '/api/v1';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
const ADMIN_EMAIL = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
if (!PASSWORD || !ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD, CREW_BOOTSTRAP_ADMIN_EMAIL and CREW_BOOTSTRAP_ADMIN_PASSWORD (source .env)');
const CLIENT_ID = 'crew-e2e';
const CLIENT_SECRET = `e2e-${Date.now()}-not-a-real-secret`;

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/status of 40[0-9]/.test(m.text()) && errs.push(`${who} ${m.text()}`));
  p.on('dialog', (d) => d.accept());
};
const expect = (cond, msg) => {
  if (!cond) throw new Error(`expected: ${msg}`);
};

async function api(token, method, path, body, contentType = 'application/json') {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: { 'content-type': contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) },
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

async function page(b, who) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  watch(p, who);
  return p;
}

async function passwordSignIn(p, email) {
  for (let attempt = 0; ; attempt++) {
    await p.goto(BASE + '/login');
    await p.fill('input[name=email]', email);
    await p.fill('input[name=password]', PASSWORD);
    await p.click('button[type=submit]');
    const r = await Promise.race([
      p.waitForURL((u) => u.pathname === '/', { timeout: 15000 }).then(() => 'in'),
      p.locator('text=Too many requests').waitFor({ timeout: 15000 }).then(() => 'limited'),
    ]);
    if (r === 'in') return;
    if (attempt >= 4) throw new Error(`sign-in for ${email} stayed rate limited`);
    await p.waitForTimeout(20000);
  }
}

/** Starts single sign-on from the sign-in page; the stub signs in whoever was set with /__user. */
async function ssoSignIn(p, email) {
  await p.goto(BASE + '/login');
  await p.click('text=Sign in with single sign-on');
  await p.fill('input[name=email]', email);
  await p.click('button:has-text("Continue")');
}

async function enrolMfa(p) {
  await p.goto(BASE + '/settings/security');
  await p.click('text=Set up two-step verification');
  const secret = (await p.locator('code').first().textContent()).trim();
  await p.fill('input[name=code]', authenticator.generate(secret));
  await p.click('text=Turn on');
  await p.waitForSelector('text=/two-step verification is on/i', { timeout: 8000 });
}

const setUser = (idp, user) => fetch(`${idp.issuer}/__user`, { method: 'POST', body: JSON.stringify(user) });
const tamper = (idp, t) => fetch(`${idp.issuer}/__tamper`, { method: 'POST', body: JSON.stringify({ tamper: t }) });

(async () => {
  const idp = await stub.start({ port: 4030, host: '127.0.0.1', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const b = await chromium.launch();
  let current;
  try {
    // 1. Enterprise plan, set by SAMPLEDGE staff in the console (the console admin must enrol MFA first).
    const login = await api(null, 'POST', '/platform/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(login.body?.status === 'ok', `console admin signs in (${login.status} ${JSON.stringify(login.body)})`);
    const setup = await api(login.body.accessToken, 'POST', '/platform/auth/mfa/setup');
    const enabled = await api(login.body.accessToken, 'POST', '/platform/auth/mfa/enable', { code: authenticator.generate(setup.body.secret) });
    const staff = enabled.body.accessToken;
    const tenants = await api(staff, 'GET', '/platform/tenants');
    const demo = (Array.isArray(tenants.body) ? tenants.body : tenants.body.items).find((t) => t.slug === 'demo-northwind');
    const plan = await api(staff, 'PUT', `/platform/tenants/${demo.id}/subscription`, { planKey: 'enterprise' });
    expect(plan.status === 200, `plan change (${plan.status} ${JSON.stringify(plan.body)})`);
    ok('demo workspace moved to the Enterprise plan through the console API');

    // 2. The owner connects the provider.
    const owner = await page(b, 'owner');
    current = owner;
    await passwordSignIn(owner, 'owner@demo.crew.local');
    await enrolMfa(owner);
    await owner.goto(BASE + '/settings/single-sign-on');
    const redirectUri = (await owner.locator('[data-testid=redirect-uri]').textContent()).trim();
    expect(redirectUri === `${BASE}/sso/callback`, `redirect URI shown (${redirectUri})`);
    await owner.fill('input[name=issuer]', idp.issuer);
    await owner.fill('input[name=clientId]', CLIENT_ID);
    await owner.fill('input[name=clientSecret]', CLIENT_SECRET);
    await owner.fill('input[name=domains]', 'demo.crew.local');
    await owner.click('text=Create accounts on first sign-in');
    await owner.click('text=Save and check provider');
    await owner.waitForSelector('text=SampCrew reached the provider', { timeout: 15000 });
    expect(await owner.locator('[data-testid=sso-verified]').textContent() === 'Not tested yet', 'connection starts untested');
    expect(await owner.locator('button:has-text("Switch on")').isDisabled(), 'switching on is refused before a test');
    ok('owner connected the provider; switching on waits for a test sign-in');

    await setUser(idp, { email: 'owner@demo.crew.local', name: 'Aarav Mehta', amr: ['pwd', 'mfa'], emailVerified: true });
    await owner.click('text=Test sign-in');
    await owner.waitForURL((u) => u.pathname === '/settings/single-sign-on' && u.searchParams.get('tested') === '1', { timeout: 20000 });
    await owner.waitForSelector('text=Test sign-in passed');
    expect((await owner.locator('[data-testid=sso-verified]').textContent()).includes('owner@demo.crew.local'), 'test recorded with the email');
    const auth = (await (await fetch(`${idp.issuer}/__requests`)).json()).authorize.at(-1);
    expect(auth.code_challenge_method === 'S256' && auth.redirect_uri === redirectUri, 'test used PKCE and the registered redirect URI');
    await owner.click('button:has-text("Switch on")');
    await owner.waitForSelector('text=Single sign-on switched on');
    ok('test sign-in went to the provider and back, then single sign-on was switched on');

    // 3. HR signs in through the provider. First a tampered token, then the real thing.
    const hr = await page(b, 'hr');
    current = hr;
    await setUser(idp, { email: 'hr.admin@demo.crew.local', name: 'Priya Nair', amr: ['pwd', 'mfa'], emailVerified: true });
    await tamper(idp, 'wrong_nonce');
    await ssoSignIn(hr, 'hr.admin@demo.crew.local');
    await hr.waitForURL((u) => u.pathname === '/login' && u.searchParams.get('sso_error') === '1', { timeout: 20000 });
    await hr.waitForSelector('text=/different sign-in \\(nonce\\)/');
    ok('a tampered ID token (wrong nonce) is refused and the reason shown');
    await tamper(idp, null);
    await ssoSignIn(hr, 'hr.admin@demo.crew.local');
    await hr.waitForURL((u) => u.pathname === '/', { timeout: 20000 });
    await hr.waitForSelector('text=Priya');
    const last = (await (await fetch(`${idp.issuer}/__requests`)).json()).authorize.at(-1);
    expect(last.login_hint === 'hr.admin@demo.crew.local', 'the email is passed to the provider as a hint');
    ok('HR signed in with single sign-on from the sign-in page');

    const joiner = await page(b, 'joiner');
    current = joiner;
    await setUser(idp, { email: 'new.joiner@demo.crew.local', name: 'Nisha Joiner', amr: ['pwd'], emailVerified: true });
    await ssoSignIn(joiner, 'new.joiner@demo.crew.local');
    await joiner.waitForURL((u) => u.pathname === '/', { timeout: 20000 });
    await joiner.waitForSelector('text=Nisha');
    ok('someone new got an account on first sign-in (Employee role)');

    // 4. Require it. A member's password sign-in becomes the single sign-on step, and the joiner is signed out.
    current = owner;
    await owner.click('button:has-text("Require for everyone")');
    await owner.waitForSelector('text=Single sign-on is now required');
    const sup = await page(b, 'supervisor');
    current = sup;
    await sup.goto(BASE + '/login');
    await sup.fill('input[name=email]', 'supervisor@demo.crew.local');
    await sup.fill('input[name=password]', PASSWORD);
    await sup.click('button[type=submit]');
    await sup.waitForSelector('text=Your organisation signs in with single sign-on');
    expect((await sup.locator('input[name=email]').inputValue()) === 'supervisor@demo.crew.local', 'email carried over to the single sign-on step');
    current = joiner;
    await joiner.goto(BASE + '/leave');
    await joiner.waitForURL((u) => u.pathname === '/login', { timeout: 15000 });
    ok('with single sign-on required, password sign-in is refused for members and their open sessions ended');

    // 5. SCIM provisioning.
    current = owner;
    await owner.goto(BASE + '/settings/single-sign-on');
    await owner.click('button:has-text("Create token")');
    const token = (await owner.locator('[data-testid=secret-value]').textContent()).trim();
    const base = (await owner.locator('[data-testid=scim-base-url]').textContent()).trim();
    expect(base === `${API}/scim/v2`, `SCIM base URL shown (${base})`);
    const scim = (method, path, body) =>
      fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    const created = await scim('POST', '/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'scim.person@demo.crew.local', externalId: 'idp-123',
      name: { givenName: 'Sam', familyName: 'Provisioned' }, emails: [{ value: 'scim.person@demo.crew.local', primary: true }], active: true,
    });
    expect(created.status === 201, `SCIM create (${created.status} ${JSON.stringify(created.body)})`);
    const found = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "scim.person@demo.crew.local"')}`);
    expect(found.body.totalResults === 1, 'SCIM filter finds the person');
    const off = await scim('PATCH', `/Users/${created.body.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] });
    expect(off.status === 200 && off.body.active === false, 'SCIM deactivation');
    expect((await fetch(base + '/Users', { headers: { authorization: 'Bearer crew_scim_wrong_token' } })).status === 401, 'a wrong token is refused');
    await owner.click('text=I have stored it');
    await owner.reload();
    expect((await owner.locator('text=POST /Users').count()) >= 1 && (await owner.locator('text=PATCH /Users').count()) >= 1, 'calls in the provisioning log');
    expect(await owner.locator('[data-testid=scim-token]').count() === 1, 'token shown by prefix only');
    ok('SCIM token created once; the provider created, found and deactivated a person, all in the log');

    // 6. Privacy requests, by HR (signed out by the enforcement, so back in through the provider).
    current = hr;
    await setUser(idp, { email: 'hr.admin@demo.crew.local', name: 'Priya Nair', amr: ['pwd', 'mfa'], emailVerified: true });
    await ssoSignIn(hr, 'hr.admin@demo.crew.local');
    await hr.waitForURL((u) => u.pathname === '/', { timeout: 20000 });
    await hr.goto(BASE + '/privacy');
    const logRequest = async (name, kind, source) => {
      await hr.click('text=Log a request');
      const value = await hr.locator('select[name=employeeId] option', { hasText: name }).first().getAttribute('value');
      await hr.selectOption('select[name=employeeId]', value);
      await hr.selectOption('select[name=kind]', kind);
      await hr.fill('input[name=source]', source);
      await hr.click('button:has-text("Log request")');
      await hr.waitForURL(/\/privacy\/[0-9a-f-]{36}$/, { timeout: 15000 });
    };
    await logRequest('Neha Deshmukh', 'access', 'Email to HR, identity checked in person');
    await hr.fill('input[name=note]', 'Sent through the secure file share');
    await hr.click('text=Prepare export and complete');
    await hr.waitForSelector('[data-testid=download-export]');
    const [download] = await Promise.all([hr.waitForEvent('download'), hr.click('[data-testid=download-export]')]);
    const file = JSON.parse(readFileSync(await download.path(), 'utf8'));
    const text = JSON.stringify(file);
    expect(text.includes('Neha') && text.includes('Deshmukh'), 'export holds the person');
    expect(!/_enc"|_hash"|password/i.test(text), 'export holds no secrets');
    expect(await hr.locator('[data-testid=export-summary]').count() === 1, 'summary of exported records shown');
    ok('HR logged an access request, prepared the export and downloaded it, with no secrets inside');

    await hr.goto(BASE + '/privacy');
    await logRequest('Arjun Kulkarni', 'erasure', 'Letter received at the plant office');
    await hr.waitForSelector('text=has not left yet, so they cannot be erased');
    expect(await hr.locator('button:has-text("Erase their data")').count() === 0, 'no erase button for someone still employed');
    await hr.fill('input[name=reason]', 'Still employed; told them it can be done after they leave');
    await hr.click('button:has-text("Reject request")');
    await hr.waitForSelector('text=Request closed as rejected');
    ok('an erasure request for someone still employed is refused and closed with a reason');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('enterprise flow passed');
  } catch (e) {
    if (current) await current.screenshot({ path: 'enterprise-flow-failure.png', fullPage: true }).catch(() => undefined);
    console.error(e);
    if (errs.length) console.error(errs.join('\n'));
    process.exitCode = 1;
  } finally {
    await b.close();
    await idp.close();
  }
})();
