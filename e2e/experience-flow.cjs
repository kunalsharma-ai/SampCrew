/**
 * Workspace experience end-to-end flow in the Web Portal, against the demo workspace:
 *   pnpm db:reset            # fresh demo workspace (operator2 and the supervisor must not have MFA enrolled)
 *   API on :4000, Web Portal on :3000, then: pnpm e2e:experience
 *
 * 1. An operator opens "Request time off" from the Create menu (the leave form opens straight away) and applies.
 * 2. Their supervisor sees it under "Needs your attention" on Home and approves it there with one click.
 * 3. The supervisor changes the theme in the Theme Studio (preset, mode, density): it applies without a reload,
 *    survives a reload, and follows them to a second browser (another device) from the database.
 * 4. Focus mode and the sidebar toggle by keyboard; a page is starred into Favourites; all three persist.
 * 5. The command palette finds a person on the team and switches theme by name.
 * 6. Home widgets are reordered and personal notes autosave; both survive a reload.
 */
const { chromium } = require('playwright');

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
let current;

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${email} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(`${email} ${m.text()}`));
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

const html = (p, attr) => p.evaluate((a) => document.documentElement.getAttribute(a), attr);
async function waitForHtml(p, attr, value) {
  await p.waitForFunction(([a, v]) => document.documentElement.getAttribute(a) === v, [attr, value], { timeout: 10000 });
}

/** A working day two weeks out, so it never collides with the Core HR flow's leave. */
function leaveDay() {
  const d = new Date();
  // Three weeks out: the demo seeds a pending leave for Arjun 8 to 14 days ahead.
  d.setUTCDate(d.getUTCDate() + 21);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) d.setUTCDate(d.getUTCDate() - 7);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

(async () => {
  const b = await chromium.launch();
  try {
    // 1. Request leave from the Create menu.
    const op = await signIn(b, 'operator2@demo.crew.local');
    await op.getByRole('button', { name: 'Create' }).click();
    await op.getByRole('menuitem', { name: 'Request time off' }).click();
    await op.waitForURL((u) => u.pathname === '/leave');
    await op.locator('dialog[open] select[name=leaveTypeId]').waitFor();
    expect(!op.url().includes('create='), 'the create parameter should be removed once the form opens');
    const cl = await op.$eval('dialog select[name=leaveTypeId]', (s) => [...s.options].find((o) => o.text.startsWith('Casual leave'))?.value);
    const day = leaveDay();
    await op.selectOption('dialog select[name=leaveTypeId]', cl);
    await op.fill('dialog input[name=startDate]', day);
    await op.fill('dialog input[name=endDate]', day);
    await op.fill('dialog textarea[name=reason]', 'Experience flow');
    await op.waitForSelector('dialog >> text=/1\\.00 working day/', { timeout: 10000 });
    await op.click('dialog >> text=Submit request');
    await op.waitForSelector('td >> text=Pending', { timeout: 10000 });
    ok(`operator opened the leave form from the Create menu and applied for ${day}`);

    // 2. The supervisor approves it from Home.
    const sup = await signIn(b, 'supervisor@demo.crew.local');
    const attention = sup.getByRole('region', { name: 'Needs your attention' });
    const item = attention.getByRole('listitem').filter({ hasText: `Neha Deshmukh: Casual leave, ${day}` });
    await item.waitFor();
    const approvals = sup.getByRole('link', { name: /^Pending approvals: [1-9]/ });
    await approvals.waitFor();
    await item.getByRole('button', { name: /^Approve:/ }).click();
    await item.getByText('Approved', { exact: true }).waitFor({ timeout: 10000 });
    await sup.goto(BASE + '/approvals');
    await sup.getByRole('heading', { name: 'Approvals' }).waitFor();
    expect((await sup.getByText(`Neha Deshmukh: Casual leave, ${day}`).count()) === 0, 'the approved request is still in the inbox');
    ok('supervisor approved the request from "Needs your attention" on Home');

    // 3. Theme Studio: changes apply live, persist, and follow the member to another browser.
    await sup.goto(BASE + '/settings/appearance');
    expect((await html(sup, 'data-preset')) === 'midnight', 'default preset should be Midnight Intelligence');
    await sup.evaluate(() => { window.__sameDocument = true; });
    await sup.getByRole('radiogroup', { name: 'Theme preset' }).getByRole('radio', { name: 'Emerald Command' }).click();
    await waitForHtml(sup, 'data-preset', 'emerald');
    await sup.getByRole('radiogroup', { name: 'Colour mode' }).first().getByRole('radio', { name: 'Dark' }).click();
    await waitForHtml(sup, 'data-theme', 'dark');
    await sup.getByRole('radiogroup', { name: 'Density' }).getByRole('radio', { name: 'Compact' }).click();
    await waitForHtml(sup, 'data-density', 'compact');
    await sup.getByText('Saved', { exact: true }).waitFor();
    expect(await sup.evaluate(() => window.__sameDocument === true), 'theme changes should not reload the page');
    const bg = await sup.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg === 'rgb(3, 20, 13)', `dark Emerald background expected, got ${bg}`);
    await sup.reload();
    expect((await html(sup, 'data-preset')) === 'emerald' && (await html(sup, 'data-theme')) === 'dark', 'theme lost on reload');
    const other = await signIn(b, 'supervisor@demo.crew.local');
    await waitForHtml(other, 'data-preset', 'emerald');
    await waitForHtml(other, 'data-density', 'compact');
    await other.context().close();
    current = sup;
    ok('Emerald Command, dark and compact applied without a reload, survived a reload and followed to a second browser');

    // 4. Keyboard toggles and favourites.
    await sup.keyboard.press('Control+.');
    await waitForHtml(sup, 'data-focus', 'on');
    await sup.keyboard.press('Control+.');
    await sup.waitForFunction(() => !document.documentElement.hasAttribute('data-focus'));
    await sup.keyboard.press('Control+b');
    await sup.getByRole('button', { name: 'Expand sidebar' }).waitFor();
    await sup.getByRole('button', { name: 'Add Leave to favourites' }).count().then((n) => expect(n === 0, 'favourite stars should hide in the icon rail'));
    await sup.getByRole('button', { name: 'Expand sidebar' }).click();
    await sup.getByRole('button', { name: 'Collapse sidebar' }).waitFor();
    await sup.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Leave', exact: true }).hover();
    await sup.getByRole('button', { name: 'Add Leave to favourites' }).click();
    const favs = sup.getByRole('list', { name: 'Favourites' });
    await favs.getByRole('link', { name: 'Leave' }).waitFor();
    await sup.waitForTimeout(500);
    await sup.reload();
    await favs.getByRole('link', { name: 'Leave' }).waitFor();
    ok('focus mode and the sidebar toggled by keyboard; Leave starred into Favourites and kept after a reload');

    // 5. Command palette: a person on the team, then a theme by name.
    const search = sup.getByRole('combobox', { name: 'Search pages' });
    // Right after a reload the shortcut can land before the page is hydrated, so press again until it opens.
    for (let i = 0; i < 10 && !(await search.isVisible()); i++) {
      await sup.keyboard.press('Control+k');
      await search.waitFor({ timeout: 1000 }).catch(() => {});
    }
    await search.fill('Arjun');
    const person = sup.getByRole('option', { name: /Arjun/ }).first();
    await person.waitFor({ timeout: 10000 });
    await person.click();
    await sup.waitForURL(/\/employees\/[0-9a-f-]{36}/);
    await sup.keyboard.press('Control+k');
    await search.fill('Aurora');
    await sup.getByRole('option', { name: /Theme: Aurora Glass/ }).waitFor();
    await sup.keyboard.press('Enter');
    await waitForHtml(sup, 'data-preset', 'aurora');
    ok('command palette found a team member and switched to Aurora Glass by name');

    // 6. Home layout and notes.
    await sup.goto(BASE + '/');
    await sup.getByRole('button', { name: 'Customize' }).click();
    for (let i = 0; i < 12; i++) {
      const up = sup.getByRole('button', { name: 'Move Personal notes up' });
      const before = await sup.locator('section[aria-label]').first().getAttribute('aria-label');
      if (before === 'Personal notes') break;
      await up.click();
    }
    await sup.getByRole('button', { name: 'Hide Your access' }).click();
    await sup.getByRole('button', { name: 'Save layout' }).click();
    await sup.getByText('Layout saved').waitFor();
    const note = `Check rota for line 2 (${Date.now() % 100000})`;
    await sup.getByRole('textbox', { name: 'Your notes' }).fill(note);
    await sup.getByText(/^Saved \d/).waitFor({ timeout: 10000 });
    await sup.reload();
    expect((await sup.locator('section[aria-label]').first().getAttribute('aria-label')) === 'Personal notes', 'widget order lost on reload');
    expect((await sup.getByRole('region', { name: 'Your access' }).count()) === 0, 'hidden widget shown after reload');
    expect((await sup.getByRole('textbox', { name: 'Your notes' }).inputValue()) === note, 'notes lost on reload');
    ok('Home widgets reordered and hidden, notes autosaved, all kept after a reload');

    // Leave the supervisor on the default appearance for the flows that follow.
    await sup.goto(BASE + '/settings/appearance');
    await sup.getByRole('button', { name: 'Reset to default' }).click();
    await waitForHtml(sup, 'data-preset', 'midnight');

    if (errs.length) throw new Error('browser errors:\n' + errs.join('\n'));
    console.log('experience flow: all checks passed');
  } catch (e) {
    if (current) await current.screenshot({ path: process.env.SHOT ?? '/tmp/experience-fail.png', fullPage: true }).catch(() => undefined);
    throw e;
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
