/**
 * In-app help ("i" icons) end-to-end, in a real browser: the Web Portal, the Super Admin Console and the mobile
 * app's browser build.
 *
 *   pnpm db:reset            # fresh database (the console admin must not have MFA enrolled yet)
 *   start the API, web (3000), console (3001); export the mobile browser build (pnpm --filter @crew/mobile export:web)
 *   node e2e/help-flow.cjs
 *
 * Web Portal:
 * 1. Every main page an HR admin opens shows a page "i" icon; module icons sit on the sidebar groups.
 * 2. Mouse: hovering peeks at the help and leaving closes it; clicking keeps it open until a click elsewhere.
 * 3. Keyboard: Enter opens it with focus inside the bubble, Escape closes it and puts focus back on the icon.
 * 4. Inside a modal form (Request time off) a field's help shows above the dialog, and Escape closes only the help.
 * 5. The open bubble passes axe (WCAG 2.1 AA) in light, dark, neon and classic styles.
 * 6. On a phone-sized screen a tap opens it fully on screen.
 * Console: page and section help on the overview and a workspace page. Mobile app: header and card help sheets.
 * Fails on any browser error.
 */
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const { createReadStream, existsSync, readFileSync, statSync } = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const MOBILE = process.env.MOBILE_URL ?? 'http://localhost:8081';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
const ADMIN_EMAIL = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(`${who} ${m.text()}`));
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function signIn(b, email, opts = {}) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, ...opts });
  const p = await ctx.newPage();
  watch(p, email);
  // Sign-in is rate limited per address (10 a minute). After the other flows in CI, wait for the window instead of failing.
  for (let attempt = 0; ; attempt++) {
    await p.goto(WEB + '/login');
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

const pageIcon = (p) => p.locator('main').getByRole('button', { name: 'More about this page', exact: true }).first();
const openBubble = (p) => p.locator('[data-help-pop]:popover-open');

async function axeOpen(p, label) {
  await p.addScriptTag({ content: AXE });
  const v = await p.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document.querySelector('[data-help-pop]:popover-open'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
    return r.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
  assert(v.length === 0, `${label}: axe found ${v.join('; ')}`);
}

/** Serves the mobile app's browser build on 8081 when it has been exported and nothing else serves it. */
async function serveMobile() {
  const dist = path.join(__dirname, '..', 'apps', 'mobile', 'dist-web');
  if (process.env.MOBILE_URL || !existsSync(path.join(dist, 'index.html'))) return null;
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    let file = path.normalize(path.join(dist, decodeURIComponent((req.url ?? '/').split('?')[0])));
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(8081, () => r(server)).on('error', () => r(null)));
}

async function web(b) {
  const p = await signIn(b, 'uk.hr@demo.crew.local');

  // 1. Page icons on the main pages, module icons on the sidebar.
  const pages = ['/', '/employees', '/people', '/organization', '/leave', '/attendance', '/approvals', '/helpdesk', '/reviews', '/learning', '/insights', '/settings/leave', '/settings/onboarding', '/settings/appearance', '/settings/security'];
  for (const url of pages) {
    await p.goto(WEB + url);
    await pageIcon(p).waitFor({ timeout: 15000 });
  }
  ok(`page help icon on ${pages.length} pages`);
  const modules = p.locator('nav[aria-label="Main"]').getByRole('button', { name: 'More about this module', exact: true });
  assert((await modules.count()) >= 5, `expected sidebar module icons, found ${await modules.count()}`);
  await modules.first().click();
  await openBubble(p).waitFor();
  assert(/What it is for/i.test(await openBubble(p).innerText()), 'module bubble has no "What it is for"');
  await p.mouse.click(700, 20);
  await openBubble(p).waitFor({ state: 'detached' }).catch(async () => assert((await openBubble(p).count()) === 0, 'module bubble stayed open'));
  ok('sidebar module icons explain each group');

  // 2. Mouse: hover peeks, leaving closes, click pins.
  await p.goto(WEB + '/employees');
  const icon = pageIcon(p);
  await icon.hover();
  await openBubble(p).waitFor();
  const text = await openBubble(p).innerText();
  assert(/Employees/.test(text) && /How to use it/i.test(text) && /Where and when/i.test(text), `unexpected bubble text: ${text}`);
  assert((await icon.getAttribute('aria-expanded')) === 'true', 'aria-expanded not true while open');
  await p.mouse.move(1300, 850);
  await p.waitForTimeout(400);
  assert((await openBubble(p).count()) === 0, 'hover bubble did not close when the mouse left');
  await icon.click();
  await openBubble(p).waitFor();
  await p.mouse.move(1300, 850);
  await p.waitForTimeout(400);
  assert((await openBubble(p).count()) === 1, 'clicked bubble closed when the mouse left');
  await p.mouse.click(1300, 850);
  await p.waitForTimeout(100);
  assert((await openBubble(p).count()) === 0, 'clicked bubble did not close on a click elsewhere');
  ok('hover peeks, click keeps it open, a click elsewhere closes it');

  // 3. Keyboard.
  await icon.focus();
  await p.keyboard.press('Enter');
  await openBubble(p).waitFor();
  assert(await p.evaluate(() => document.activeElement?.hasAttribute('data-help-pop')), 'focus did not move into the bubble');
  assert((await p.evaluate(() => document.activeElement?.getAttribute('role'))) === 'dialog', 'bubble is not a named dialog');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(100);
  assert((await openBubble(p).count()) === 0, 'Escape did not close the bubble');
  assert(await p.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'More about this page'), 'focus did not return to the icon');
  await p.keyboard.press('Space');
  await openBubble(p).waitFor();
  await p.keyboard.press('Tab');
  await p.waitForTimeout(100);
  assert((await openBubble(p).count()) === 0, 'Tab out of the bubble did not close it');
  ok('keyboard: Enter or Space opens with focus inside, Escape returns focus, Tab moves on');

  // Section help (Leave settings) uses the page-independent section text.
  await p.goto(WEB + '/settings/leave');
  const section = p.locator('main').getByRole('button', { name: 'More about this section', exact: true });
  assert((await section.count()) >= 3, `expected section icons on Leave settings, found ${await section.count()}`);
  ok(`section icons on Leave settings (${await section.count()})`);

  // 4. Field help inside a modal dialog.
  await p.goto(WEB + '/leave?create=leave');
  const dlg = p.locator('dialog[open]');
  await dlg.waitFor();
  const field = dlg.getByRole('button', { name: 'More about this field', exact: true }).first();
  await field.waitFor();
  await field.click();
  await openBubble(p).waitFor();
  const onTop = await p.evaluate(() => {
    const pop = document.querySelector('[data-help-pop]:popover-open');
    const r = pop.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(20, r.height / 2));
    return pop.contains(hit);
  });
  assert(onTop, 'field help is hidden behind the dialog');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(150);
  assert((await openBubble(p).count()) === 0, 'Escape did not close the field help');
  assert(await dlg.isVisible(), 'Escape on the help also closed the dialog');
  ok('field help shows above a modal dialog; Escape closes only the help');
  await p.keyboard.press('Escape');

  // 5. Themes: light/dark x neon/classic, axe on the open bubble.
  await p.goto(WEB + '/employees');
  for (const scheme of ['light', 'dark']) {
    for (const style of ['neon', 'classic']) {
      await p.emulateMedia({ colorScheme: scheme });
      await p.evaluate(([s, m]) => {
        document.documentElement.dataset.style = s;
        document.documentElement.dataset.theme = m;
      }, [style, scheme]);
      await pageIcon(p).click();
      await openBubble(p).waitFor();
      await axeOpen(p, `${style} ${scheme}`);
      await p.screenshot({ path: path.join(process.env.SHOTS ?? '/tmp', `help-web-${style}-${scheme}.png`) }).catch(() => {});
      await p.keyboard.press('Escape');
    }
  }
  ok('open help passes axe in neon and classic, light and dark');

  // Sidebar (dark neon panel) bubble passes axe too.
  await p.evaluate(() => { document.documentElement.dataset.style = 'neon'; });
  await modules.first().click();
  await openBubble(p).waitFor();
  await axeOpen(p, 'sidebar neon');
  await p.keyboard.press('Escape');
  await p.context().close();

  // 6. Phone-sized screen: tap opens it, fully on screen.
  const m = await signIn(b, 'operator1@demo.crew.local', { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
  await m.goto(WEB + '/leave');
  await pageIcon(m).tap();
  await openBubble(m).waitFor();
  const box = await openBubble(m).boundingBox();
  assert(box && box.x >= 0 && box.x + box.width <= 375 && box.y >= 0 && box.y + box.height <= 740, `bubble off screen: ${JSON.stringify(box)}`);
  await pageIcon(m).tap();
  await m.waitForTimeout(150);
  assert((await openBubble(m).count()) === 0, 'second tap did not close it');
  ok('phone: tap opens the help on screen, tap again closes it');
  await m.context().close();
}

async function consoleApp(b) {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return console.log('skip - console (set CREW_BOOTSTRAP_ADMIN_EMAIL and _PASSWORD)');
  const p = await (await b.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  watch(p, 'console');
  await p.goto(`${CONSOLE}/login`);
  await p.fill('input[name=email]', ADMIN_EMAIL);
  await p.fill('input[name=password]', ADMIN_PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForURL(/\/enrol$/);
  await p.click('text=Show QR code');
  const secret = (await p.locator('code').first().textContent()).trim();
  await p.fill('input[name=code]', authenticator.generate(secret));
  await p.click('text=Turn on and continue');
  await p.waitForURL(`${CONSOLE}/`);
  for (const url of ['/', '/tenants', '/plans', '/integrations', '/health', '/audit', '/admins', '/devices']) {
    await p.goto(CONSOLE + url);
    await pageIcon(p).waitFor({ timeout: 15000 });
  }
  await p.goto(CONSOLE + '/');
  assert((await p.locator('main').getByRole('button', { name: 'More about this section', exact: true }).count()) >= 2, 'console overview has no section icons');
  await pageIcon(p).click();
  await openBubble(p).waitFor();
  assert((await openBubble(p).innerText()).includes('SampCrew across all customers'), 'console overview help text missing');
  await axeOpen(p, 'console');
  await p.keyboard.press('Escape');
  await p.goto(CONSOLE + '/tenants');
  await p.locator('main a[href^="/tenants/"]').first().click();
  await p.waitForURL(/\/tenants\/[^/]+$/);
  await pageIcon(p).waitFor();
  ok('console: page and section help on every main page');
  await p.context().close();
}

async function mobile(b) {
  const server = await serveMobile();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  watch(p, 'mobile');
  if (!(await p.goto(`${MOBILE}/login`, { timeout: 5000 }).then(() => true, () => false))) {
    console.log('skip - mobile (no browser build; run pnpm --filter @crew/mobile export:web)');
    return server?.close();
  }
  await p.getByLabel('Work email').waitFor({ timeout: 15000 });
  await p.getByLabel('Work email').fill('operator2@demo.crew.local');
  await p.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await p.getByRole('button', { name: 'Sign in', exact: true }).click();
  await p.getByTestId('home-hero').waitFor({ timeout: 20000 });
  // Header "i" on the home screen, then a card's "i".
  await p.getByTestId('help-home').last().click();
  await p.getByTestId('help-sheet').waitFor();
  assert((await p.getByTestId('help-sheet').innerText()).includes('Your day at a glance'), 'home help text missing');
  await p.getByTestId('help-close').click();
  await p.getByTestId('help-sheet').waitFor({ state: 'hidden' });
  await p.getByTestId('help-home.notifications').click();
  await p.getByTestId('help-sheet').waitFor();
  await p.getByTestId('help-close').click();
  await p.getByTestId('help-sheet').waitFor({ state: 'hidden' });
  ok('mobile: header and card help open and close');
  await ctx.close();
  server?.close();
}

(async () => {
  const b = await chromium.launch();
  try {
    await web(b);
    await consoleApp(b);
    await mobile(b);
  } finally {
    await b.close();
  }
  const real = errs.filter((e) => !/Failed to load resource: the server responded with a status of 40[134]/.test(e));
  if (real.length) {
    console.error(real.join('\n'));
    process.exit(1);
  }
  ok('no browser errors');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
