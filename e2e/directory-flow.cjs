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
 *    On the way the form refuses a phone number that is too short and a work email that is the personal one, the date
 *    of birth is picked from the calendar (years and months listed, limited by the joining date), and a designation
 *    that is not on the list is typed in and added with the hire.
 * 5. The new profile has the document and the new designation; the draft is gone.
 * 5b. HR adds someone already working here: a joining date years back, their own employee code, confirmed status
 *    worked out from probation, no joining checklist, and an opening leave balance that the leave tab then shows.
 * 6. Employee 360: the at-a-glance strip on a profile shows only the areas HR may see (no pay for an HR admin), and
 *    the Activity tab lists the person's transfer.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
require('./delete-password.cjs');

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
    // Find the Joined column by its heading: people who can make bulk changes get a checkbox column first.
    const joinedCol = await table.locator('thead th').evaluateAll((ths) => ths.findIndex((th) => (th.textContent ?? '').trim().startsWith('Joined')));
    expect(joinedCol >= 0, 'the Joined column is shown');
    const joined = await table.locator('tbody tr').evaluateAll((rows, i) => rows.map((r) => r.children[i]?.textContent ?? ''), joinedCol);
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
    expect(csv[0] === 'Name,Employee code,Designation,Department,Workspace access,Manager,Date of joining,Status,Work email', `unexpected CSV header: ${csv[0]}`);
    expect(csv.length === joined.length + 1, `CSV has ${csv.length - 1} rows, the table ${joined.length}`);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(csv[1].split(',')[6]), `joining date column looks wrong: ${csv[1]}`);
    ok(`exported ${csv.length - 1} rows as CSV with the on-screen columns in order (${download.suggestedFilename()})`);
    const [xl] = await Promise.all([hr.waitForEvent('download'), hr.getByRole('link', { name: 'Export Excel' }).click()]);
    const xlsx = fs.readFileSync(await xl.path());
    expect(xlsx.subarray(0, 2).toString() === 'PK' && /\.xlsx$/.test(xl.suggestedFilename()), `Excel download looks wrong: ${xl.suggestedFilename()}`);
    ok(`exported the same list as Excel (${xl.suggestedFilename()})`);

    // 4. Guided hire: duplicate warning, draft, resume.
    await hr.getByRole('button', { name: 'Add employee', exact: true }).click();
    const dialog = hr.locator('dialog[open]');
    await dialog.locator('input[name=firstName]').fill('Sunita');
    await dialog.locator('input[name=lastName]').fill('Patil');
    // The same name alone does not stop the form: two people may share a name, each with their own employee ID.
    await dialog.getByRole('button', { name: 'Next: Employment' }).click();
    await dialog.locator('h3', { hasText: 'Employment' }).waitFor();
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    await dialog.getByText('Someone with this name already works here').waitFor();
    expect(!(await dialog.getByText('This person may already have a record').isVisible()), 'a name-only match was shown as a possible duplicate');
    const stamp = String(Date.now() % 100000);
    await dialog.locator('input[name=firstName]').fill('Sunaina');
    // The personal email is never taken as the work email.
    await dialog.locator('input[name=personalEmail]').fill(`sunaina.${stamp}@gmail.example`);
    await dialog.locator('input[name=workEmail]').fill(`sunaina.${stamp}@gmail.example`);
    expect((await dialog.locator('input[name=workEmail]').getAttribute('autocomplete')) === 'off', 'work email may be filled in by the browser');
    // A phone number that is too short is refused before going on.
    await dialog.locator('input[name=phone]').fill('+91 98201 2345');
    await dialog.getByRole('button', { name: 'Next: Employment' }).click();
    await dialog.getByText('Use their work email here, not their personal email').waitFor();
    await dialog.getByText('9 digits after +91; numbers there have 10').waitFor();
    await dialog.locator('input[name=workEmail]').fill(`sunaina.${stamp}@demo.crew.local`);
    await dialog.locator('input[name=phone]').fill('+91 98201 23456');
    // Date of birth from the calendar: year and month lists, then the day. Dates making them under 14 on joining are off.
    await dialog.getByRole('button', { name: 'Choose date of birth' }).click();
    const cal = dialog.getByRole('group', { name: 'Choose date of birth' });
    const newestYear = Number(await cal.getByLabel('Year', { exact: true }).locator('option').first().getAttribute('value'));
    expect(newestYear === new Date().getUTCFullYear() - 14, `the calendar offers birth years up to ${newestYear}`);
    await cal.getByLabel('Year', { exact: true }).selectOption('1996');
    await cal.getByLabel('Month', { exact: true }).selectOption({ label: 'March' });
    await cal.getByRole('button', { name: '15 March 1996' }).click();
    await cal.waitFor({ state: 'detached' });
    expect((await dialog.locator('input[name=dateOfBirth]').inputValue()) === '1996-03-15', 'date of birth not taken from the calendar');
    await dialog.getByRole('button', { name: 'Next: Employment' }).click();
    await dialog.locator('h3', { hasText: 'Employment' }).waitFor();
    // Joining before their 14th birthday is not possible: the joining calendar starts there.
    expect((await dialog.locator('input[name=dateOfJoining]').getAttribute('min')) === '2010-03-15', 'joining date not limited by the date of birth');
    // A designation that is not on the list is typed in; the suggestions hold far more than the workspace's own.
    expect((await dialog.locator('#hire-designations option').count()) > 150, 'designation suggestions are short');
    await dialog.locator('input[name=designation]').fill('Line Quality Coach');
    await dialog.getByText('"Line Quality Coach" is new: it is added to your designations with this hire').waitFor();
    await dialog.getByRole('button', { name: 'Next: Department & reporting' }).click();
    await dialog.locator('h3', { hasText: 'Department & reporting' }).waitFor();
    await dialog.locator('select[name=departmentId]').selectOption({ label: 'Assembly Line' });
    await dialog.getByRole('button', { name: 'Save and finish later' }).click();
    await dialog.waitFor({ state: 'detached' });
    const drafts = hr.locator('[aria-label="Unfinished hires"]');
    await drafts.getByText('Sunaina Patil').waitFor();
    await hr.reload();
    await drafts.getByText('Next: Department & reporting').waitFor();
    ok('same name as Sunita Patil only noted, not blocked; corrected the name and saved the hire as a draft that survives a reload');

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
    await dialog.getByRole('button', { name: 'Next: Attendance & access' }).click();
    await dialog.getByRole('button', { name: 'Next: Review' }).click();
    await dialog.getByText('No existing record matches this person.').waitFor();
    await dialog.getByText('Assembly Line ·').waitFor();
    await dialog.getByText('Line Quality Coach (new)').waitFor();
    await dialog.getByText(/^1996-03-15 · \d+ on joining$/).waitFor();
    await dialog.locator('button[type=submit]').click();
    await hr.waitForURL(/\/employees\/[0-9a-f-]{36}$/, { timeout: 15000 });
    await hr.getByRole('heading', { name: 'Sunaina Patil' }).waitFor();
    await hr.getByText('Line Quality Coach').first().waitFor();
    await hr.getByText('+91 98201 23456').waitFor();
    await hr.goto(hr.url() + '?tab=documents');
    await hr.getByText('offer-letter').first().waitFor();
    await hr.goto(BASE + '/employees?view=all');
    await hr.getByRole('table', { name: 'Employees' }).waitFor();
    expect((await drafts.count()) === 0, 'the draft should be removed once the hire is complete');
    ok('resumed the draft, attached an offer letter and completed the hire; the document and the typed designation are on the profile');

    // 5b. Someone already working here.
    await hr.getByRole('button', { name: 'Add employee', exact: true }).click();
    await dialog.getByText('Someone already working here').click();
    await dialog.locator('input[name=firstName]').fill('Kavita');
    await dialog.locator('input[name=lastName]').fill(`Rane ${stamp}`);
    await dialog.getByRole('button', { name: 'Next: Employment' }).click();
    await dialog.locator('h3', { hasText: 'Employment' }).waitFor();
    expect((await dialog.locator('input[name=dateOfJoining]').getAttribute('max')) === new Date().toISOString().slice(0, 10), 'an existing employee could join in the future');
    await dialog.locator('input[name=dateOfJoining]').fill('2019-04-01');
    await dialog.locator('input[name=probationMonths]').fill('6');
    await dialog.locator('input[name=employeeCode]').fill(`KR-${stamp}`);
    await dialog.getByText('Added as a confirmed employee (confirmed 2019-10-01).').waitFor();
    await dialog.locator('input[name=designation]').fill('machine operator');
    const casual = dialog.getByLabel('Opening balance, Casual Leave');
    await casual.fill('7.5');
    for (const label of ['Department & reporting', 'Compensation', 'Documents', 'Attendance & access']) {
      await dialog.getByRole('button', { name: `Next: ${label}` }).click();
      await dialog.locator('h3', { hasText: label }).waitFor();
    }
    expect((await dialog.locator('select[name=onboardingTemplateId]').inputValue()) === 'none', 'an existing employee got the joining checklist');
    await dialog.getByRole('button', { name: 'Next: Review' }).click();
    await dialog.getByText(`Already working here since 2019-04-01 · code KR-${stamp} · confirmed 2019-10-01`).waitFor();
    await dialog.getByText('Casual Leave 7.5').waitFor();
    await dialog.locator('button[type=submit]').click();
    await hr.waitForURL(/\/employees\/[0-9a-f-]{36}$/, { timeout: 15000 });
    await hr.getByRole('heading', { name: `Kavita Rane ${stamp}` }).waitFor();
    await hr.getByText(`KR-${stamp}`).first().waitFor();
    await hr.getByText('Machine Operator').first().waitFor();
    const existingUrl = hr.url();
    await hr.goto(existingUrl + '?tab=leave');
    const casualCard = hr.locator('div', { hasText: /^Casual Leave/ }).filter({ hasText: 'days available' }).last();
    await casualCard.getByText('7.50', { exact: true }).waitFor();
    await hr.goto(existingUrl + '?tab=onboarding');
    await hr.getByText(/No onboarding checklist|no checklist/i).first().waitFor();
    ok('added someone already working here: own code, joined 2019, confirmed from probation, no joining checklist, opening leave balance 7.5');

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
