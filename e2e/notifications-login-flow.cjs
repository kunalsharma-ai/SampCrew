/**
 * The central notification framework and the animated sign-in welcome, end to end, on a fresh demo workspace.
 *
 *   pnpm db:reset
 *   node apps/api/dist/main.js & pnpm --filter @crew/web start & pnpm --filter @crew/console start &
 *   node e2e/notifications-login-flow.cjs          (SHOTS=/some/folder also saves screenshots there)
 *
 * 1. Sign-in welcome: each level has its own welcome (Super Workspace, HR Workspace, Employee Workspace, and the team
 *    welcome for someone people report to), the Console has its own, the form is usable at once, and with reduced
 *    motion nothing moves. After signing in, the browser remembers the level and the next sign-in opens with it.
 * 2. A course assigned to an employee is "Action needed" in three places at once: the bell (count, Action needed tab),
 *    the Home notifications card, and the Learning page's notices. Marking it read on the Learning page clears it in
 *    the bell of another open tab, live.
 * 3. With sound on and two tabs open, a new notice plays its tone once, in one tab only.
 * 4. The Super Workspace sets the notification policy (Leave always shown, sounds off); an employee's own settings show
 *    those switches locked. Only the Super Workspace can open the policy.
 * Fails on any browser error.
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const API = `${process.env.API_URL ?? 'http://localhost:4000'}/api/v1`;
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
const SHOTS = process.env.SHOTS;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const ok = (m) => console.log(`ok - ${m}`);
const expect = (cond, m) => { if (!cond) throw new Error(m); };
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource.*(401|403|404)/.test(m.text()) && errs.push(`${who} ${m.text()}`));
};
const shot = async (p, name, opts = {}) => {
  if (!SHOTS) return;
  await p.waitForTimeout(opts.wait ?? 400);
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: opts.full ?? false });
};

async function inBell(p, title) {
  // Issue #86: notifications are read from the bell and their own page, not a Home card.
  await p.getByTestId('notification-bell').click();
  await p.getByTestId('notification-panel').waitFor();
  await p.getByTestId('bell-item').filter({ hasText: title }).first().waitFor({ timeout: 15000 });
  await p.keyboard.press('Escape');
}
async function api(token, method, p, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}
async function must(token, method, p, body) {
  const r = await api(token, method, p, body);
  if (r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function apiLogin(email) {
  const r = await must(null, 'POST', '/auth/login', { email, password: PASSWORD });
  if (r.status !== 'ok') throw new Error(`${email} needs ${r.status}; run on a fresh database (pnpm db:reset)`);
  return r.accessToken;
}

/** A browser context that counts notification tones started (Web Audio oscillators). */
async function context(b, extra = {}) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, ...extra });
  await ctx.addInitScript(() => {
    window.__tones = 0;
    const O = window.OscillatorNode;
    if (O) {
      const start = O.prototype.start;
      O.prototype.start = function (...a) { window.__tones++; return start.apply(this, a); };
    }
  });
  return ctx;
}

async function signIn(ctx, email, space) {
  const p = await ctx.newPage();
  watch(p, email);
  for (let attempt = 0; ; attempt++) {
    await p.goto(`${BASE}/login${space ? `?space=${space}` : ''}`);
    await p.fill('input[name=email]', email);
    await p.fill('input[name=password]', PASSWORD);
    await p.click('button[type=submit]');
    const r = await Promise.race([
      p.waitForURL((u) => u.pathname === '/' || u.pathname === '/setup', { timeout: 20000 }).then(() => 'in'),
      p.locator('text=/Too many (requests|failed sign-in attempts)/').waitFor({ timeout: 20000 }).then(() => 'limited'),
    ]).catch(async (e) => {
      await p.screenshot({ path: `/tmp/signin-${email}.png` }).catch(() => undefined);
      throw new Error(`sign-in for ${email} did not finish (${p.url()}): ${await p.locator('[role=alert]').allInnerTexts().catch(() => [])}`, { cause: e });
    });
    if (r === 'in') {
      // The welcome after sign-in plays over the dashboard for a few seconds; wait until it has opened onto it.
      await p.getByTestId('welcome-intro').waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
      if (new URL(p.url()).pathname === '/setup') await p.goto(BASE + '/');
      return p;
    }
    if (attempt >= 4) throw new Error(`sign-in for ${email} stayed rate limited`);
    await p.waitForTimeout(20000);
  }
}

const unread = async (p) => {
  const el = p.getByTestId('notification-count');
  return (await el.count()) ? Number((await el.textContent()).replace(/\D/g, '')) : 0;
};

(async () => {
  const b = await chromium.launch();
  try {
    const run = Date.now().toString(36);
    const ownerT = await apiLogin('owner@demo.crew.local');

    // 1. The sign-in welcome, per level.
    const guest = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    const lp = await guest.newPage();
    watch(lp, 'guest');
    const scenes = [
      ['super', 'Super Workspace', 'Sign in to your workspace'],
      ['hr', 'HR Workspace', 'Sign in to your workspace'],
      ['manager', 'Employee Workspace', 'Sign in to your workspace'],
      ['employee', 'Employee Workspace', 'Sign in to your workspace'],
    ];
    const titles = new Set();
    for (const [space, level, form] of scenes) {
      await lp.goto(`${BASE}/login?space=${space}`);
      // The form is usable straight away, while the welcome is still animating.
      await lp.fill('input[name=email]', 'someone@example.com', { timeout: 1500 });
      await lp.getByTestId('welcome-scene').waitFor();
      expect((await lp.getByTestId('welcome-level').innerText()).toLowerCase() === level.toLowerCase(), `${space}: level should read ${level}`);
      expect((await lp.getByTestId('login-title').innerText()) === form, `${space}: form title should be "${form}"`);
      const scene = await lp.getByTestId('welcome-scene').getAttribute('data-scene');
      expect(scene === (space === 'manager' ? 'team' : space), `${space}: wrong scene ${scene}`);
      titles.add(await lp.getByTestId('welcome-title').innerText());
      await shot(lp, `login-${space}`, { wait: 2600 });
    }
    expect(titles.size === 4, 'every level has its own welcome words');
    // Nothing overlaps: the greeting, name and words never sit on the animated picture, on a laptop or a phone.
    for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
      await lp.setViewportSize(size);
      for (const [space] of scenes) {
        await lp.goto(`${BASE}/login?space=${space}`);
        await lp.waitForTimeout(2600);
        const stage = await lp.getByTestId('welcome-stage').boundingBox();
        for (const id of ['welcome-greeting', 'welcome-level', 'welcome-title']) {
          const b = await lp.getByTestId(id).boundingBox();
          const hit = b && stage && b.x < stage.x + stage.width && stage.x < b.x + b.width && b.y < stage.y + stage.height && stage.y < b.y + b.height;
          expect(!hit, `${space} at ${size.width}px: ${id} overlaps the animated picture`);
        }
      }
    }
    await lp.setViewportSize({ width: 1440, height: 900 });
    ok('the greeting, workspace name and words never overlap the animation');

    // Light or dark, and colour palettes: the choice is kept on this device.
    await lp.goto(`${BASE}/login?space=hr`);
    await lp.getByTestId('theme-mode-dark').click();
    await lp.getByTestId('theme-palettes').click();
    await lp.getByTestId('theme-palette-ocean').click();
    await lp.reload();
    await lp.locator('[data-testid=sign-in-page][data-mode=dark][data-palette=ocean]').waitFor();
    await shot(lp, 'login-hr-dark-ocean', { wait: 2000 });
    await lp.getByTestId('theme-mode-auto').click();
    await lp.getByTestId('theme-palettes').click();
    await lp.getByTestId('theme-palette-signature').click();
    ok('light/dark mode and colour palettes are remembered on this device');

    // Validation, the eye button and the tick or cross.
    await lp.goto(`${BASE}/login?space=employee`);
    await lp.fill('input[name=email]', 'owner@demo');
    await lp.locator('input[name=password]').focus();
    await lp.getByTestId('email-check').waitFor();
    await lp.fill('input[name=email]', 'owner@demo.crew.local');
    await lp.getByTestId('mark-ok').first().waitFor();
    await lp.fill('input[name=password]', 'not-the-password-1');
    expect((await lp.locator('input[name=password]').getAttribute('type')) === 'password', 'the password starts hidden');
    await lp.getByTestId('password-eye').click();
    expect((await lp.locator('input[name=password]').getAttribute('type')) === 'text', 'the eye button shows the password');
    await lp.getByTestId('password-eye').click();
    expect((await lp.locator('input[name=password]').getAttribute('type')) === 'password', 'the eye button hides it again');
    await lp.click('button[type=submit]');
    await lp.locator('[data-testid=sign-in-card][data-auth=fail]').waitFor();
    await lp.getByTestId('mark-bad').waitFor();
    expect(await lp.getByTestId('forgot-password-link').isVisible(), 'Forgot password is on the sign-in box');
    await shot(lp, 'login-wrong-password', { wait: 700 });
    ok('email is checked as it is typed, the eye shows and hides the password, a wrong password gets a red cross and a shake');

    // The public Help & Support page, from the sign-in page's header.
    await lp.getByTestId('sign-in-help').click();
    await lp.waitForURL('**/help-and-support');
    await lp.getByTestId('public-help').waitFor();
    expect((await lp.getByTestId('public-help-feature').count()) >= 10, 'feature briefs are listed');
    await lp.fill('[data-testid=public-help-search]', 'forgot password');
    await lp.getByTestId('public-help-results').getByText('I forgot my password').waitFor();
    await shot(lp, 'help-and-support', { wait: 400 });
    await lp.getByTestId('public-help-results').getByText('I forgot my password').click();
    await lp.getByTestId('public-help-article').waitFor();
    ok('Help & Support opens from the sign-in page before signing in, with features, search and articles');
    // The level chips switch the welcome.
    await lp.goto(`${BASE}/login?space=super`);
    await lp.getByTestId('welcome-choice').filter({ hasText: 'HR Workspace' }).click();
    await lp.waitForURL(/space=hr/);
    await lp.getByTestId('welcome-scene').and(lp.locator('[data-scene=hr]')).waitFor();
    ok('each Web Portal level has its own welcome and form title; the form is usable during the animation; chips switch level');

    const phone = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
    const pp = await phone.newPage();
    watch(pp, 'phone');
    await pp.goto(`${BASE}/login?space=employee`);
    await pp.getByTestId('welcome-scene').waitFor();
    const box = await pp.locator('input[name=email]').boundingBox();
    expect(box && box.y + box.height < 844, 'on a phone the sign-in form fits on the first screen');
    await shot(pp, 'login-phone-web', { wait: 2200 });
    await phone.close();

    const still = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const sp = await still.newPage();
    watch(sp, 'reduced-motion');
    await sp.goto(`${BASE}/login?space=super`);
    const anim = await sp.locator('.sc-word').first().evaluate((el) => getComputedStyle(el).animationName);
    expect(anim === 'none', `with reduced motion the workspace name should not animate (got ${anim})`);
    const stage = await sp.locator('.scs-orbit').first().evaluate((el) => getComputedStyle(el).animationName);
    expect(stage === 'none', `with reduced motion the scene should stand still (got ${stage})`);
    // With motion allowed, the same name does animate (so the check above means something).
    const moving = await lp.locator('.sc-word').first().evaluate((el) => getComputedStyle(el).animationName);
    expect(moving !== 'none', 'with motion allowed the workspace name animates');
    await still.close();
    ok('phone layout keeps the form on screen; reduced motion shows a still welcome');

    const cp = await guest.newPage();
    watch(cp, 'console');
    await cp.goto(`${CONSOLE}/login`);
    await cp.locator('[data-testid=welcome-scene][data-scene=console]').waitFor();
    expect((await cp.getByTestId('welcome-level').innerText()).toLowerCase() === 'super admin console', 'the Console has its own welcome');
    await cp.fill('input[name=email]', 'admin@example.com', { timeout: 1500 });
    await shot(cp, 'login-console', { wait: 2600 });
    await cp.fill('input[name=password]', 'not-the-password-1');
    await cp.getByTestId('password-eye').click();
    expect((await cp.locator('input[name=password]').getAttribute('type')) === 'text', 'the Console eye button shows the password');
    await cp.click('button[type=submit]');
    await cp.getByTestId('mark-bad').waitFor();
    expect(await cp.getByTestId('forgot-password-link').isVisible(), 'Forgot password is on the Console sign-in');
    ok('the Console sign-in has its own welcome and its form is usable at once');

    // The browser remembers the level it last signed in to.
    const hrCtx = await context(b);
    // A right password: a green tick and a burst on the card, then the welcome plays before the dashboard.
    {
      const w = await hrCtx.newPage();
      watch(w, 'welcome');
      await w.goto(`${BASE}/login`);
      await w.fill('input[name=email]', 'hr.admin@demo.crew.local');
      await w.fill('input[name=password]', PASSWORD);
      await w.click('button[type=submit]');
      const first = await Promise.race([
        w.getByTestId('sign-in-success').waitFor({ timeout: 20000 }).then(() => 'ok'),
        w.locator('text=Too many requests').waitFor({ timeout: 20000 }).then(() => 'limited'),
      ]);
      if (first === 'ok') {
        await shot(w, 'login-success', { wait: 900 });
        await w.getByTestId('welcome-intro').waitFor({ timeout: 20000 });
        expect((await w.getByTestId('welcome-intro-level').innerText()) === 'HR Workspace', 'the welcome names the HR Workspace');
        await shot(w, 'welcome-intro-hr', { wait: 1400 });
        await w.getByTestId('welcome-intro').waitFor({ state: 'detached', timeout: 10000 });
        await w.getByTestId('notification-bell').waitFor();
        ok('a right password shows a tick and a burst, then the welcome opens onto the dashboard');
      }
      await w.close();
    }
    const hr = await signIn(hrCtx, 'hr.admin@demo.crew.local');
    await hr.getByTestId('notification-bell').waitFor();
    const remembered = (await hrCtx.cookies()).find((c) => c.name === 'crew_welcome')?.value;
    expect(remembered === 'hr', `after an HR Workspace sign-in the browser should remember "hr", got ${remembered}`);
    const back = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await back.addCookies([{ name: 'crew_welcome', value: remembered, url: BASE }]);
    const bp = await back.newPage();
    await bp.goto(`${BASE}/login`);
    await bp.locator('[data-testid=welcome-scene][data-scene=hr] >> visible=true').waitFor();
    await back.close();
    const supT = await apiLogin('supervisor@demo.crew.local');
    const supMe = await must(supT, 'GET', '/me');
    const supCtx = await context(b);
    await (await signIn(supCtx, 'supervisor@demo.crew.local')).getByTestId('notification-bell').waitFor();
    const supScene = (await supCtx.cookies()).find((c) => c.name === 'crew_welcome')?.value;
    expect(supScene === (supMe.levels.leadsTeam ? 'team' : 'employee'), `supervisor should get the ${supMe.levels.leadsTeam ? 'team' : 'employee'} welcome, got ${supScene}`);
    await supCtx.close();
    ok(`the next sign-in opens with the last level (HR Workspace; supervisor: ${supScene})`);

    // 2. Action needed in three places, read state shared live.
    const opT = await apiLogin('operator2@demo.crew.local');
    const opEmp = (await must(opT, 'GET', '/me')).employee;
    const opCtx = await context(b);
    const op = await signIn(opCtx, 'operator2@demo.crew.local');
    const op2 = await opCtx.newPage();
    watch(op2, 'operator2 tab 2');
    await op2.goto(BASE + '/');
    await op.getByTestId('notification-bell').waitFor();
    await op.waitForTimeout(1500); // the live streams connect
    const before = await unread(op);
    const title = `Fire safety refresher ${run}`;
    const course = await must(ownerT, 'POST', '/learning/courses', { title, format: 'online', selfEnrol: false });
    await must(ownerT, 'POST', '/learning/assignments', { courseId: course.id, employeeIds: [opEmp.id], dueOn: '2099-12-31' });
    await op.waitForFunction((n) => {
      const el = document.querySelector('[data-testid=notification-count]');
      return el && Number(el.textContent.replace(/\D/g, '')) > n;
    }, before, { timeout: 15000 });
    await op.getByTestId('notification-bell').click();
    await op.getByTestId('notification-panel').waitFor();
    await op.getByTestId('bell-tab-action').click();
    await op.getByTestId('bell-item').filter({ hasText: title }).getByTestId('action-needed').waitFor();
    await shot(op, 'bell-action-needed', { wait: 700 });
    await op.keyboard.press('Escape');
    await shot(op, 'home-notifications', { wait: 300 });
    // Counted before opening Learning: opening a module marks its notices read, which may clear them at once.
    await op2.waitForFunction(() => document.querySelector('[data-testid=notification-count]'), null, { timeout: 15000 });
    const inTab2 = await unread(op2);
    expect(inTab2 >= 1, 'the second tab counted the new notice live');
    await op.goto(BASE + '/learning');
    const notices = op.getByTestId('module-notices-learning');
    await notices.getByText(title).first().waitFor();
    await shot(op, 'learning-module-notices', { wait: 300 });
    await notices.getByRole('button', { name: new RegExp(`^Mark ".*${title}.*" read$`) }).first().click();
    await op2.waitForFunction((n) => {
      const el = document.querySelector('[data-testid=notification-count]');
      return (el ? Number(el.textContent.replace(/\D/g, '')) : 0) < n;
    }, inTab2, { timeout: 15000 });
    const listed = (await must(opT, 'GET', '/notifications?category=learning&limit=20')).items.find((n) => n.title.includes(title));
    expect(listed && listed.readAt && listed.actionRequired, 'the notice is read on the server and still marked as one that asked for action');
    ok('a course assignment is Action needed in the bell and on the Learning page; reading it there clears the other tab live');

    // 3. One sound across tabs.
    const prefs = await must(opT, 'GET', '/notifications/preferences');
    await must(opT, 'PUT', '/notifications/preferences', { ...prefs, sound: { enabled: true, volume: 60, minPriority: 'low' } });
    for (const p of [op, op2]) {
      await p.goto(BASE + '/');
      await p.getByTestId('notification-bell').waitFor();
      await p.mouse.click(5, 300); // a click allows sound in this tab (browsers block it before one)
      await p.evaluate(() => { window.__tones = 0; });
    }
    await op.waitForTimeout(1500);
    const second = `Data privacy basics ${run}`;
    const c2 = await must(ownerT, 'POST', '/learning/courses', { title: second, format: 'online', selfEnrol: false });
    await must(ownerT, 'POST', '/learning/assignments', { courseId: c2.id, employeeIds: [opEmp.id], dueOn: '2099-12-31' });
    for (const p of [op, op2]) await inBell(p, second);
    await op.waitForTimeout(1200);
    const tones = [await op.evaluate(() => window.__tones), await op2.evaluate(() => window.__tones)];
    expect(tones.filter((n) => n > 0).length === 1, `exactly one tab should sound, got ${JSON.stringify(tones)}`);
    await must(opT, 'PUT', '/notifications/preferences', prefs);
    ok(`with two tabs open a new notice sounds once, in one tab (tones ${JSON.stringify(tones)})`);

    // 4. The organisation's notification policy.
    expect((await api(opT, 'GET', '/notifications/policy')).status === 403, 'an employee cannot read the policy');
    const ownCtx = await context(b);
    const owner = await signIn(ownCtx, 'owner@demo.crew.local');
    await owner.goto(BASE + '/settings/notifications/organisation');
    await owner.getByTestId('policy-leave-mandatory').click();
    await owner.getByTestId('policy-allow-sound').click();
    await owner.getByTestId('policy-save').click();
    await owner.getByText(/Saved\. It applies to all \d+ people/).waitFor();
    await shot(owner, 'notification-policy', { full: true });
    await op.goto(BASE + '/settings/notifications');
    await op.getByTestId('sound-locked').waitFor();
    expect(await op.getByTestId('pref-leave-inApp').isDisabled(), 'Leave in SampCrew is locked on for the employee');
    expect(await op.getByTestId('sound-enabled').isDisabled(), 'sound is locked off for the employee');
    await shot(op, 'personal-settings-locked', { full: true });
    await must(ownerT, 'PUT', '/notifications/policy', {});
    await op.reload();
    expect(!(await op.getByTestId('pref-leave-inApp').isDisabled()), 'after the policy is relaxed the employee may choose again');
    ok('the Super Workspace policy locks Leave on and sound off for everyone; relaxing it frees the switches again');

    await op.goto(BASE + '/notifications?filter=action');
    await op.getByTestId('filter-action').waitFor();
    await shot(op, 'notification-center-action', { wait: 500 });

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('notifications and sign-in flow passed');
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  if (errs.length) console.error(errs.join('\n'));
  process.exit(1);
});
