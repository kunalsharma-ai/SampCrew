/**
 * Phase 11 end-to-end flow: SAML 2.0 single sign-on in the Web Portal, single sign-on in the mobile app (its browser
 * build), SCIM groups mapped to a role, and the retention schedule, against the demo workspace.
 *
 * The flow runs its own SAML TEST STUB on 4031 (e2e/saml-stub.cjs), which stands in for an identity provider such as
 * Okta or Microsoft Entra ID and signs real assertions with a throwaway key; no real provider is called. It serves
 * the mobile app's browser build on 8081 like e2e/mobile-flow.cjs.
 *
 *   pnpm db:reset
 *   INTEGRATIONS_ALLOW_PRIVATE_URLS=true MOBILE_SSO_REDIRECTS=crew://sso,http://localhost:8081/sso node apps/api/dist/main.js &
 *   pnpm --filter @crew/web start &
 *   pnpm --filter @crew/mobile export:web
 *   node e2e/hardening-flow.cjs
 *
 * 1. SAMPLEDGE moves the demo workspace to Enterprise. The owner enrols two-step verification, picks SAML 2.0, copies
 *    SampCrew's entity ID and ACS URL, pastes the provider's certificate (SampCrew shows its fingerprint and expiry), runs a
 *    test sign-in through the provider and switches single sign-on on.
 * 2. A forged response (signed with another key) is refused with the reason. HR then signs in through SAML.
 * 3. On the phone app, a member chooses single sign-on: the provider signs them in and the app gets its session
 *    through the one-time code bound to its PKCE challenge.
 * 4. The owner creates a SCIM token; the "provider" pushes a group with a member; the owner maps the group to the
 *    Payroll Admin role in Settings and the member holds it.
 * 5. HR sets a retention schedule and runs it; the run is listed.
 * Fails on any browser error.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const samlStub = require('./saml-stub.cjs');

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const API = (process.env.CREW_API_URL ?? 'http://localhost:4000') + '/api/v1';
const APP_PORT = Number(process.env.MOBILE_PORT ?? 8081);
const APP = `http://localhost:${APP_PORT}`;
const DIST = path.join(__dirname, '..', 'apps', 'mobile', 'dist-web');
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
const ADMIN_EMAIL = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
if (!PASSWORD || !ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD, CREW_BOOTSTRAP_ADMIN_EMAIL and CREW_BOOTSTRAP_ADMIN_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/status of 40[0-9]|Failed to load resource/.test(m.text()) && errs.push(`${who} ${m.text()}`));
  p.on('dialog', (d) => d.accept());
};
const expect = (cond, msg) => {
  if (!cond) throw new Error(`expected: ${msg}`);
};

async function api(token, method, p, body, contentType = 'application/json') {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + p, {
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

function serveApp() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`Build the app first: pnpm --filter @crew/mobile export:web (missing ${DIST})`);
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.normalize(path.join(DIST, url));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(APP_PORT, () => r(server)));
}

async function page(b, who, opts = {}) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, ...opts });
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

async function enrolMfa(p) {
  await p.goto(BASE + '/settings/security');
  await p.click('text=Set up two-step verification');
  const secret = (await p.locator('code').first().textContent()).trim();
  await p.fill('input[name=code]', authenticator.generate(secret));
  await p.click('text=Turn on');
  await p.waitForSelector('text=/two-step verification is on/i', { timeout: 8000 });
}

async function ssoSignIn(p, email) {
  await p.goto(BASE + '/login');
  await p.click('text=Sign in with single sign-on');
  await p.fill('input[name=email]', email);
  await p.click('button:has-text("Continue")');
}

const post = (url, body) => fetch(url, { method: 'POST', body: JSON.stringify(body) });

(async () => {
  const idp = await samlStub.start({ port: 4031, host: '127.0.0.1' });
  const appServer = await serveApp();
  const b = await chromium.launch();
  let current;
  try {
    // 1. Enterprise plan, then the owner connects a SAML provider.
    const login = await api(null, 'POST', '/platform/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(login.body?.status === 'ok', `console admin signs in (${login.status})`);
    const setup = await api(login.body.accessToken, 'POST', '/platform/auth/mfa/setup');
    const staff = (await api(login.body.accessToken, 'POST', '/platform/auth/mfa/enable', { code: authenticator.generate(setup.body.secret) })).body.accessToken;
    const tenants = await api(staff, 'GET', '/platform/tenants');
    const demo = (Array.isArray(tenants.body) ? tenants.body : tenants.body.items).find((t) => t.slug === 'demo-northwind');
    expect((await api(staff, 'PUT', `/platform/tenants/${demo.id}/subscription`, { planKey: 'enterprise' })).status === 200, 'plan change');
    ok('demo workspace moved to the Enterprise plan through the console API');

    const owner = await page(b, 'owner', { acceptDownloads: true });
    current = owner;
    await passwordSignIn(owner, 'owner@demo.crew.local');
    await enrolMfa(owner);
    await owner.goto(BASE + '/settings/single-sign-on');
    await owner.selectOption('select[name=protocol]', 'saml');
    const entityId = (await owner.locator('[data-testid=saml-entity-id]').textContent()).trim();
    const acs = (await owner.locator('[data-testid=saml-acs-url]').textContent()).trim();
    expect(acs === `${BASE}/sso/saml`, `ACS URL shown (${acs})`);
    const metadata = await (await fetch(`${API}/auth/sso/saml/metadata`)).text();
    expect(metadata.includes(`entityID="${entityId}"`) && metadata.includes(`Location="${acs}"`), 'metadata matches what Settings shows');
    await owner.fill('input[name=idpEntityId]', idp.entityId);
    await owner.fill('input[name=ssoUrl]', idp.ssoUrl);
    await owner.fill('textarea[name=certificate]', idp.cert);
    await owner.fill('input[name=domains]', 'demo.crew.local');
    await owner.click('text=Save and check certificate');
    await owner.waitForSelector('text=The certificate is valid', { timeout: 15000 });
    expect(/SHA-256 [0-9A-F:]{95}/.test(await owner.locator('[data-testid=saml-cert]').textContent()), 'certificate fingerprint shown');
    expect((await owner.locator('[data-testid=sso-protocol]').textContent()) === 'SAML 2.0', 'protocol shown');
    ok('owner connected a SAML 2.0 provider; SampCrew checked the certificate and shows its fingerprint and expiry');

    await post(`${idp.base}/__user`, { email: 'owner@demo.crew.local', name: 'Aarav Mehta', authnContext: 'http://schemas.microsoft.com/claims/multipleauthn' });
    await owner.click('button:has-text("Test sign-in")');
    await owner.waitForURL((u) => u.pathname === '/settings/single-sign-on' && u.searchParams.get('tested') === '1', { timeout: 20000 });
    await owner.waitForSelector('text=Test sign-in passed');
    const req = (await (await fetch(`${idp.base}/__requests`)).json()).requests.at(-1);
    expect(req.acs === acs && req.issuer === entityId, 'the AuthnRequest named SampCrew and its ACS');
    await owner.click('button:has-text("Switch on")');
    await owner.waitForSelector('text=Single sign-on switched on');
    ok('test sign-in went through the SAML provider and back (HTTP-Redirect, then HTTP-POST), then single sign-on was switched on');

    // 2. A forged response, then HR signs in.
    const hr = await page(b, 'hr');
    current = hr;
    await post(`${idp.base}/__user`, { email: 'hr.admin@demo.crew.local', name: 'Priya Nair', authnContext: 'http://schemas.microsoft.com/claims/multipleauthn' });
    await post(`${idp.base}/__tamper`, { tamper: 'bad_signature' });
    await ssoSignIn(hr, 'hr.admin@demo.crew.local');
    await hr.waitForURL((u) => u.pathname === '/login' && u.searchParams.get('sso_error') === '1', { timeout: 20000 });
    await hr.waitForSelector('text=/did not verify \\(Invalid signature\\)/');
    ok('a response signed with another key is refused and the reason shown');
    await post(`${idp.base}/__tamper`, { tamper: null });
    await ssoSignIn(hr, 'hr.admin@demo.crew.local');
    await hr.waitForURL((u) => u.pathname === '/', { timeout: 20000 });
    await hr.waitForSelector('text=Priya');
    ok('HR signed in with SAML from the sign-in page');

    // 3. The mobile app (browser build at phone size).
    const phone = await page(b, 'phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    current = phone;
    await post(`${idp.base}/__user`, { email: 'supervisor@demo.crew.local', name: 'Sam Supervisor', authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport' });
    await phone.goto(APP + '/login');
    await phone.getByRole('button', { name: 'Sign in with single sign-on' }).click();
    await phone.getByLabel('Work email').fill('supervisor@demo.crew.local');
    await phone.getByRole('button', { name: 'Continue' }).click();
    await phone.waitForURL((u) => u.origin === APP && u.pathname === '/sso', { timeout: 30000 });
    const used = new URL(phone.url()).searchParams.get('code');
    expect(used && used.length >= 20, 'the browser came back to the app with a one-time code');
    await phone.getByText(/^Good (morning|afternoon|evening)/).waitFor({ timeout: 30000 });
    expect(!(await phone.evaluate(() => window.sessionStorage.getItem('crew.sso.verifier'))), 'the verifier is removed after use');
    // The code in the address was spent: using it again gets nothing.
    expect((await api(null, 'POST', '/auth/sso/exchange', { code: used, verifier: 'x'.repeat(43) })).status === 401, 'a spent code is refused');
    ok('the mobile app signed in through the identity provider with a one-time code bound to its PKCE challenge');

    // 4. SCIM groups mapped to a role.
    current = owner;
    await owner.goto(BASE + '/settings/single-sign-on');
    await owner.click('button:has-text("Create token")');
    const token = (await owner.locator('[data-testid=secret-value]').textContent()).trim();
    const scim = (method, p, body) => api(token, method, `/scim/v2${p}`, body, 'application/scim+json');
    const found = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "supervisor@demo.crew.local"')}`);
    const memberId = found.body.Resources[0].id;
    const g = await scim('POST', '/Groups', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Payroll team', externalId: 'okta-payroll', members: [{ value: memberId }] });
    expect(g.status === 201, `group created (${g.status} ${JSON.stringify(g.body)})`);
    await owner.reload();
    const row = owner.locator('[data-testid="scim-group-Payroll team"]');
    await row.waitFor();
    await row.locator('select').selectOption({ label: 'Payroll Admin' });
    await owner.waitForSelector("text=Role granted to the group's members");
    const sup = await api(null, 'POST', '/auth/login', { email: 'supervisor@demo.crew.local', password: PASSWORD });
    const me = await api(sup.body.accessToken, 'GET', '/me');
    expect(me.body.membership.roles.some((r) => r.key === 'payroll_admin'), `group member holds the mapped role (${JSON.stringify(me.body.membership.roles)})`);
    await scim('PATCH', `/Groups/${g.body.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'remove', path: `members[value eq "${memberId}"]` }] });
    const me2 = await api(sup.body.accessToken, 'GET', '/me');
    expect(!me2.body.membership.roles.some((r) => r.key === 'payroll_admin'), 'removed from the group, the role goes');
    ok('a group pushed over SCIM was mapped to a role in Settings; joining and leaving the group granted and removed it');

    // 5. Retention schedule.
    current = hr;
    await hr.goto(BASE + '/privacy');
    await hr.click('text=Erase leavers automatically');
    await hr.fill('input[name=exitedErasureYears]', '10');
    await hr.fill('input[name=exportDays]', '45');
    await hr.click('button:has-text("Save schedule")');
    await hr.waitForSelector('text=Retention schedule saved');
    await hr.waitForSelector('[data-testid=retention-due]');
    await hr.click('button:has-text("Run now")');
    await hr.waitForSelector('text=/Done: \\d+ erased/');
    await hr.waitForSelector('[data-testid=retention-run]');
    ok('HR saved a retention schedule and ran it; the run is listed with what it did');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('all Phase 11 flows passed');
  } catch (e) {
    if (current) await current.screenshot({ path: path.join(process.cwd(), 'hardening-failure.png'), fullPage: true }).catch(() => undefined);
    console.error(errs.join('\n'));
    throw e;
  } finally {
    await b.close();
    await idp.close();
    appServer.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
