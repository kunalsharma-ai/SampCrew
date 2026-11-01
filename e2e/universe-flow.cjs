/**
 * Workforce Universe, end to end in the Web Portal, against the demo workspace:
 *   pnpm db:reset; API on :4000, Web Portal on :3000, then: pnpm e2e:universe
 *
 * 1. HR opens the 2D table: headcount per department adds up to the headcount today.
 * 2. Going back to January 2024, Rekha Jadhav is in Quality Assurance; after her transfer on 1 April 2024 she is
 *    on the Assembly Line, and the change list shows the move. Both views read the employment records in the database.
 * 3. The 3D map draws (WebGL), a department picked in the 2D table stays selected there, and Play moves the timeline.
 * 4. The 3D code (three.js) is a separate download, fetched only when the 3D view is opened.
 */
const { chromium } = require('playwright');

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  // SwiftShader gives headless Chromium a software WebGL implementation.
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/WebGL|GPU stall|GL Driver/i.test(m.text()) && errs.push(m.text()));
  const scripts = [];
  p.on('response', (r) => r.url().endsWith('.js') && scripts.push(r.url()));
  try {
    for (let attempt = 1; ; attempt++) {
      await p.goto(BASE + '/login');
      await p.fill('input[name=email]', 'hr.admin@demo.crew.local');
      await p.fill('input[name=password]', PASSWORD);
      await p.click('button[type=submit]');
      const r = await Promise.race([
        p.waitForURL((u) => u.pathname === '/', { timeout: 15000 }).then(() => 'in'),
        p.locator('text=Too many requests').waitFor({ timeout: 15000 }).then(() => 'limited'),
      ]);
      if (r === 'in') break;
      if (attempt >= 4) throw new Error('sign-in stayed rate limited');
      await p.waitForTimeout(20000);
    }

    // 1. Headcount adds up.
    await p.goto(BASE + '/employees');
    await p.getByRole('link', { name: 'Workforce Universe' }).click();
    await p.waitForURL(/\/insights\/universe/);
    await p.getByRole('radio', { name: '2D table' }).click();
    const table = p.getByRole('table');
    await table.waitFor();
    const total = Number(await p.getByText(/^Headcount on /).locator('xpath=../following-sibling::div[1]').innerText());
    const counts = await table.locator('tbody tr td:nth-child(2)').allInnerTexts();
    const sum = counts.reduce((a, c) => a + Number(c), 0);
    expect(total > 10 && sum === total, `departments add up to ${sum}, headcount ${total}`);
    ok(`2D table: ${counts.length} departments add up to the headcount of ${total}`);

    // 2. Time travel.
    const slider = p.getByRole('slider', { name: 'Date' });
    const deptRow = (name) => table.getByRole('row').filter({ has: p.getByRole('button', { name, exact: true }) });
    await p.goto(BASE + '/insights/universe?view=2d&on=2024-01-31');
    expect((await slider.getAttribute('aria-valuetext')).includes('2024'), 'slider did not open on the date in the address');
    await deptRow('Quality Assurance').getByRole('button').click();
    const panel = p.getByRole('region', { name: /^Quality Assurance on / }).or(p.locator('[aria-label^="Quality Assurance on "]'));
    await panel.getByRole('link', { name: 'Rekha Jadhav' }).waitFor();
    ok('January 2024: Rekha Jadhav is in Quality Assurance');
    const qaJan = Number(await deptRow('Quality Assurance').locator('td').nth(1).innerText());
    // Three months on: 30 April 2024.
    for (let k = 0; k < 3; k++) await slider.press('ArrowRight');
    expect((await slider.getAttribute('aria-valuetext')).match(/Apr(il)? 30, 2024|30 Apr(il)? 2024/), `slider at ${await slider.getAttribute('aria-valuetext')}`);
    expect(await panel.getByRole('link', { name: 'Rekha Jadhav' }).count() === 0, 'Rekha still listed in Quality Assurance after her move');
    expect(Number(await deptRow('Quality Assurance').locator('td').nth(1).innerText()) === qaJan - 1, 'Quality Assurance headcount did not drop');
    const changesCard = p.locator('[aria-label="Changes"]');
    await changesCard.getByText('Rekha Jadhav').first().waitFor();
    expect(/Moved\s*Rekha Jadhav\s*Quality Assurance to Assembly Line/.test(await changesCard.innerText()), 'move not in the change list');
    await deptRow('Assembly Line').getByRole('button').click();
    await p.locator('[aria-label^="Assembly Line on "]').getByRole('link', { name: 'Rekha Jadhav' }).waitFor();
    ok('April 2024: she moved to the Assembly Line, and the change list says so');

    // 3 and 4. 3D, loaded on demand.
    const before = scripts.length;
    await p.getByRole('radio', { name: '3D map' }).click();
    await p.locator('[data-testid=universe-3d] [data-ready=true] canvas').waitFor({ timeout: 30000 });
    const box = await p.locator('[data-testid=universe-3d] canvas').boundingBox();
    expect(box && box.width > 400 && box.height > 300, 'canvas too small');
    const three = scripts.slice(before).length;
    expect(three > 0, 'no script loaded for the 3D view');
    await p.locator('[aria-label^="Assembly Line on "]').waitFor();
    ok('3D map drawn with WebGL; the selected department stays selected');
    await slider.press('Home');
    const start = await slider.getAttribute('aria-valuenow') ?? await slider.inputValue();
    await p.getByRole('button', { name: 'Play timeline' }).click();
    await p.waitForTimeout(2500);
    const after = await slider.inputValue();
    expect(Number(after) > Number(start), `timeline did not move (${start} -> ${after})`);
    await p.getByRole('button', { name: 'Pause timeline' }).click();
    ok(`play moved the timeline from stop ${start} to ${after}`);

    const real = errs.filter((e) => !/favicon|DevTools/.test(e));
    expect(!real.length, `browser errors:\n${real.join('\n')}`);
    console.log('universe flow passed');
  } catch (e) {
    console.error(e);
    await p.screenshot({ path: 'universe-flow-failure.png', fullPage: true }).catch(() => {});
    console.error(errs.join('\n'));
    process.exitCode = 1;
  } finally {
    await b.close();
  }
})();
