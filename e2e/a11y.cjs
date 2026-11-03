/**
 * Accessibility check of the main screens with axe-core (WCAG 2.1 A and AA rules), in a real browser against the
 * running Web Portal, Super Admin Console and the mobile app's browser build.
 *
 *   pnpm db:reset; start the API, web (3000), console (3001) and, optionally, the mobile browser build (8081)
 *   node e2e/a11y.cjs [--report docs/ops/a11y-latest.md]
 *
 * Every page is checked in the light and the dark theme, signed in as the person who uses it. With
 * CREW_BOOTSTRAP_ADMIN_EMAIL and _PASSWORD set (and a fresh database) the Console is checked signed in too. The run fails on any
 * "serious" or "critical" violation; "moderate" and "minor" ones are listed in the report. Automated rules catch
 * roughly a third to a half of accessibility problems; keyboard and screen reader passes by people are still needed.
 */
const { chromium } = require('playwright');
const { createReadStream, existsSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const MOBILE = process.env.MOBILE_URL ?? 'http://localhost:8081';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const REPORT = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : undefined;
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BLOCKING = new Set(['serious', 'critical']);

const pages = {
  public: ['/login', '/signup', '/careers/northwind-demo'],
  'uk.hr@demo.crew.local': ['/', '/people', '/leave', '/attendance', '/approvals', '/helpdesk', '/organization', '/settings/workspace', '/settings/appearance'],
  'operator1@demo.crew.local': ['/', '/payslips', '/leave', '/attendance', '/helpdesk', '/goals'],
};

async function check(page, label) {
  await page.waitForLoadState('networkidle');
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')), count: v.nodes.length }));
  });
  return result.map((v) => ({ ...v, page: label }));
}

async function signIn(ctx, email) {
  const p = await ctx.newPage();
  await p.goto(`${WEB}/login`);
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForURL(`${WEB}/`, { timeout: 15000 });
  return p;
}

async function setTheme(page, theme) {
  await page.emulateMedia({ colorScheme: theme });
}

/** Serves the mobile app's browser build on 8081 when it has been exported and nothing else serves it. */
async function serveMobile() {
  const dist = path.join(__dirname, '..', 'apps', 'mobile', 'dist-web');
  if (process.env.MOBILE_URL || !existsSync(path.join(dist, 'index.html'))) return null;
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };
  const server = http.createServer((req, res) => {
    let file = path.normalize(path.join(dist, decodeURIComponent((req.url ?? '/').split('?')[0])));
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(8081, () => r(server)).on('error', () => r(null)));
}

/** The mobile app signed in as an employee: home, attendance, leave, helpdesk and profile tabs. */
async function mobileScreens(b, theme, found, checked) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: theme, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  if (!(await p.goto(`${MOBILE}/login`, { timeout: 5000 }).then(() => true, () => false))) return ctx.close();
  await p.getByLabel('Work email').waitFor({ timeout: 15000 });
  found.push(...(await check(p, `Mobile /login (${theme})`)));
  checked.push(`Mobile /login (${theme})`);
  await p.getByLabel('Work email').fill('operator2@demo.crew.local');
  await p.getByLabel('Password').fill(PASSWORD);
  await p.getByRole('button', { name: 'Sign in', exact: true }).click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  for (const route of ['/', '/attendance', '/leave', '/helpdesk', '/me']) {
    await p.goto(`${MOBILE}${route}`);
    await p.waitForTimeout(1500);
    found.push(...(await check(p, `Mobile ${route} (${theme})`)));
    checked.push(`Mobile ${route} (${theme})`);
  }
  await ctx.close();
}

/**
 * The Super Admin Console signed in, when CREW_BOOTSTRAP_ADMIN_EMAIL and _PASSWORD are set: enrols the admin's
 * two-step verification as a new admin would (so it needs a fresh database), then checks every page in both themes.
 */
async function consoleScreens(b, found, checked) {
  const email = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return;
  const { authenticator } = require('otplib');
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const p = await ctx.newPage();
  if (!(await p.goto(`${CONSOLE}/login`).then(() => true, () => false))) return ctx.close();
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', password);
  await p.click('button[type=submit]');
  await p.waitForURL(/\/enrol$/, { timeout: 15000 });
  for (const theme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: theme });
    await p.waitForTimeout(600); // let colour transitions finish after switching theme on an open page
    found.push(...(await check(p, `Console /enrol (${theme})`)));
    checked.push(`Console /enrol (${theme})`);
  }
  await p.click('text=Show QR code');
  const secret = (await p.locator('code').first().textContent()).trim();
  await p.fill('input[name=code]', authenticator.generate(secret));
  await p.click('text=Turn on and continue');
  await p.waitForURL(`${CONSOLE}/`, { timeout: 15000 });
  await p.goto(`${CONSOLE}/tenants`);
  const tenant = await p.locator('a[href^="/tenants/"]').first().getAttribute('href');
  for (const theme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: theme });
    for (const path of ['/', '/tenants', tenant, `${tenant}/access`, `${tenant}/access?tab=permissions`, `${tenant}/access?tab=people`, '/plans', '/integrations', '/health', '/audit', '/admins']) {
      await p.goto(`${CONSOLE}${path}`);
      const label = `Console ${path.startsWith(tenant) ? path.replace(tenant, '/tenants/:id') : path} (${theme})`;
      found.push(...(await check(p, label)));
      checked.push(label);
    }
  }
  await ctx.close();
}

(async () => {
  const mobileServer = await serveMobile();
  const b = await chromium.launch();
  const found = [];
  const checked = [];
  for (const theme of ['light', 'dark']) {
    const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: theme });
    const anon = await ctx.newPage();
    for (const path of pages.public) {
      await anon.goto(`${WEB}${path}`);
      found.push(...(await check(anon, `Web ${path} (${theme})`)));
      checked.push(`Web ${path} (${theme})`);
    }
    await anon.close();
    for (const [email, paths] of Object.entries(pages)) {
      if (email === 'public') continue;
      const c = await b.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: theme });
      const p = await signIn(c, email);
      await setTheme(p, theme);
      for (const path of paths) {
        await p.goto(`${WEB}${path}`);
        const label = `Web ${path} as ${email.split('@')[0]} (${theme})`;
        found.push(...(await check(p, label)));
        checked.push(label);
      }
      await c.close();
    }
    // Super Admin Console sign-in
    const cp = await ctx.newPage();
    if (await cp.goto(`${CONSOLE}/login`).then(() => true, () => false)) {
      found.push(...(await check(cp, `Console /login (${theme})`)));
      checked.push(`Console /login (${theme})`);
    }
    await mobileScreens(b, theme, found, checked);
    await ctx.close();
  }
  await consoleScreens(b, found, checked);
  await b.close();
  mobileServer?.close();

  const blocking = found.filter((v) => BLOCKING.has(v.impact));
  const lines = [
    '# Accessibility check (axe-core, WCAG 2.1 A and AA)',
    '',
    `- Run at: ${new Date().toISOString()}`,
    `- Screens checked: ${checked.length / 2}, each in the light and the dark theme (${checked.length} page views)`,
    `- Violations: ${blocking.length} serious or critical, ${found.length - blocking.length} moderate or minor`,
    '',
    ...(found.length
      ? ['| Page | Rule | Impact | Elements | Example |', '|---|---|---|---:|---|', ...found.map((v) => `| ${v.page} | ${v.id}: ${v.help} | ${v.impact} | ${v.count} | \`${(v.nodes[0] ?? '').replace(/\|/g, '\\|').slice(0, 80)}\` |`), '']
      : ['No violations found on the pages checked.', '']),
    `Pages: ${checked.join('; ')}.`,
    '',
    blocking.length ? '**Result: FAILED** (serious or critical violations).' : '**Result: passed** (no serious or critical violations).',
  ];
  console.log(lines.join('\n'));
  if (REPORT) writeFileSync(REPORT, `${lines.join('\n')}\n`);
  if (blocking.length) process.exit(1);
})().catch((e) => {
  console.error('FAILED', e.message);
  process.exit(1);
});
