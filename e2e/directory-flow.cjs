/**
 * Employee directory and guided hire, end to end in the Web Portal, against the demo workspace:
 *   pnpm db:reset            # fresh demo workspace (hr.admin must not have MFA enrolled yet)
 *   API on :4000, Web Portal on :3000, then: pnpm e2e:directory
 *
 * 1. HR sorts the directory by joining date (newest first), adds a column and switches to compact rows.
 * 2. They save that as their default view; opening Employees again brings it back, from the database.
 * 3. They export the directory as CSV: the file has the columns on screen, in order.
 * 4. They start a hire, get a duplicate warning for an existing person, correct the name, save the hire as a draft
 *    and close it. The draft survives a reload, resumes at the right step and is completed with a document.
 * 5. The new profile has the document; the draft is gone.
 * 6. Employee 360: the at-a-glance strip on a profile shows only the areas HR may see (no pay for an HR admin), and
 *    the Activity tab lists the person's transfer.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
let current;

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const hr = await ctx.newPage();
  current = hr;
  hr.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  hr.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  try {
    // Sign-in is rate limited per address (10 a minute); earlier flows in the same run can use that up.
    for (let attempt = 1; ; attempt++) {
      await hr.goto(BASE + '/login');
      await hr.fill('input[name=email]', 'hr.admin@demo.crew.local');
      await hr.fill('input[name=password]', PASSWORD);
      await hr.click('button[type=submit]');
      const r = await Promise.race([
        hr.waitForURL((u) => u.pathname === '/', { timeout: 15000 }).then(() => 'in'),
        hr.locator('text=Too many requests').waitFor({ timeout: 15000 }).then(() => 'limited'),
      ]);
      if (r === 'in') break;
      if (attempt >= 4) throw new Error('sign-in stayed rate limited');
      await hr.waitForTimeout(20000);
    }

    // 1. Sort, columns, density.
    await hr.goto(BASE + '/employees');
    const table = hr.getByRole('table', { name: 'Employees' });
    await table.waitFor();
    await hr.getByRole('button', { name: /^Sort by Joined/ }).click();
    await hr.waitForURL(/sort=joined/);
    await hr.getByRole('button', { name: 'Sort by Joined, sorted ascending' }).click();
    await hr.waitForURL(/dir=desc/);
    await hr.locator('th[aria-sort=descending]', { hasText: 'Joined' }).waitFor();
    await hr.getByRole('button', { name: 'Columns' }).click();
    await hr.getByRole('group', { name: 'Choose columns' }).getByLabel('Work email').click();
    await hr.waitForURL(/cols=/);
    await table.locator('th', { hasText: 'Work email' }).waitFor();
    await hr.keyboard.press('Escape');
    await hr.getByRole('button', { name: 'Compact rows' }).click();
    await hr.waitForURL(/density=compact/);
    const joined = await table.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.children[5]?.textContent ?? ''));
    expect(joined.length > 3, `expected the demo directory, saw ${joined.length} rows`);
    expect(joined.every((d, i) => i === 0 || joined[i - 1] >= d), `rows are not newest first: ${joined.slice(0, 5).join(', ')}`);
    ok(`sorted ${joined.length} people by joining date (newest first), added Work email, compact rows`);

    // 2. Save as the default view; it comes back when Employees is opened again.
    await hr.getByRole('button', { name: /^Saved views/ }).click();
    await hr.getByRole('menuitem', { name: 'Save current view…' }).click();
    await hr.getByRole('textbox', { name: 'View name' }).fill('Newest joiners');
    await hr.getByLabel('Open this view by default').check();
    await hr.getByRole('button', { name: 'Save view' }).click();
    await hr.getByRole('button', { name: 'Saved views, showing Newest joiners' }).waitFor();
    await hr.goto(BASE + '/employees');
    await hr.waitForURL(/view=[0-9a-f-]{36}/);
    await hr.getByRole('button', { name: 'Saved views, showing Newest joiners' }).waitFor();
    await hr.locator('th[aria-sort=descending]', { hasText: 'Joined' }).waitFor();
    await table.locator('th', { hasText: 'Work email' }).waitFor();
    expect((await hr.getByRole('button', { name: 'Compact rows' }).getAttribute('aria-pressed')) === 'true', 'compact rows were not restored');
    // Changing the sort marks the view as changed and offers to update it.
    await hr.getByRole('button', { name: /^Sort by Name/ }).click();
    await hr.getByRole('button', { name: 'Update “Newest joiners”' }).waitFor();
    await hr.getByRole('button', { name: 'Saved views, showing Newest joiners (changed)' }).click();
    await hr.getByRole('menuitem', { name: 'Newest joiners' }).click();
    await hr.locator('th[aria-sort=descending]', { hasText: 'Joined' }).waitFor();
    ok('saved "Newest joiners" as the default view; it reopened from the database with sort, columns and density');

    // 3. CSV export of what is on screen.
    const [download] = await Promise.all([hr.waitForEvent('download'), hr.getByRole('link', { name: 'Export CSV' }).click()]);
    const file = await download.path();
    const csv = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim().split('\r\n');
    expect(csv[0] === 'Name,Employee code,Department,Location,Manager,Date of joining,Status,Work email', `unexpected CSV header: ${csv[0]}`);
    expect(csv.length === joined.length + 1, `CSV has ${csv.length - 1} rows, the table ${joined.length}`);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(csv[1].split(',')[5]), `joining date column looks wrong: ${csv[1]}`);
    ok(`exported ${csv.length - 1} rows as CSV with the on-screen columns in order (${download.suggestedFilename()})`);

    // 4. Guided hire: duplicate warning, draft, resume.
    await hr.getByRole('button', { name: 'Add employee', exact: true }).click();
    const dialog = hr.locator('dialog[open]');
    await dialog.locator('input[name=firstName]').fill('Sunita');
    await dialog.locator('input[name=lastName]').fill('Patil');
    await dialog.getByRole('button', { name: 'Next: Employment' }).click();
    await dialog.getByText('This person may already have a record').waitFor();
    await dialog.getByRole('link', { name: 'Sunita Patil' }).waitFor();
    const stamp = String(Date.now() % 100000);
    await dialog.locator('input[name=firstName]').fill('Sunaina');
    await dialog.locator('input[name=workEmail]').fill(`sunaina.${stamp}@demo.crew.local`);
    await dialog.getByRole('button', { name: 'Next: Employment' }).click();
    await dialog.locator('h3', { hasText: 'Employment' }).waitFor();
    await dialog.locator('select[name=designationId]').selectOption({ index: 1 });
    await dialog.getByRole('button', { name: 'Next: Department & reporting' }).click();
    await dialog.locator('h3', { hasText: 'Department & reporting' }).waitFor();
    await dialog.locator('select[name=departmentId]').selectOption({ label: 'Assembly Line' });
    await dialog.getByRole('button', { name: 'Save and finish later' }).click();
    await dialog.waitFor({ state: 'detached' });
    const drafts = hr.locator('[aria-label="Unfinished hires"]');
    await drafts.getByText('Sunaina Patil').waitFor();
    await hr.reload();
    await drafts.getByText('Next: Department & reporting').waitFor();
    ok('duplicate warning for an existing Sunita Patil; corrected the name and saved the hire as a draft that survives a reload');

    await hr.getByRole('button', { name: 'Resume hiring Sunaina Patil' }).click();
    await dialog.locator('h3', { hasText: 'Department & reporting' }).waitFor();
    expect((await dialog.locator('select[name=departmentId] option:checked').textContent()) === 'Assembly Line', 'department lost from the draft');
    await dialog.getByRole('button', { name: 'Next: Compensation' }).click();
    await dialog.getByRole('button', { name: 'Next: Documents' }).click();
    const doc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-')), 'offer-letter.txt');
    fs.writeFileSync(doc, 'Offer letter for Sunaina Patil\n');
    await dialog.getByLabel('Attach documents').setInputFiles(doc);
    await dialog.getByRole('combobox', { name: 'Category for offer-letter.txt' }).waitFor();
    expect((await dialog.getByRole('combobox', { name: 'Category for offer-letter.txt' }).inputValue()) === 'offer_letter', 'category not guessed from the file name');
    await dialog.getByRole('button', { name: 'Next: Access & onboarding' }).click();
    await dialog.getByRole('button', { name: 'Next: Review' }).click();
    await dialog.getByText('No existing record matches this person.').waitFor();
    await dialog.getByText('Assembly Line ·').waitFor();
    await dialog.locator('button[type=submit]').click();
    await hr.waitForURL(/\/employees\/[0-9a-f-]{36}$/, { timeout: 15000 });
    await hr.getByRole('heading', { name: 'Sunaina Patil' }).waitFor();
    await hr.goto(hr.url() + '?tab=documents');
    await hr.getByText('offer-letter').first().waitFor();
    await hr.goto(BASE + '/employees?view=all');
    await hr.getByRole('table', { name: 'Employees' }).waitFor();
    expect((await drafts.count()) === 0, 'the draft should be removed once the hire is complete');
    ok('resumed the draft, attached an offer letter and completed the hire; the document is on the profile');

    // 6. Employee 360: HR opens Rekha Jadhav. The figures come from her records; pay is not shown to HR admins, who
    //    have no payroll access; the Activity tab has her transfer.
    await hr.goto(BASE + '/employees?view=all');
    await hr.getByRole('link', { name: 'Rekha Jadhav' }).first().click();
    await hr.waitForURL(/\/employees\/[0-9a-f-]{36}$/);
    const glance = hr.getByRole('region', { name: 'At a glance' }).or(hr.locator('section[aria-label="At a glance"]'));
    await glance.waitFor();
    for (const label of ['Tenure', 'Attendance, 30 days', 'Leave this year', 'Goals', 'Documents']) await glance.getByLabel(label, { exact: true }).waitFor();
    expect(await glance.getByLabel('Pay', { exact: true }).count() === 0, 'pay shown to an HR admin without payroll access');
    await glance.getByText(/Not shown, because your access or the plan does not cover them: .*Pay/).waitFor();
    expect(/Since 1 Jun 2023/.test(await glance.getByLabel('Tenure', { exact: true }).innerText()), 'tenure not from the hire record');
    await hr.getByRole('link', { name: 'Activity' }).click();
    const timeline = hr.getByRole('list', { name: 'Activity timeline' });
    await timeline.getByText('Transferred').waitFor();
    await timeline.getByText('effective 2024-04-01').waitFor();
    ok('Employee 360: the at-a-glance strip shows her areas, hides pay from HR, and the activity timeline has her transfer');

    if (errs.length) throw new Error('browser errors:\n' + errs.join('\n'));
    console.log('directory flow: all checks passed');
  } catch (e) {
    if (current) await current.screenshot({ path: process.env.SHOT ?? '/tmp/directory-fail.png', fullPage: true }).catch(() => undefined);
    throw e;
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
