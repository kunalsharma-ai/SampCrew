/**
 * The four design systems, one per level, end to end through real browsers (API :4000, Web Portal :3000, Console :3001):
 *
 *   pnpm db:reset   # fresh demo workspace; the bootstrap console admin must not have MFA yet
 *   node e2e/design-flow.cjs
 *
 * 1. Super Workspace (owner), HR Workspace (company-wide HR) and Employee Workspace each see their own design:
 *    data-level on the page, their own accent colour, sidebar and corner radius, on every page they open.
 * 2. Pages come in with each level's own animation, and none at all when the device asks for reduced motion.
 * 3. A palette someone picks still wins over the level design, and Workspace design brings it back.
 * 4. The Console has its own design, Command Center.
 */
const { chromium } = require('playwright');
const { authenticator } = require('otplib');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
const ADMIN_EMAIL = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
if (!PASSWORD || !ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD, CREW_BOOTSTRAP_ADMIN_EMAIL and CREW_BOOTSTRAP_ADMIN_PASSWORD (source .env)');

const SHOTS = process.env.SHOTS;
const ok = (m) => console.log(`ok - ${m}`);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const errs = [];

async function page(b, who, opts = {}) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: 'light', ...opts });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/status of 40[123]|Failed to load resource/.test(m.text()) && errs.push(`${who} ${m.text()}`));
  return p;
}

async function signIn(b, email, opts) {
  const p = await page(b, email, opts);
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

/** What the page looks like: its level, accent, sidebar art, corner radius and the page's entrance animation. */
const look = (p) => p.evaluate(() => {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const side = document.querySelector('.crew-sidebar');
  const pageEl = document.querySelector('.crew-page');
  return {
    level: root.dataset.level ?? null,
    accent: css.getPropertyValue('--accent').trim(),
    radius: css.getPropertyValue('--radius-scale').trim(),
    sidebar: side ? getComputedStyle(side).backgroundImage : null,
    animation: pageEl ? getComputedStyle(pageEl).animationName : null,
    duration: pageEl ? parseFloat(getComputedStyle(pageEl).animationDuration) : null,
  };
});
const save = async (p, name) => { if (SHOTS) { await p.waitForTimeout(700); await p.screenshot({ path: `${SHOTS}/${name}.png`, caret: 'initial' }); } };

(async () => {
  const b = await chromium.launch();
  let current;
  try {
    // 1. Each level has its own design, on every page.
    const people = [
      { email: 'owner@demo.crew.local', level: 'super', animation: 'crew-rise', pages: ['/', '/people', '/settings/hr-admin'] },
      { email: 'hr.admin@demo.crew.local', level: 'hr', animation: 'crew-bloom', pages: ['/', '/people', '/leave'] },
      { email: process.env.DESIGN_EMPLOYEE ?? 'uk.sales@demo.crew.local', level: 'employee', animation: 'crew-slide', pages: ['/', '/leave', '/profile'] },
    ];
    const seen = [];
    for (const who of people) {
      const p = current = await signIn(b, who.email);
      for (const path of who.pages) {
        await p.goto(WEB + path);
        await p.locator('main#main').waitFor();
        const l = await look(p);
        expect(l.level === who.level, `${who.email} on ${path}: expected the ${who.level} design, got ${l.level}`);
        expect(l.animation === who.animation, `${who.email} on ${path}: expected ${who.animation}, got ${l.animation}`);
        if (path === '/') seen.push(l);
      }
      await p.goto(WEB + '/');
      await save(p, `design-${who.level}`);
      ok(`${who.level} sees its own design on ${who.pages.join(', ')}`);
      if (who.level === 'employee') people.employeePage = p;
    }
    expect(new Set(seen.map((s) => s.accent)).size === 3, `the three levels share an accent: ${seen.map((s) => s.accent)}`);
    expect(new Set(seen.map((s) => s.sidebar)).size === 3, 'the three levels share a sidebar');
    expect(new Set(seen.map((s) => s.radius)).size === 3, `the three levels share a corner radius: ${seen.map((s) => s.radius)}`);
    ok('Super, HR and Employee Workspace differ in colour, sidebar and shape');

    // 2. Reduced motion: no entrance animation.
    const still = current = await signIn(b, 'owner@demo.crew.local', { reducedMotion: 'reduce' });
    await still.goto(WEB + '/people');
    const s = await look(still);
    expect(s.level === 'super' && s.duration !== null && s.duration < 0.01, `reduced motion should stop the page animation, got ${s.duration}s`);
    ok('reduced motion turns the page animations off');

    // 3. A palette someone picks wins; Workspace design brings the level design back.
    const emp = current = people.employeePage;
    const before = (await look(emp)).accent;
    await emp.goto(WEB + '/settings/appearance');
    await emp.getByRole('radio', { name: 'Rose Quartz' }).click();
    await emp.waitForFunction((a) => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() !== a, before, { timeout: 15000 });
    await emp.reload();
    expect((await look(emp)).accent !== before, 'the chosen palette should stay after a reload');
    await emp.getByRole('radio', { name: 'Workspace design' }).click();
    await emp.waitForFunction((a) => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === a, before, { timeout: 15000 });
    ok('a chosen palette wins over the level design, and Workspace design brings it back');

    // 4. The Console: Command Center.
    const admin = current = await page(b, 'console');
    await admin.goto(`${CONSOLE}/login`);
    await admin.fill('input[name=email]', ADMIN_EMAIL);
    await admin.fill('input[name=password]', ADMIN_PASSWORD);
    await admin.click('button[type=submit]');
    await admin.waitForURL(/\/enrol$/);
    await admin.click('text=Show QR code');
    const secret = (await admin.locator('code').first().textContent()).trim();
    await admin.fill('input[name=code]', authenticator.generate(secret));
    await admin.click('text=Turn on and continue');
    await admin.waitForURL(`${CONSOLE}/`);
    const c = await look(admin);
    expect(c.level === 'console' && c.animation === 'crew-scan', `the Console should use Command Center, got ${c.level} ${c.animation}`);
    expect(!seen.some((x) => x.accent === c.accent), 'the Console accent should differ from the three workspaces');
    await save(admin, 'design-console');
    ok('the Console uses Command Center');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('design flow passed');
  } catch (e) {
    if (current) await current.screenshot({ path: process.env.SHOT ?? '/tmp/design-fail.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
