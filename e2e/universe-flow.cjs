/**
 * Workforce Universe, end to end in the Web Portal, against the demo workspace:
 *   pnpm db:reset; API on :4000, Web Portal on :3000, then: pnpm e2e:universe
 *
 * 1. HR opens the 2D table: headcount per department adds up to the headcount today.
 * 2. Going back to January 2024, Rekha Jadhav is in Quality Assurance; after her transfer on 1 April 2024 she is
 *    on the Assembly Line, and the change list shows the move. Both views read the employment records in the database.
 * 3. The 3D map draws (WebGL), a department picked in the 2D table stays selected there, and Play moves the timeline.
 * 4. The 3D code (three.js) is a separate download, fetched only when the 3D view is opened.
 * 5. Locations: a globe with a dot per location, which turns; the table adds up.
 * 6. Skills: HR adds a skill on a profile and the skills network shows who holds it.
 *    The skill list: HR adds a skill, merges the new one into it and gives it a category; all kept after a reload.
 * 7. Recruitment flow: stage by stage, drawn and tabled.
 * 8. Scenarios: a what-if plan with a month and attrition is projected, saved, reopened after a reload and deleted;
 *    the plant head raises draft requisitions from the demo scenario, once, opens one, names the skills it needs
 *    and sees people already here who have them.
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

    // 5. Locations: the globe draws each location with people, and the table adds up to the headcount.
    const lens = (name) => p.getByRole('tablist', { name: 'Lens' }).getByRole('tab', { name, exact: true });
    await lens('Locations').click();
    await p.waitForURL(/lens=locations/);
    const locTable = p.getByRole('table', { name: 'Headcount by location' });
    await locTable.waitFor();
    const locCounts = (await locTable.locator('tbody tr td:nth-child(2)').allInnerTexts()).map(Number);
    await p.locator('path[data-land]').waitFor();
    expect(((await p.locator('path[data-land]').getAttribute('d')) ?? '').length > 1000, 'no coastlines on the globe');
    const pune = p.locator('[data-location="Pune Plant"] circle').last();
    await pune.waitFor();
    const x0 = await pune.getAttribute('cx');
    await p.getByRole('button', { name: 'Turn the globe east' }).click();
    expect((await pune.getAttribute('cx')) !== x0 || (await p.locator('[data-location="Pune Plant"]').count()) === 0, 'globe did not turn');
    expect(locCounts.reduce((a, b) => a + b, 0) > 0, 'no one placed on the globe');
    ok(`globe with coastlines; globe and table show ${locCounts.length} locations, ${locCounts.reduce((a, b) => a + b, 0)} people`);

    // 6. Skills: HR records a skill on a profile; the network and its table pick it up.
    await p.goto(BASE + '/employees?q=Rekha');
    await p.getByRole('link', { name: /Rekha Jadhav/ }).first().click();
    await p.waitForURL(/\/employees\/[0-9a-f-]{36}/);
    const skillsCard = p.locator('[aria-label="Skills"]');
    await skillsCard.getByRole('button', { name: 'Edit skills' }).click();
    const dlg = p.locator('dialog[open]').filter({ hasText: 'Edit skills' });
    await dlg.getByRole('button', { name: 'Add a skill' }).click();
    const n = await dlg.getByRole('textbox').count();
    await dlg.getByLabel(`Skill ${n}`, { exact: true }).fill('Robot welding');
    await dlg.getByLabel(`Level of skill ${n}`).selectOption({ label: 'Expert' });
    await dlg.getByRole('button', { name: 'Save skills' }).click();
    await skillsCard.getByText('Robot welding').waitFor();
    await p.reload();
    await skillsCard.getByText('Robot welding').waitFor();
    await p.goto(BASE + '/insights/universe?lens=skills');
    const skillRow = p.getByRole('table', { name: 'Skills summary' }).getByRole('row').filter({ hasText: 'Robot welding' });
    await skillRow.getByText('1 strong').waitFor();
    await skillRow.click();
    await p.locator('[aria-label="Who holds Robot welding"]').getByRole('link', { name: 'Rekha Jadhav' }).waitFor();
    expect(await p.locator('[data-skill="Robot welding"]').count() === 1, 'skill not drawn in the network');
    ok('added Robot welding (Expert) to Rekha; the skills network shows her as its only strong holder');

    // The skill list: add "Welding", merge "Robot welding" into it, give it a category; kept after a reload.
    const list = p.locator('[aria-label="Skill list"]');
    await list.getByLabel('New skill name').fill('Welding');
    await list.getByRole('button', { name: 'Add skill' }).click();
    await p.getByText('Skill added.').waitFor();
    await list.getByLabel('Merge Robot welding into').selectOption({ label: 'Welding' });
    p.once('dialog', (d) => d.accept());
    await list.getByRole('button', { name: 'Merge Robot welding' }).click();
    await p.getByText('Skills merged.').waitFor();
    await list.getByLabel('Name of Robot welding').waitFor({ state: 'detached' });
    await list.getByLabel('Category of Welding').fill('Shop floor');
    await list.getByRole('button', { name: 'Save Welding' }).click();
    await p.getByText('Skill saved.').waitFor();
    await p.reload();
    const weld = p.locator('table[aria-label="Skills in this workspace"] tbody tr').filter({ has: p.getByLabel('Name of Welding') });
    expect(await weld.getByLabel('Category of Welding').inputValue() === 'Shop floor', 'category not kept');
    expect((await weld.locator('td').nth(2).innerText()).trim() === '1', 'Rekha should hold Welding after the merge');
    expect(await p.locator('[data-skill="Robot welding"]').count() === 0, 'merged skill still drawn');
    ok('added Welding, merged Robot welding into it (Rekha moved over) and filed it under Shop floor');

    // 7. Recruitment flow over all time: the first stage is reached by every application.
    await lens('Recruitment flow').click();
    await p.getByRole('tab', { name: 'All time' }).click();
    await p.waitForURL(/period=all/);
    const flowTable = p.getByRole('table', { name: 'Recruitment flow by stage' });
    const applied = Number(await flowTable.locator('tbody tr').first().locator('td').nth(1).innerText());
    expect(applied > 0, 'no applications in the flow');
    expect(await p.locator('[data-stage]').count() === await flowTable.locator('tbody tr').count(), 'flow chart and table disagree');
    ok(`recruitment flow drawn: ${applied} applications reached the first stage`);

    // 8. Scenarios: plan two more people in Finance, save, find it after a reload, then delete it.
    await lens('Scenarios').click();
    await p.locator('[aria-label="Saved scenarios"]').getByRole('button', { name: 'New', exact: true }).click();
    await p.getByLabel(/^Scenario name/).fill('E2E: Finance growth');
    await p.getByRole('button', { name: 'One more in Finance' }).click();
    await p.getByRole('button', { name: 'One more in Finance' }).click();
    const now = new Date();
    const inThree = `${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 1)).toISOString().slice(0, 7)}`;
    await p.getByLabel('Month of the change in Finance').fill(inThree);
    await p.getByLabel('Role added in Finance').fill('Financial Analyst');
    await p.getByLabel(/^Attrition per year/).fill('10');
    await p.getByLabel(/^Months ahead/).selectOption('18');
    await p.getByText('Month by month').click();
    const projRows = p.locator('table[aria-label="Projection by month"] tbody tr');
    expect(await projRows.count() === 18, `projection has ${await projRows.count()} months`);
    const planned = await projRows.evaluateAll((rs) => rs.map((r) => Number(r.children[1].textContent)));
    expect(planned[3] === planned[0] + 2 && planned[2] === planned[0], `plan should add 2 in month 4: ${planned.slice(0, 5)}`);
    const expectedEnd = Number(await projRows.last().locator('td').nth(2).innerText());
    expect(expectedEnd < planned.at(-1), 'attrition should bring expected below planned');
    expect((await p.locator('path[data-line="expected"]').getAttribute('d')).split('L').length === 18, 'chart should draw 18 months');
    const finRow = p.getByRole('table', { name: 'Scenario by department' }).getByRole('row').filter({ hasText: 'Finance' });
    const [finToday, finAfter] = [Number(await finRow.locator('td').nth(1).innerText()), Number(await finRow.locator('td').last().innerText())];
    expect(finAfter === finToday + 2, `Finance went from ${finToday} to ${finAfter}`);
    await p.getByRole('button', { name: 'Save scenario' }).click();
    await p.getByText('Scenario saved.').waitFor();
    await p.reload();
    const saved = p.locator('[aria-label="Saved scenarios"]').getByRole('button', { name: /E2E: Finance growth/ });
    await saved.click();
    expect(await p.getByLabel('Change in Finance', { exact: true }).inputValue() === '2', 'saved change not loaded');
    expect(await p.getByLabel('Month of the change in Finance').inputValue() === inThree, 'saved month not loaded');
    expect(await p.getByLabel(/^Attrition per year/).inputValue() === '10', 'saved attrition not loaded');
    expect(await p.getByLabel('Role added in Finance').inputValue() === 'Financial Analyst', 'saved role not loaded');
    p.once('dialog', (d) => d.accept());
    await p.getByRole('button', { name: 'Delete' }).click();
    await p.getByText('Scenario deleted.').waitFor();
    await saved.waitFor({ state: 'detached' });
    ok('projected a Finance +2 scenario from a month with 10% attrition over 18 months, saved, reopened and deleted it');

    // The plant head raises draft requisitions from the demo scenario: once, and each opens as a draft job.
    const ctx2 = await b.newContext({ viewport: { width: 1440, height: 1000 } });
    const q = await ctx2.newPage();
    q.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
    for (let attempt = 1; ; attempt++) {
      await q.goto(BASE + '/login');
      await q.fill('input[name=email]', 'plant.head@demo.crew.local');
      await q.fill('input[name=password]', PASSWORD);
      await q.click('button[type=submit]');
      const r = await Promise.race([
        q.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }).then(() => 'in'),
        q.getByText(/too many/i).waitFor({ timeout: 15000 }).then(() => 'limited'),
      ]).catch(() => 'stuck');
      if (r === 'in') break;
      if (attempt >= 4) throw new Error(`plant head sign-in: ${r}`);
      await q.waitForTimeout(20000);
    }
    await q.goto(BASE + '/insights/universe?lens=scenarios');
    await q.locator('[aria-label="Saved scenarios"]').getByRole('button', { name: /Second shift on line 2/ }).click();
    const reqCard = q.locator('[aria-label="Requisitions from this scenario"]');
    await reqCard.getByRole('button', { name: 'Raise draft requisitions (2)' }).click();
    await q.getByText(/2 draft requisition\(s\) raised/).waitFor();
    const links = reqCard.getByRole('link');
    expect(await links.count() === 2, `expected 2 requisitions, saw ${await links.count()}`);
    expect(await reqCard.getByRole('button', { name: /^Raise draft requisitions/ }).isDisabled(), 'raising twice should be disabled');
    await q.reload();
    expect(await reqCard.getByRole('link').count() === 2, 'requisitions not kept after a reload');
    await reqCard.getByRole('link', { name: /Machine Operator \(second shift\)/ }).click();
    await q.waitForURL(/\/recruitment\/jobs\//);
    await q.getByRole('heading', { name: /Machine Operator \(second shift\)/ }).first().waitFor();
    await q.getByText(/^Draft$/i).first().waitFor();
    ok('the plant head raised 2 draft requisitions from the demo scenario, once, and opened one');

    const js = q.locator('[aria-label="Skills for this job"]');
    for (const [skill, level] of [['CNC operation', '3'], ['Forklift', '2']]) {
      await js.getByLabel('Skill to ask for').selectOption({ label: `${skill} (Shop floor)` });
      await js.getByLabel('Lowest level that counts').selectOption(level);
      await js.getByRole('button', { name: 'Add', exact: true }).click();
    }
    await js.getByRole('button', { name: 'Save skills' }).click();
    await q.getByText(/Skills saved\. \d+ people here/).waitFor();
    await q.reload();
    const matchRows = q.locator('table[aria-label="People here who match"] tbody tr');
    await matchRows.first().waitFor();
    const scores = await matchRows.evaluateAll((rs) => rs.map((r) => parseInt(r.children[2].textContent, 10)));
    expect(scores.length > 0 && scores.every((v, i) => !i || scores[i - 1] >= v), `matches should be best first: ${scores}`);
    expect(await js.getByText('CNC operation · Strong+').count() === 1, 'saved skills not shown after a reload');
    await ctx2.close();
    ok(`the job asks for CNC operation and Forklift; ${scores.length} people here match, best ${scores[0]}%`);

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
