/**
 * ATS board and candidate comparison, end to end in the Web Portal, against the demo workspace:
 *   pnpm db:reset; API on :4000, Web Portal on :3000, then: pnpm e2e:ats   (also fine after e2e:recruitment)
 *
 * 1. The recruiter opens the Quality Engineer pipeline and drags Sneha Kulkarni from Applied to Screening.
 *    The move is saved: after a reload she is in Screening with "New in stage".
 * 2. They tick two candidates and compare them: stage, days in process, average and per-criterion scores for the
 *    job's scorecard, recommendations and offer, one column per candidate.
 * 3. From the comparison they move a candidate on, and the board shows it.
 * 4. Bulk actions: they email everyone in Screening at once ({firstName} filled in), move two candidates to Offer
 *    together, and reject one with a neutral email; the board and the candidate's history agree after a reload.
 * 5. Candidate list: they filter to the job and people still in process, sort by name, save that as their default
 *    view (it reopens from the database), and export the same list as CSV and Excel.
 * The comparison also shows the recruiter the job's pay range and an offer amount row (pay stays hidden from
 * interviewers; the API tests cover that).
 */
const fs = require('node:fs');
const { chromium } = require('playwright');

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const shot = (p, name) => (process.env.SHOTS ? p.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : Promise.resolve());
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
    // Bring the board into view first: a drag that has to scroll the page to reach its drop target never lands.
    await column('Screening').scrollIntoViewIfNeeded();
    await card('Sneha Kulkarni').dragTo(column('Screening'));
    await column('Screening').getByRole('link', { name: 'Sneha Kulkarni' }).waitFor();
    await p.reload();
    await column('Screening').getByRole('link', { name: 'Sneha Kulkarni' }).waitFor();
    expect(await column('Applied').getByRole('link', { name: 'Sneha Kulkarni' }).count() === 0, 'Sneha still in Applied after reload');
    await card('Sneha Kulkarni').getByText('New in stage').waitFor();
    ok('dragged Sneha Kulkarni to Screening; saved after a reload');

    // 2. Compare.
    await card('Ananya Joshi').getByRole('checkbox', { name: 'Select Ananya Joshi' }).check();
    const bar = p.getByRole('region', { name: 'Selected candidates' });
    await bar.getByText('1 selected').waitFor();
    expect(await bar.getByRole('button', { name: 'Compare' }).isDisabled(), 'compare offered for one candidate');
    await card('Rahul Verma').getByRole('checkbox', { name: 'Select Rahul Verma' }).check();
    await bar.getByRole('link', { name: 'Compare 2' }).click();
    await p.waitForURL(/\/compare\?applications=/);
    const table = p.getByRole('table', { name: /Candidates compared for/ });
    await table.waitFor();
    for (const h of ['Ananya Joshi', 'Rahul Verma']) await table.getByRole('columnheader', { name: new RegExp(h) }).waitFor();
    for (const r of ['Stage', 'Average score', 'Quality systems', 'Problem solving', 'Communication', 'Shop-floor safety', 'Recommendations', 'Offer']) {
      await table.getByRole('rowheader', { name: r, exact: true }).waitFor();
    }
    const amountRow = await table.getByRole('row').filter({ has: p.getByRole('rowheader', { name: /^Offer amount/ }) }).innerText();
    expect(/No amount yet|₹/.test(amountRow), `offer amount row looks wrong: ${amountRow}`);
    await shot(p, 'design6-ats-compare-offer');
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
    // The compare page opened without a pick (a bookmark or a hand-typed address) explains how to pick instead of
    // showing "page not found"; a pick that is not on this job says so.
    const compareUrl = jobUrl.replace(/[?#].*$/, '') + '/compare';
    await p.goto(compareUrl);
    await p.getByTestId('compare-pick').getByText('Pick candidates to compare').waitFor();
    await p.getByTestId('compare-pick').getByRole('link', { name: 'Open the pipeline' }).click();
    await column('Interview').getByRole('link', { name: 'Rahul Verma' }).waitFor();
    await p.goto(compareUrl + '?applications=00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000002');
    await p.getByTestId('compare-pick').getByText('These candidates cannot be compared').waitFor();
    await p.goto(jobUrl);
    ok('the compare page opened without a valid pick says how to pick candidates');

    // 4. Bulk actions: email everyone in Screening, move two on together, reject one with a candidate email.
    //    How many are in Screening depends on whether e2e:recruitment ran first, so the counts are read from the board.
    await column('Screening').getByRole('checkbox', { name: 'Select everyone in Screening' }).check();
    const picked = Number((await bar.getByText(/^\d+ selected$/).innerText()).split(' ')[0]);
    expect(picked >= 1 && picked === await column('Screening').locator('[data-application]').count(), `select-all picked ${picked}`);
    await shot(p, 'design4-ats-bulk-bar');
    await bar.getByRole('button', { name: `Email ${picked}` }).click();
    let d = p.getByRole('dialog');
    expect((await d.getByLabel(/^Subject/).inputValue()) === 'Your application for {jobTitle}', 'subject not prefilled');
    await d.getByLabel(/^Message/).fill('Dear {firstName},\n\nCould you share your availability for a call next week?');
    await shot(p, 'design4-ats-bulk-email');
    await d.getByRole('button', { name: 'Send emails' }).click();
    await p.getByText(`Emailed ${picked} candidate${picked === 1 ? '' : 's'}.`).waitFor();
    expect(await bar.count() === 0, 'selection not cleared after the bulk email');
    ok(`emailed everyone in Screening (${picked}) at once`);

    await card('Sneha Kulkarni').getByRole('checkbox', { name: 'Select Sneha Kulkarni' }).check();
    await card('Rahul Verma').getByRole('checkbox', { name: 'Select Rahul Verma' }).check();
    const moveTo = bar.getByRole('combobox', { name: 'Move selected to' });
    expect(!(await moveTo.locator('option').allInnerTexts()).includes('Hired'), 'bulk move offers Hired');
    await moveTo.selectOption({ label: 'Offer' });
    await p.getByText('Moved 2 candidates.').waitFor();
    await p.reload();
    for (const n of ['Sneha Kulkarni', 'Rahul Verma']) await column('Offer').getByRole('link', { name: n }).waitFor();
    ok('moved Sneha Kulkarni and Rahul Verma to Offer together; saved after a reload');

    await card('Sneha Kulkarni').getByRole('checkbox', { name: 'Select Sneha Kulkarni' }).check();
    await bar.getByRole('button', { name: 'Reject 1' }).click();
    d = p.getByRole('dialog');
    await d.getByLabel(/^Reason/).selectOption({ label: 'Position closed' });
    await d.getByLabel(/^Tell the candidates/).selectOption({ value: 'true' });
    await d.getByRole('button', { name: 'Reject' }).click();
    await p.getByText('Rejected 1 candidate.').waitFor();
    await p.reload();
    expect(await card('Sneha Kulkarni').count() === 0, 'rejected candidate still on the board');
    await p.goto(jobUrl + '?show=rejected');
    await card('Sneha Kulkarni').getByText('Rejected').waitFor();
    await card('Sneha Kulkarni').getByRole('link', { name: 'Sneha Kulkarni' }).click();
    await p.waitForURL(/\/recruitment\/candidates\//);
    await p.locator('li', { hasText: 'Rejected' }).first().waitFor();
    await p.locator('li', { hasText: 'Email queued' }).filter({ hasText: 'rejected' }).first().waitFor();
    await p.locator('li', { hasText: 'Email queued' }).filter({ hasText: '“Your application for Quality Engineer”' }).first().waitFor();
    ok('rejected Sneha Kulkarni with a neutral email; the histories show the rejection and the bulk email');

    // 5. Candidate list: filters, sort, a saved default view, CSV and Excel export.
    await p.goto(BASE + '/recruitment/candidates?view=all');
    const list = p.getByRole('table', { name: 'Candidates' });
    await list.waitFor();
    const jobFilter = p.getByRole('combobox', { name: 'Filter by job' });
    const qe = (await jobFilter.locator('option').allInnerTexts()).find((o) => /Quality Engineer/.test(o));
    expect(qe, 'Quality Engineer missing from the job filter');
    await jobFilter.selectOption({ label: qe });
    await p.waitForURL(/requisitionId=/);
    await p.getByRole('combobox', { name: 'Filter by application status' }).selectOption({ label: 'In process' });
    await p.waitForURL(/status=active/);
    await p.getByRole('button', { name: /^Sort by Candidate/ }).click();
    await p.waitForURL(/sort=name/);
    // Who is still in process depends on whether e2e:recruitment hired Ananya Joshi first, so read the list.
    await list.getByRole('link', { name: 'Rahul Verma' }).waitFor();
    expect(await list.getByRole('link', { name: 'Sneha Kulkarni' }).count() === 0, 'rejected candidate shown among people in process');
    const jobs = await list.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.children[1]?.textContent ?? ''));
    expect(jobs.every((j) => /Quality Engineer · (?!Hired|Rejected|Withdrew)/.test(j)), `someone not in process for Quality Engineer is listed: ${jobs.join(' | ')}`);
    const names = await list.locator('tbody tr td:first-child a').allInnerTexts();
    expect(names.length >= 1, `expected the in-process candidates, saw ${names.length}`);
    const sortedNames = [...names].sort((a, b) => a.localeCompare(b));
    const asc = names.join('|') === sortedNames.join('|');
    expect(asc || names.join('|') === [...sortedNames].reverse().join('|'), `rows are not sorted by name: ${names.join(', ')}`);
    const viewName = `QE in process ${Date.now() % 100000}`;
    await p.getByRole('button', { name: /^Saved views/ }).click();
    await p.getByRole('menuitem', { name: 'Save current view…' }).click();
    await p.getByRole('textbox', { name: 'View name' }).fill(viewName);
    await p.getByLabel('Open this view by default').check();
    await p.getByRole('button', { name: 'Save view' }).click();
    await p.getByRole('button', { name: `Saved views, showing ${viewName}` }).waitFor();
    await p.goto(BASE + '/recruitment/candidates');
    await p.waitForURL(/view=[0-9a-f-]{36}/);
    await p.getByRole('button', { name: `Saved views, showing ${viewName}` }).waitFor();
    expect((await p.getByRole('combobox', { name: 'Filter by application status' }).inputValue()) === 'active', 'status filter not restored');
    expect((await list.locator('tbody tr td:first-child a').allInnerTexts()).join('|') === names.join('|'), 'saved view reopened a different list');
    await shot(p, 'design6-ats-candidate-view');
    ok(`filtered candidates to Quality Engineer, in process, by name; saved "${viewName}" as the default and it reopened`);

    const [csvDl] = await Promise.all([p.waitForEvent('download'), p.getByRole('link', { name: 'Export CSV' }).click()]);
    const csv = fs.readFileSync(await csvDl.path(), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    expect(csv[0].startsWith('Name,Email,Phone'), `unexpected CSV header: ${csv[0]}`);
    expect(csv.length === names.length + 1, `CSV has ${csv.length - 1} rows, the list ${names.length}`);
    const [xlsxDl] = await Promise.all([p.waitForEvent('download'), p.getByRole('link', { name: 'Export Excel' }).click()]);
    const xlsx = fs.readFileSync(await xlsxDl.path());
    expect(xlsx.subarray(0, 2).toString() === 'PK' && /\.xlsx$/.test(xlsxDl.suggestedFilename()), `Excel download looks wrong: ${xlsxDl.suggestedFilename()}`);
    ok(`exported the ${names.length} candidates as CSV and Excel (${xlsxDl.suggestedFilename()})`);

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
