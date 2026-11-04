/**
 * Neon dashboard design, end to end in the Web Portal against the demo workspace:
 *   pnpm db:reset            # fresh demo workspace (hr.admin must not have MFA enrolled yet)
 *   API on :4000, Web Portal on :3000, then: pnpm e2e:neon
 *
 * 1. HR signs in to the neon design: the dark sidebar, gradient KPI tiles and the Home charts are there.
 * 2. Every module overview (Employees, Recruitment, Attendance, Leave, Performance, Learning, HR analytics) shows
 *    the same numbers the API computes from live records for that person.
 * 3. Themes & Templates previews a theme on the live page and puts the saved look back when closed unapplied.
 * 4. A background and a template are applied, saved to the person's preferences and survive a reload; the
 *    Classic style really turns the neon look off.
 * 5. An employee whose access covers only themselves gets no workspace overview.
 */
const { chromium } = require('playwright');

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.CREW_API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD');
const HR = 'hr.admin@demo.crew.local';
const EMPLOYEE = 'operator1@demo.crew.local';

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
let current;

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${email} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/status of 40[34]/.test(m.text()) && errs.push(`${email} ${m.text()}`));
  current = p;
  // Sign-in is rate limited per address (10 a minute); earlier flows in the same run can use that up.
  for (let attempt = 1; ; attempt++) {
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

async function apiToken(email) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    if (res.status === 429 && attempt < 5) { await new Promise((r) => setTimeout(r, 20000)); continue; }
    const j = await res.json();
    if (j.status !== 'ok') throw new Error(`${email} needs ${j.status ?? res.status} to sign in through the API; run on a fresh database`);
    return j.accessToken;
  }
}
async function api(token, method, path, body) {
  const res = await fetch(`${API}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const html = (p, attr) => p.evaluate((a) => document.documentElement.getAttribute(a), attr);
async function waitForHtml(p, attr, value) {
  await p.waitForFunction(([a, v]) => document.documentElement.getAttribute(a) === v, [attr, value], { timeout: 10000 });
}
/** The text a tile shows for a number, as the web formats it (whole numbers, or a percentage). */
const shown = (t) => (t.value === null ? '–' : t.unit === 'percent' ? `${Math.round(t.value * 10) / 10}%` : t.unit === 'days' ? `${t.value}d` : t.unit === 'money' ? null : new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(t.value));

(async () => {
  const b = await chromium.launch();
  try {
    const token = await apiToken(HR);
    // Start from the default look, whatever an earlier run left behind.
    await api(token, 'POST', '/me/preferences/appearance/reset');

    // 1. The neon shell and Home.
    const p = await signIn(b, HR);
    expect((await html(p, 'data-style')) === 'neon', 'the neon style should be the default');
    expect((await html(p, 'data-backdrop')) === 'aurora', 'the aurora background should be the default');
    const sidebarBg = await p.locator('aside.crew-sidebar').first().evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(sidebarBg.includes('gradient'), `the sidebar should be the dark gradient panel, got ${sidebarBg}`);
    const active = p.locator('aside.crew-sidebar a[aria-current="page"]').first();
    expect((await active.evaluate((el) => getComputedStyle(el).backgroundImage)).includes('gradient'), 'the active menu item should be a gradient pill');
    const tile = p.locator('[aria-label="Key figures"] .crew-tile').first();
    await tile.waitFor();
    expect((await tile.evaluate((el) => getComputedStyle(el).backgroundImage)).includes('linear-gradient'), 'KPI tiles should be gradient tiles');
    await p.getByRole('heading', { name: 'Workforce overview' }).waitFor();
    await p.getByRole('heading', { name: 'Department wise employees' }).waitFor();
    await p.getByRole('heading', { name: "Today's highlights" }).waitFor();
    ok('Home shows the neon sidebar, gradient KPI tiles, the workforce trend and department charts');

    // 2. Module overviews match the API's live numbers.
    const pages = [['/employees', 'employees', 'total'], ['/recruitment', 'recruitment', 'jobs'], ['/attendance', 'attendance', 'present'], ['/leave', 'leave', 'requests'], ['/reviews', 'performance', 'reviewed'], ['/learning', 'learning', 'courses'], ['/insights', 'analytics', 'headcount']];
    for (const [path, module, key] of pages) {
      const o = await api(token, 'GET', `/dashboard/modules/${module}`);
      expect(o.status === 200, `${module} overview: ${o.status} ${JSON.stringify(o.body)}`);
      await p.goto(BASE + path);
      const section = p.getByTestId(`overview-${module}`);
      await section.waitFor({ timeout: 15000 });
      const t = o.body.tiles.find((x) => x.key === key);
      const want = shown(t);
      const got = (await section.getByTestId(`tile-${key}`).innerText()).trim();
      expect(got === want, `${module}: tile ${key} shows ${got}, the API says ${want}`);
      expect((await section.locator('.crew-tile').count()) === o.body.tiles.length, `${module}: every tile is shown`);
      for (const c of o.body.charts) await section.getByRole('heading', { name: c.title, exact: true }).waitFor();
      ok(`${module} overview shows ${o.body.tiles.length} live tiles (${t.label}: ${got}) and its ${o.body.charts.length} charts`);
    }

    // 3. Preview without saving.
    await p.goto(BASE + '/');
    await p.getByRole('button', { name: 'Themes', exact: true }).click();
    const panel = p.getByTestId('theme-panel');
    await panel.waitFor();
    await panel.getByRole('radio', { name: 'Cyber' }).click();
    await waitForHtml(p, 'data-preset', 'cyber');
    await panel.getByRole('radio', { name: 'Gradient' }).click();
    await waitForHtml(p, 'data-backdrop', 'gradient');
    await panel.getByRole('button', { name: 'Close without applying' }).click();
    await waitForHtml(p, 'data-preset', 'midnight');
    await waitForHtml(p, 'data-backdrop', 'aurora');
    const untouched = (await api(token, 'GET', '/me/preferences')).body.appearance;
    expect(untouched.preset === 'midnight' && untouched.backdrop === 'aurora', 'closing without applying must not save anything');
    ok('Themes & Templates previews a theme live and closing it unapplied puts the saved look back');

    // 4. Apply a background, then a template; both persist.
    await p.getByRole('button', { name: 'Themes', exact: true }).click();
    await panel.waitFor();
    await panel.getByRole('radio', { name: 'Cosmos' }).click();
    await panel.getByRole('radio', { name: 'Primary colour #db2777' }).click();
    await panel.getByTestId('apply-theme').click();
    await panel.waitFor({ state: 'detached' });
    await p.reload();
    await waitForHtml(p, 'data-backdrop', 'cosmos');
    let saved = (await api(token, 'GET', '/me/preferences')).body.appearance;
    expect(saved.backdrop === 'cosmos' && saved.primary === '#db2777', `background and colour should be saved, got ${JSON.stringify(saved)}`);
    ok('a background and colour applied from the panel are saved and survive a reload');

    await p.getByRole('button', { name: 'Themes', exact: true }).click();
    await panel.getByRole('tab', { name: 'Templates' }).click();
    await panel.getByRole('radio', { name: 'Minimal Clean' }).click();
    await panel.getByTestId('apply-theme').click();
    await panel.waitFor({ state: 'detached' });
    await p.reload();
    await waitForHtml(p, 'data-style', 'classic');
    expect((await html(p, 'data-preset')) === 'monochrome', 'the template sets its theme');
    const flat = await p.locator('[aria-label="Key figures"] .crew-tile').first().evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(flat === 'none', `Classic tiles should be flat, got ${flat}`);
    saved = (await api(token, 'GET', '/me/preferences')).body.appearance;
    expect(saved.style === 'classic' && saved.preset === 'monochrome' && saved.backdrop === 'plain', `template should be saved, got ${JSON.stringify(saved)}`);
    ok('the Minimal Clean template switches to the Classic style, persists and really turns the neon look off');

    // Back to the default, so later flows and screenshots see the neon design.
    await api(token, 'POST', '/me/preferences/appearance/reset');

    // 5. Self-service only.
    const e = await signIn(b, EMPLOYEE);
    await e.goto(BASE + '/leave');
    await e.getByRole('heading', { name: 'Leave', level: 1 }).waitFor();
    expect((await e.getByTestId('overview-leave').count()) === 0, 'an employee must not see the workspace leave overview');
    const forbidden = await api(await apiToken(EMPLOYEE), 'GET', '/dashboard/modules/employees');
    expect(forbidden.status === 403, `an employee must get 403 for the employees overview, got ${forbidden.status}`);
    ok('an employee sees their own pages without any workspace overview');

    if (errs.length) throw new Error(`Browser errors:\n${errs.join('\n')}`);
    console.log('\nNeon design flow passed.');
  } catch (e) {
    if (current) await current.screenshot({ path: 'neon-flow-failure.png', fullPage: true }).catch(() => {});
    console.error(e);
    process.exitCode = 1;
  } finally {
    await b.close();
  }
})();
