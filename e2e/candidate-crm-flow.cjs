/**
 * Candidate CRM, end to end in the Web Portal, against the demo workspace:
 *   pnpm db:reset; API on :4000, Web Portal on :3000, then: pnpm e2e:candidate-crm   (SHOTS=<dir> saves screenshots)
 *
 * 1. Super Workspace (Aarav Mehta) opens CRM Settings and switches Candidate CRM on for the company-wide HR team,
 *    with import and export allowed. Before that the recruiter has no Candidate CRM in the menu.
 * 2. The recruiter (Kabir Shah, HR Workspace) adds Kunal Sharma with the candidate form: contact details, profession,
 *    experience, pay, notice period and a reference. The profile opens with a CAN- Candidate ID.
 * 3. They schedule a follow-up for tomorrow; it shows on the profile and on the Follow-ups page.
 * 4. They log a call with its outcome, then move Kunal to Screening. The timeline shows the move, the call and the
 *    follow-up, and still does after a reload.
 * 5. All Candidates finds him by name; the pipeline board shows him under Screening; the Excel export downloads.
 * 6. Super Workspace switches the CRM off for the HR team: the recruiter's CRM pages refuse with the reason, and the
 *    data is still there for Super Workspace. It is switched back on at the end so later flows see the same state.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));
const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const shot = (p, name) => (process.env.SHOTS ? p.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const stamp = Date.now().toString().slice(-6);
const EMAIL = `kunal.sharma.${stamp}@example.com`;
const PHONE = `+91 98${stamp.slice(0, 3)} ${stamp.slice(3)}11`;

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: process.env.SHOTS ? 2 : 1, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
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
    if (attempt >= 4) throw new Error('sign-in stayed rate limited');
    await p.waitForTimeout(20000);
  }
}

async function setCentralAccess(p, on) {
  await p.goto(BASE + '/recruitment/crm/settings');
  const row = p.getByTestId('crm-access-central');
  await row.waitFor();
  const sw = row.getByRole('switch', { name: /Candidate CRM for/ });
  if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click();
  if (on) {
    for (const cap of ['Import candidates', 'Export candidates']) {
      const box = row.getByRole('checkbox', { name: new RegExp(`^${cap}`) });
      if (!(await box.isChecked())) await box.check();
    }
  }
  const save = p.getByRole('button', { name: 'Save access' });
  if (await save.isEnabled()) {
    await save.click();
    await p.getByText('Access saved.').waitFor();
  }
}

(async () => {
  const b = await chromium.launch();
  // The demo owner is the Super Workspace; an earlier flow (e2e:web) turned on their MFA. Off for this run, restored after.
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const users = mongo.db().collection('users');
  const ownerBefore = await users.findOne({ email: 'owner@demo.crew.local' });
  await users.updateOne({ _id: ownerBefore._id }, { $set: { mfa_enabled: false, mfa_secret_enc: null } });
  let page;
  try {
    // 1. Before: with the CRM off for the HR team the recruiter has no Candidate CRM. Super Workspace switches it on.
    const owner = await signIn(b, 'owner@demo.crew.local');
    page = owner;
    await setCentralAccess(owner, false);
    const rec = await signIn(b, 'recruiter@demo.crew.local');
    page = rec;
    const nav = rec.getByRole('navigation');
    const crmLink = nav.getByRole('link', { name: 'Candidate CRM' });
    await nav.getByRole('link', { name: 'Candidates', exact: true }).waitFor();
    expect(await crmLink.count() === 0, 'the recruiter sees Candidate CRM while it is switched off');
    await rec.goto(BASE + '/recruitment/crm');
    await rec.waitForURL(/\/no-access\?reason=crm_not_enabled/);
    page = owner;
    await setCentralAccess(owner, true);
    await shot(owner, 'crm-settings-access');
    ok('Candidate CRM was hidden from the recruiter until Super Workspace switched it on for the company-wide HR team');

    // 2. The recruiter adds Kunal Sharma.
    page = rec;
    await rec.goto(BASE + '/');
    await crmLink.first().click();
    await rec.waitForURL(/\/recruitment\/crm$/);
    await rec.getByRole('heading', { name: 'Candidate CRM' }).waitFor();
    await rec.getByRole('link', { name: 'Add candidate' }).first().click();
    await rec.waitForURL(/\/recruitment\/crm\/candidates\/new$/);
    await rec.getByLabel('First name').fill('Kunal');
    await rec.getByLabel('Last name', { exact: true }).fill('Sharma');
    await rec.getByLabel('Email', { exact: true }).fill(EMAIL);
    await rec.getByLabel('Mobile number').fill(PHONE);
    await rec.getByLabel('Current location').fill('Andheri, Mumbai');
    await rec.getByLabel('City', { exact: true }).fill('Mumbai');
    await rec.getByLabel('Current profession').fill('Software Engineer');
    await rec.getByLabel('Current company').fill('Infosys');
    await rec.getByLabel('Total experience', { exact: true }).fill('5');
    await rec.getByLabel('Total experience months').fill('6');
    await rec.getByLabel('Primary skills').fill('Java, Spring Boot, AWS');
    await rec.getByLabel('Current CTC').fill('1200000');
    await rec.getByLabel('Expected CTC').fill('1600000');
    await rec.getByLabel('Notice period', { exact: true }).selectOption('30_days');
    await rec.getByLabel('Source', { exact: true }).selectOption('linkedin');
    await rec.getByRole('button', { name: 'Add reference' }).click();
    await rec.getByLabel('Reference type').selectOption('employee_referral');
    await rec.getByLabel('Reference name').fill('Rahul Verma');
    await rec.getByLabel('First remark').fill('Strong backend profile, open to Pune.');
    await shot(rec, 'crm-add-candidate');
    await rec.getByLabel('The candidate agreed to share these details with us for recruitment').check();
    await rec.getByRole('button', { name: 'Add candidate', exact: true }).click();
    await rec.waitForURL(/\/recruitment\/crm\/candidates\/[0-9a-f-]{36}\?saved=added$/);
    const profileUrl = rec.url().replace(/\?.*$/, '');
    const candidateId = profileUrl.split('/').pop();
    const kunal = (scope) => scope.locator(`a[href^="/recruitment/crm/candidates/${candidateId}"]`);
    const code = (await rec.getByTestId('crm-candidate-code').innerText()).trim();
    expect(/^CAN-\d{6}$/.test(code), `unexpected Candidate ID ${code}`);
    await rec.getByText(`Candidate added as ${code}.`).waitFor();
    await rec.getByRole('heading', { name: 'Kunal Sharma' }).waitFor();
    ok(`added Kunal Sharma as ${code}`);

    // 3. Follow-up for tomorrow.
    await rec.getByRole('button', { name: 'Schedule follow-up' }).click();
    const fu = rec.locator('dialog[open]');
    await fu.getByLabel('Follow-up type').selectOption('salary_discussion');
    await fu.getByLabel('Priority').selectOption('high');
    await fu.getByLabel('Reason').fill('Discuss expected CTC');
    await fu.getByRole('button', { name: 'Schedule' }).click();
    await rec.getByText('Follow-up scheduled.').waitFor();
    await rec.goto(`${profileUrl}?tab=follow-ups`);
    await rec.getByTestId('crm-follow-up').filter({ hasText: 'Salary Discussion' }).waitFor();
    await rec.goto(BASE + '/recruitment/crm/follow-ups?bucket=upcoming');
    await kunal(rec.getByRole('table', { name: 'Follow-ups' })).waitFor();
    await shot(rec, 'crm-follow-ups');
    ok('scheduled a salary discussion follow-up; it shows on the profile and in Follow-ups');

    // 4. Call, then Screening.
    await rec.goto(profileUrl);
    await rec.getByRole('button', { name: 'Log call or activity' }).click();
    const act = rec.locator('dialog[open]');
    await act.getByLabel('Outcome').selectOption('interested');
    await act.getByLabel('Remarks').fill('Interested in the Pune backend role.');
    await act.getByRole('button', { name: 'Save' }).click();
    await rec.getByText('Activity logged.').waitFor();
    await rec.getByLabel('Change stage').selectOption('screening');
    const st = rec.locator('dialog[open]');
    await st.getByLabel('Note').fill('Cleared the first call');
    await st.getByRole('button', { name: 'Move' }).click();
    await rec.getByText('Stage changed.').waitFor();
    await rec.reload();
    await shot(rec, 'crm-profile');
    await rec.goto(`${profileUrl}?tab=timeline`);
    const tl = rec.getByTestId('crm-timeline');
    await tl.getByText('Moved from New Candidate to Screening').waitFor();
    for (const t of [/Call · Interested/, /Follow-up scheduled: Salary Discussion/, /Candidate record created as CAN-/]) expect(await tl.getByText(t).count() > 0, `timeline is missing ${t}`);
    await shot(rec, 'crm-timeline');
    ok('logged an interested call and moved Kunal to Screening; the timeline shows both after a reload');

    // 5. List, pipeline, export.
    await rec.goto(BASE + '/recruitment/crm/candidates');
    await rec.getByLabel('Search candidates').fill('Kunal Sharma');
    await rec.getByLabel('Search candidates').press('Enter');
    await rec.waitForURL(/q=Kunal/);
    const row = rec.getByRole('table', { name: 'Candidates' }).locator('tbody tr').filter({ has: kunal(rec) });
    await row.first().waitFor();
    await row.first().getByText(code).waitFor();
    await row.first().getByText('Screening').waitFor();
    await shot(rec, 'crm-all-candidates');
    await rec.goto(BASE + '/recruitment/crm/pipeline');
    await kunal(rec.getByRole('region', { name: 'Screening', exact: true })).waitFor();
    await shot(rec, 'crm-pipeline');
    await rec.goto(BASE + `/recruitment/crm/export?q=${encodeURIComponent('Kunal Sharma')}`);
    const [dl] = await Promise.all([rec.waitForEvent('download'), rec.getByRole('button', { name: /^Download Excel/ }).click()]);
    const xlsx = fs.readFileSync(await dl.path());
    expect(xlsx.subarray(0, 2).toString() === 'PK' && /\.xlsx$/.test(dl.suggestedFilename()), `Excel download looks wrong: ${dl.suggestedFilename()}`);
    await rec.reload();
    await rec.getByRole('table', { name: 'Export log' }).getByText('Kabir Shah').first().waitFor();
    ok(`found Kunal in All Candidates and under Screening on the board; exported ${dl.suggestedFilename()} and it is in the export log`);

    // 5b. Import a spreadsheet: one row is Kunal again (same email), one has no email or phone.
    const people = [
      ['Neha Kapoor', 'Product Designer', 'Swiggy', '4 years', '14 LPA', '18 LPA', '30 days', 'Bengaluru', 'Naukri', 'Screening'],
      ['Arvind Iyer', 'Data Engineer', 'TCS', '6.5 yrs', '1800000', '2400000', '60 days', 'Chennai', 'LinkedIn', 'Interview Scheduled'],
      ['Sana Qureshi', 'HR Generalist', 'Wipro', '3 years 2 months', '7.5 LPA', '9 LPA', 'Immediate', 'Pune', 'Referral', 'New Candidate'],
      ['Rohit Menon', 'Sales Manager', 'HDFC Bank', '8 years', '22 LPA', '28 LPA', '90 days', 'Mumbai', 'Job Portal', 'Shortlisted'],
    ];
    const rows = [
      ['Candidate Name', 'Email', 'Mobile', 'Designation', 'Company', 'Experience', 'Current CTC', 'Expected CTC', 'Notice Period', 'Location', 'Source', 'Status'],
      ...people.map(([n, t, c, e, cc, ec, np, l, src, st], i) => [n, `${n.toLowerCase().replace(' ', '.')}.${stamp}@example.com`, `+91 97${stamp.slice(0, 3)} ${stamp.slice(3)}${20 + i}`, t, c, e, cc, ec, np, l, src, st]),
      ['Kunal Sharma', EMAIL, '', 'Software Engineer', 'Infosys', '5.5 years', '12 LPA', '16 LPA', '30 days', 'Mumbai', 'LinkedIn', ''],
      ['No Contact', '', '', 'Analyst', 'Acme', '2 years', '', '', '', '', '', ''],
    ];
    const csv = rows.map((r) => r.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n');
    await rec.goto(BASE + '/recruitment/crm/import');
    await rec.locator('input[name=file]').setInputFiles({ name: 'candidates.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await rec.getByRole('button', { name: 'Upload' }).click();
    await rec.getByRole('heading', { name: 'Match columns' }).waitFor();
    expect(await rec.getByLabel('Field for Candidate Name').inputValue() === 'fullName', 'Candidate Name was not matched to Full Name');
    await shot(rec, 'crm-import-mapping');
    await rec.getByRole('button', { name: 'Check rows' }).click();
    const counts = rec.getByTestId('crm-import-counts');
    await counts.getByText('4 ready').waitFor();
    await counts.getByText('1 already exist').waitFor();
    await counts.getByText('1 with problems').waitFor();
    await shot(rec, 'crm-import-check');
    await rec.getByLabel('These candidates agreed to share their details with us for recruitment').check();
    await rec.getByRole('button', { name: 'Import candidates' }).click();
    const result = rec.getByTestId('crm-import-result');
    await result.getByText('4 added').waitFor();
    await result.getByText('2 skipped').or(result.getByText('1 skipped')).first().waitFor();
    const [problems] = await Promise.all([rec.waitForEvent('download'), rec.getByRole('link', { name: 'Download error report' }).click()]);
    expect(/problems\.xlsx$/.test(problems.suggestedFilename()), `error report looks wrong: ${problems.suggestedFilename()}`);
    await rec.goto(BASE + `/recruitment/crm/candidates?q=${encodeURIComponent('Arvind Iyer')}`);
    await rec.getByRole('table', { name: 'Candidates' }).getByText('Interview Scheduled').first().waitFor();
    ok('imported 4 candidates from CSV (Kunal recognised as a duplicate, a row without contact details reported) with an error report');

    await rec.goto(BASE + '/recruitment/crm');
    await shot(rec, 'crm-overview');

    // 6. Switching off hides the CRM from the HR team and keeps the data.
    page = owner;
    await setCentralAccess(owner, false);
    await rec.goto(profileUrl);
    await rec.waitForURL(/\/no-access\?reason=crm_not_enabled/);
    await owner.goto(profileUrl);
    await owner.getByTestId('crm-candidate-code').getByText(code).waitFor();
    await setCentralAccess(owner, true);
    ok('switched off for the HR team: the recruiter is refused, Super Workspace still sees Kunal; switched back on');

    const real = errs.filter((e) => !/favicon|DevTools|Failed to load resource: the server responded with a status of 403/.test(e));
    expect(!real.length, `browser errors:\n${real.join('\n')}`);
    console.log('candidate crm flow passed');
  } catch (e) {
    console.error(e);
    await page?.screenshot({ path: 'candidate-crm-failure.png', fullPage: true }).catch(() => {});
    console.error(errs.join('\n'));
    process.exitCode = 1;
  } finally {
    await users.updateOne({ _id: ownerBefore._id }, { $set: { mfa_enabled: ownerBefore.mfa_enabled ?? false, mfa_secret_enc: ownerBefore.mfa_secret_enc ?? null } });
    await mongo.close();
    await b.close();
  }
})();
