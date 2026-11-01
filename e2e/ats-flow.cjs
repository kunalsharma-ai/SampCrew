/**
 * ATS board and candidate comparison, end to end in the Web Portal, against the demo workspace:
 *   pnpm db:reset; API on :4000, Web Portal on :3000, then: pnpm e2e:ats   (also fine after e2e:recruitment)
 *
 * 1. The recruiter opens the Quality Engineer pipeline and drags Sneha Kulkarni from Applied to Screening.
 *    The move is saved: after a reload she is in Screening with "New in stage".
 * 2. They tick two candidates and compare them: stage, days in process, average and per-criterion scores for the
 *    job's scorecard, recommendations and offer, one column per candidate.
 * 3. From the comparison they move a candidate on, and the board shows it.
 */
const { chromium } = require('playwright');

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  p.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  try {
    for (let attempt = 1; ; attempt++) {
      await p.goto(BASE + '/login');
      await p.fill('input[name=email]', 'recruiter@demo.crew.local');
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

    // 1. Drag and drop.
    await p.goto(BASE + '/recruitment');
    await p.getByRole('link', { name: /Quality Engineer/ }).first().click();
    await p.waitForURL(/\/recruitment\/jobs\/[0-9a-f-]{36}$/);
    const jobUrl = p.url();
    const column = (name) => p.getByRole('region', { name, exact: true });
    const card = (name) => p.locator('[data-application]').filter({ has: p.getByRole('link', { name, exact: true }) });
    await column('Applied').getByRole('link', { name: 'Sneha Kulkarni' }).waitFor();
    await card('Sneha Kulkarni').dragTo(column('Screening'));
    await column('Screening').getByRole('link', { name: 'Sneha Kulkarni' }).waitFor();
    await p.reload();
    await column('Screening').getByRole('link', { name: 'Sneha Kulkarni' }).waitFor();
    expect(await column('Applied').getByRole('link', { name: 'Sneha Kulkarni' }).count() === 0, 'Sneha still in Applied after reload');
    await card('Sneha Kulkarni').getByText('New in stage').waitFor();
    ok('dragged Sneha Kulkarni to Screening; saved after a reload');

    // 2. Compare.
    await card('Ananya Joshi').getByRole('checkbox', { name: 'Compare Ananya Joshi' }).check();
    const bar = p.getByRole('region', { name: 'Compare candidates' });
    await bar.getByText('1 selected, pick at least one more').waitFor();
    await card('Rahul Verma').getByRole('checkbox', { name: 'Compare Rahul Verma' }).check();
    await bar.getByRole('link', { name: 'Compare 2' }).click();
    await p.waitForURL(/\/compare\?applications=/);
    const table = p.getByRole('table', { name: /Candidates compared for/ });
    await table.waitFor();
    for (const h of ['Ananya Joshi', 'Rahul Verma']) await table.getByRole('columnheader', { name: new RegExp(h) }).waitFor();
    for (const r of ['Stage', 'Average score', 'Quality systems', 'Problem solving', 'Communication', 'Shop-floor safety', 'Recommendations', 'Offer']) {
      await table.getByRole('rowheader', { name: r, exact: true }).waitFor();
    }
    const stageRow = await table.getByRole('row').filter({ has: p.getByRole('rowheader', { name: 'Stage', exact: true }) }).innerText();
    expect(/in process/.test(stageRow), 'days in process missing');
    ok('compared Ananya Joshi and Rahul Verma across the job scorecard');

    // 3. Act from the comparison.
    await table.getByRole('combobox', { name: 'Move Rahul Verma' }).selectOption({ label: 'Interview' });
    await p.getByText('Saved.').or(p.getByRole('alert')).first().waitFor();
    await table.getByRole('row').filter({ has: p.getByRole('rowheader', { name: 'Stage', exact: true }) }).getByText('Interview').first().waitFor();
    await p.goto(jobUrl);
    await column('Interview').getByRole('link', { name: 'Rahul Verma' }).waitFor();
    ok('moved Rahul Verma to Interview from the comparison; the board agrees');

    const real = errs.filter((e) => !/favicon|DevTools/.test(e));
    expect(!real.length, `browser errors:\n${real.join('\n')}`);
    console.log('ats flow passed');
  } catch (e) {
    console.error(e);
    await p.screenshot({ path: 'ats-flow-failure.png', fullPage: true }).catch(() => {});
    console.error(errs.join('\n'));
    process.exitCode = 1;
  } finally {
    await b.close();
  }
})();
