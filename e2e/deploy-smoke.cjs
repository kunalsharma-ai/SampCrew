/**
 * Checks a running production-style deployment from the outside, through its TLS proxy (infra/deploy/smoke.sh).
 *
 *   WEB_URL=https://localhost:8443 CONSOLE_URL=https://localhost:8444 API_URL=https://localhost:8445 \
 *   CREW_DEMO_PASSWORD=... node e2e/deploy-smoke.cjs
 *
 * The local smoke test uses Caddy's own test certificate authority, so certificate errors are ignored here; against a
 * real deployment set SMOKE_STRICT_TLS=1 and the certificates must be valid.
 */
const { chromium } = require('playwright');
const https = require('node:https');

const WEB = process.env.WEB_URL;
const CONSOLE = process.env.CONSOLE_URL;
const API = process.env.API_URL;
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!WEB || !CONSOLE || !API || !PASSWORD) throw new Error('Set WEB_URL, CONSOLE_URL, API_URL and CREW_DEMO_PASSWORD');
const strict = process.env.SMOKE_STRICT_TLS === '1';
const ok = (m) => console.log(`ok - ${m}`);

function get(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: opts.method ?? 'GET', rejectUnauthorized: strict, headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  // Health through the proxy
  const live = await get(`${API}/api/v1/health/ready`);
  expect(live.status === 200 && JSON.parse(live.body).status === 'ok', `API ready: ${live.status} ${live.body}`);
  ok('API is ready through the proxy');
  const webReady = await get(`${WEB}/healthz?ready=1`);
  expect(webReady.status === 200, `web ready: ${webReady.status} ${webReady.body}`);
  ok('Web Portal is ready and reaches the API');

  // TLS-only headers and security headers on every app
  for (const [name, url] of [['API', `${API}/api/v1/health/live`], ['Web Portal', `${WEB}/login`], ['Console', `${CONSOLE}/login`]]) {
    const r = await get(url);
    expect(r.status === 200, `${name} ${url} -> ${r.status}`);
    expect(/max-age=\d+/.test(r.headers['strict-transport-security'] ?? ''), `${name} has no HSTS header`);
    expect(r.headers['x-content-type-options'] === 'nosniff', `${name} has no nosniff header`);
    expect(!r.headers['x-powered-by'] && !r.headers.server, `${name} reveals its server: ${r.headers['x-powered-by'] ?? r.headers.server}`);
    if (name !== 'API') expect(/frame-ancestors/.test(r.headers['content-security-policy'] ?? ''), `${name} has no Content-Security-Policy`);
  }
  ok('HSTS, nosniff and a Content Security Policy on every app; no server banners');

  // The API refuses a production-unsafe CORS origin
  const cors = await get(`${API}/api/v1/health/live`, { headers: { origin: 'https://evil.example' } });
  expect(!cors.headers['access-control-allow-origin'], 'API allowed an unknown CORS origin');
  ok('API does not allow unknown origins');

  // Sign in and use the main pages in a real browser, watching for CSP violations and script errors
  const b = await chromium.launch();
  const ctx = await b.newContext({ ignoreHTTPSErrors: !strict, viewport: { width: 1360, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(`page error: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`));
  await p.goto(`${WEB}/login`);
  await p.fill('input[name=email]', 'uk.hr@demo.crew.local');
  await p.fill('input[name=password]', PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForURL(`${WEB}/`, { timeout: 15000 });
  const cookies = await ctx.cookies(WEB);
  const session = cookies.filter((c) => c.name === 'crew_at' || c.name === 'crew_rt');
  expect(session.length === 2 && session.every((c) => c.secure && c.httpOnly), `session cookies must be Secure and HttpOnly: ${JSON.stringify(session.map((c) => [c.name, c.secure, c.httpOnly]))}`);
  ok('signed in over TLS; session cookies are Secure and HttpOnly');
  for (const path of ['/people', '/leave', '/attendance', '/approvals', '/payroll', '/settings/workspace']) {
    const r = await p.goto(`${WEB}${path}`);
    expect(r && r.status() < 400, `${path} -> ${r && r.status()}`);
    await p.waitForLoadState('networkidle');
    expect(!p.url().includes('/login'), `${path} sent the signed-in user back to sign-in`);
  }
  ok('People, Leave, Attendance, Approvals, Payroll and Settings open');
  const fonts = await p.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family));
  expect(fonts.some((f) => /Inter/.test(f)), `self-hosted Inter font not loaded: ${fonts.join(', ')}`);
  ok('fonts load from CREW itself');
  // Open redirect guard on sign-in
  await ctx.clearCookies();
  await p.goto(`${WEB}/login?next=${encodeURIComponent('/\\evil.example')}`);
  await p.fill('input[name=email]', 'uk.hr@demo.crew.local');
  await p.fill('input[name=password]', PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForURL((u) => u.pathname === '/' || !u.href.startsWith(WEB), { timeout: 15000 });
  expect(p.url().startsWith(WEB), `sign-in followed an outside next= address to ${p.url()}`);
  ok('sign-in ignores a next= address outside CREW');
  expect(!errs.length, `browser errors:\n${errs.join('\n')}`);
  ok('no script errors or Content Security Policy violations');

  // Console: reachable from the private network the smoke test runs in, sign-in page renders
  const cp = await ctx.newPage();
  await cp.goto(`${CONSOLE}/login`);
  await cp.waitForSelector('input[name=email]');
  ok('Console sign-in page opens from an allowed network');
  await b.close();
  console.log('\nDeployment smoke test passed.');
})().catch((e) => {
  console.error('FAILED', e.message);
  process.exit(1);
});
