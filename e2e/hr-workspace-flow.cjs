/**
 * HR Workspace Admin, background verification, assets, custom fields and the employee import, end to end in a real
 * browser against the demo workspace.
 *
 *   pnpm db:reset
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/hr-workspace-flow.cjs
 *
 * 1. The owner switches Assets off in HR Workspace Admin (it leaves the menu and its page refuses), then back on, and
 *    opens the role matrix for HR Executive.
 * 2. HR registers a laptop and assigns it to Neha; Neha acknowledges it on My assets; HR sees the acknowledgement.
 * 3. HR adds an agency, starts a verification for Neha, verifies the identity check, shares a file and sends the case
 *    to the agency; the agency opens its private link (no login), sees only the shared file and sends its findings;
 *    HR sees them and records the result.
 * 4. HR adds a custom field for employees and fills it in on Neha's profile.
 * 5. HR checks an import file (one row needs fixing), then imports the good row.
 * Module switches and role changes need a recent MFA check: the owner turns MFA on in the step-up dialog. The owner's
 * MFA settings are put back as they were at the end, so the flows after this one see no change.
 * Fails on any browser error. SHOTS=<dir> saves a screenshot of each screen.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));
const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  // A 403 from a module switched off is expected in step 1; the browser logs the failed request.
  p.on('console', (m) => m.type() === 'error' && !/status of 403/.test(m.text()) && errs.push(`${who} ${m.text()}`));
};
const SHOTS = process.env.SHOTS;
const save = async (p, name) => {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' });
};
const fail = async (p, e) => {
  await p.screenshot({ path: process.env.SHOT ?? '/tmp/hr-workspace-fail.png', fullPage: true }).catch(() => {});
  throw e;
};
const see = (p, text, timeout = 10000) => p.getByText(text).first().waitFor({ timeout }).catch((e) => fail(p, e));

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const p = await ctx.newPage();
  watch(p, email);
  // Sign-in is rate limited (10 a minute). After the other flows in CI, wait for the window instead of failing.
  for (let attempt = 0; ; attempt++) {
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

const today = () => new Date().toISOString().slice(0, 10);
const stamp = Date.now().toString(36).slice(-5).toUpperCase();

/** Answers the "Verify it's you" dialog when it opens, turning MFA on the first time. */
async function stepUp(p) {
  const dialog = p.getByTestId('mfa-step-up-dialog');
  if (!(await dialog.waitFor({ timeout: 4000 }).then(() => true, () => false))) return;
  await dialog.getByTestId('mfa-step-up-setup').click();
  const secret = (await dialog.getByTestId('mfa-step-up-secret').textContent()).trim();
  await dialog.getByTestId('mfa-step-up-code').fill(authenticator.generate(secret));
  await dialog.getByTestId('mfa-step-up-submit').click();
  await dialog.waitFor({ state: 'hidden', timeout: 15000 });
}

(async () => {
  const b = await chromium.launch();
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const users = mongo.db().collection('users');
  const ownerBefore = await users.findOne({ email: 'owner@demo.crew.local' });
  if (!ownerBefore) throw new Error('demo owner missing: run pnpm db:reset with CREW_SEED_DEMO=true');
  await users.updateOne({ _id: ownerBefore._id }, { $set: { mfa_enabled: false, mfa_secret_enc: null } });
  try {
    await run(b);
  } finally {
    await users.updateOne({ _id: ownerBefore._id }, { $set: { mfa_enabled: ownerBefore.mfa_enabled ?? false, mfa_secret_enc: ownerBefore.mfa_secret_enc ?? null } });
    await mongo.close();
    await b.close();
  }
  if (errs.length) {
    console.error(errs.join('\n'));
    process.exit(1);
  }
  console.log('hr-workspace flow passed');
})().catch((e) => {
  console.error(e);
  if (errs.length) console.error(errs.join('\n'));
  process.exit(1);
});

async function run(b) {
  // 1. Module access and the role matrix.
  const owner = await signIn(b, 'owner@demo.crew.local');
  await owner.goto(BASE + '/settings/hr-admin');
  await owner.getByRole('heading', { name: 'HR Workspace Admin' }).first().waitFor({ timeout: 10000 }).catch((e) => fail(owner, e));
  const assetsSwitch = owner.getByRole('switch', { name: /^Asset inventory.* on$/ });
  if ((await assetsSwitch.getAttribute('aria-checked')) !== 'true') {
    await assetsSwitch.click();
    await owner.waitForFunction(() => document.querySelector('[role=switch][aria-label^="Asset inventory"]')?.getAttribute('aria-checked') === 'true');
  }
  await assetsSwitch.click();
  await stepUp(owner);
  await see(owner, 'Switched off here');
  await owner.waitForFunction(() => document.querySelector('[role=switch][aria-label^="Asset inventory"]')?.getAttribute('aria-checked') === 'false');
  await save(owner, '01-modules-off');
  await owner.goto(BASE + '/settings/hr-admin');
  if (await owner.getByRole('navigation').getByRole('link', { name: 'Assets', exact: true }).count()) throw new Error('Assets still in the menu while switched off');
  await owner.getByRole('switch', { name: /^Asset inventory.* on$/ }).click();
  await owner.waitForFunction(() => document.querySelector('[role=switch][aria-label^="Asset inventory"]')?.getAttribute('aria-checked') === 'true');
  ok('owner switched Assets off for the workspace (gone from the menu) and back on');

  await owner.getByRole('tab', { name: 'Permissions' }).click();
  // The role list shows each role with its member count: "HR Executive · 0 members".
  const roleSelect = owner.getByLabel('Role', { exact: true });
  await roleSelect.selectOption(await roleSelect.locator('option', { hasText: /^HR Executive ·/ }).getAttribute('value'));
  await owner.getByRole('table', { name: /Permission matrix for HR Executive/ }).waitFor({ timeout: 10000 }).catch((e) => fail(owner, e));
  for (const action of ['View', 'Create', 'Edit', 'Delete', 'Approve', 'Export', 'Manage']) await owner.getByRole('columnheader', { name: action }).first().waitFor({ timeout: 5000 });
  await save(owner, '02-role-matrix');
  if (SHOTS) {
    await owner.getByRole('tab', { name: 'Module settings' }).click();
    await owner.getByText('Module settings').nth(1).waitFor({ timeout: 10000 }).catch(() => {});
    await save(owner, '02b-module-settings');
  }
  ok('owner opened the permission matrix for HR Executive with all seven actions');

  // 2. Assets: register, assign, acknowledge.
  const hr = await signIn(b, 'hr.admin@demo.crew.local');
  await hr.goto(BASE + '/assets');
  await hr.getByRole('button', { name: 'Register asset' }).click();
  const reg = hr.getByRole('dialog');
  const laptopName = `ThinkPad E14 ${stamp}`;
  await reg.getByLabel('Asset name').fill(laptopName);
  await reg.getByLabel('Category').selectOption({ label: 'Laptops (LAP)' });
  await reg.getByLabel('Serial number').fill(`PF-${stamp}`);
  await reg.getByLabel('Brand').fill('Lenovo');
  await reg.getByRole('button', { name: 'Register asset' }).click();
  await hr.waitForURL(/\/assets\/[0-9a-f-]{36}/, { timeout: 15000 }).catch((e) => fail(hr, e));
  const assetUrl = hr.url();
  await hr.getByRole('button', { name: 'Assign to an employee' }).click();
  const assign = hr.getByRole('dialog');
  await assign.getByLabel('Find the employee').fill('Neha');
  await assign.getByRole('button', { name: 'Find' }).click();
  await assign.getByRole('button', { name: /Neha/ }).first().click();
  await assign.getByRole('button', { name: 'Assign', exact: true }).click();
  await see(hr, 'Current holder');
  await hr.getByText(/Waiting for|Not acknowledged/).first().waitFor({ timeout: 10000 }).catch((e) => fail(hr, e));
  await save(hr, '03-asset-assigned');
  ok(`HR registered ${laptopName} and assigned it to Neha`);

  const neha = await signIn(b, 'operator2@demo.crew.local');
  await neha.goto(BASE + '/assets/mine');
  const card = neha.locator('form', { hasText: 'I received it' }).first();
  await card.waitFor({ timeout: 10000 }).catch((e) => fail(neha, e));
  await card.getByLabel('I received it and agree to the above').check();
  await card.getByLabel('Type your full name').fill('Neha Deshmukh');
  await card.getByRole('button', { name: 'Acknowledge' }).click();
  await see(neha, /You acknowledged it on/);
  await save(neha, '04-my-assets-acknowledged');
  await hr.goto(assetUrl);
  await hr.getByText(/Acknowledged/).first().waitFor({ timeout: 10000 }).catch((e) => fail(hr, e));
  await save(hr, '04b-asset-acknowledged');
  ok('Neha acknowledged the laptop on My assets; HR sees the acknowledgement');
  if (SHOTS) {
    await hr.goto(BASE + '/assets');
    await save(hr, '04c-asset-register');
    await hr.goto(BASE + '/assets/reports');
    await save(hr, '04d-asset-reports');
  }

  // 3. Background verification with an agency.
  await hr.goto(BASE + '/verification/agencies');
  await hr.getByRole('button', { name: 'Add agency' }).click();
  const ag = hr.getByRole('dialog');
  const agencyName = `Trust Check ${stamp}`;
  await ag.getByLabel('Agency name').fill(agencyName);
  await ag.getByLabel('Email').fill(`desk.${stamp.toLowerCase()}@trustcheck.example`);
  await ag.getByLabel('Employment').check();
  await ag.getByRole('button', { name: 'Save agency' }).click();
  await see(hr, agencyName);
  ok('HR added a verification agency');

  await hr.goto(BASE + '/verification');
  await hr.getByRole('button', { name: 'Start verification' }).first().click();
  const start = hr.getByRole('dialog');
  await start.getByLabel('Find the employee').fill('Neha');
  await start.getByRole('button', { name: 'Find' }).click();
  await start.getByRole('button', { name: /Neha/ }).first().click();
  await start.getByRole('button', { name: 'Start verification' }).click();
  await hr.waitForURL(/\/verification\/[0-9a-f-]{36}/, { timeout: 15000 }).catch((e) => fail(hr, e));
  const caseUrl = hr.url();
  const identity = hr.getByRole('form', { name: 'Identity check' });
  await identity.getByLabel('Check status').selectOption('verified');
  await identity.getByLabel('Internal remarks').fill('Matched the Aadhaar card with the original');
  await identity.getByRole('button', { name: /^Save identity/ }).click();
  await see(hr, /saved|updated/i);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bgv-'));
  const letter = path.join(tmp, 'relieving-letter.pdf');
  fs.writeFileSync(letter, '%PDF-1.4\n% relieving letter for the e2e flow\n');
  await hr.getByLabel('Title').fill('Relieving letter');
  await hr.getByLabel('File').setInputFiles(letter);
  await hr.getByLabel('Share with the agency').check();
  await hr.getByRole('button', { name: /Upload/ }).first().click();
  await hr.getByRole('table', { name: 'Case files' }).getByText('Relieving letter').waitFor({ timeout: 10000 }).catch((e) => fail(hr, e));
  await hr.getByLabel('Agency', { exact: true }).selectOption({ label: agencyName });
  await hr.getByRole('button', { name: 'Send to the agency' }).click();
  const link = await hr.locator('.font-mono', { hasText: '/verify/' }).first().textContent({ timeout: 10000 }).catch((e) => fail(hr, e));
  await save(hr, '05-case-sent');
  ok('HR started a case for Neha, verified identity, shared a file and sent the case to the agency');

  const agencyCtx = await b.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const agency = await agencyCtx.newPage();
  watch(agency, 'agency');
  await agency.goto(link.trim().replace(/^https?:\/\/[^/]+/, BASE));
  await see(agency, 'Relieving letter');
  await agency.getByText('Internal remarks').count().then((n) => { if (n) throw new Error('agency sees internal remarks'); });
  const employment = agency.locator('fieldset, section, div', { hasText: 'Employment' }).filter({ has: agency.getByLabel('Your finding') }).last();
  await employment.getByLabel('Your finding').selectOption('verified');
  await employment.getByLabel('Details').fill('Confirmed with the previous employer: dates and designation match');
  await agency.getByLabel('Your name').fill('Ravi, Trust Check');
  await agency.getByLabel('Summary').fill('Employment confirmed');
  await agency.getByRole('button', { name: 'Send findings' }).click();
  await see(agency, /Thank you|sent/i);
  await save(agency, '06-agency-portal');
  ok('the agency opened its private link without signing in, saw only the shared file and sent its findings');

  await hr.goto(caseUrl);
  await see(hr, 'Confirmed with the previous employer');
  for (const name of ['Address', 'Education']) {
    const f = hr.getByRole('form', { name: `${name} check` });
    if (!(await f.count())) continue;
    await f.getByLabel('Check status').selectOption('verified');
    await f.getByRole('button', { name: new RegExp(`^Save ${name.toLowerCase()}`) }).click();
    await hr.waitForTimeout(800);
  }
  await hr.reload();
  await hr.getByRole('button', { name: 'Record the result' }).click();
  const decide = hr.getByRole('dialog');
  await decide.getByLabel('Result').selectOption('verified');
  await decide.getByLabel('Remarks').fill('All checks passed');
  await decide.getByRole('button', { name: 'Save result' }).click();
  await hr.getByText('Verified').first().waitFor({ timeout: 10000 }).catch((e) => fail(hr, e));
  await save(hr, '07-case-verified');
  ok('HR saw the agency findings and recorded the case as verified');
  if (SHOTS) {
    await hr.goto(BASE + '/verification?status=all');
    await save(hr, '07a-verification-list');
  }

  // 4. A custom field on employees, filled in on Neha's profile.
  await hr.goto(BASE + '/settings/custom-fields');
  await hr.getByRole('button', { name: 'Add field' }).click();
  const fd = hr.getByRole('dialog');
  const label = `T-shirt size ${stamp}`;
  await fd.getByLabel('Label').fill(label);
  await fd.getByLabel('Field type').selectOption('short_text');
  await fd.getByRole('button', { name: 'Save field' }).click();
  await hr.getByRole('table', { name: 'Custom fields' }).getByText(label).waitFor({ timeout: 10000 }).catch((e) => fail(hr, e));
  await save(hr, '07b-custom-fields');
  ok('HR added a custom field for employees');

  await hr.goto(BASE + '/employees?q=Neha');
  await hr.getByRole('link', { name: /Neha/ }).first().click();
  await hr.waitForURL(/\/employees\/[0-9a-f-]{36}/, { timeout: 15000 });
  const fields = hr.locator('div', { has: hr.getByText('Fields your workspace added.') }).filter({ has: hr.getByRole('button', { name: 'Edit', exact: true }) }).last();
  await fields.getByRole('button', { name: 'Edit', exact: true }).click().catch((e) => fail(hr, e));
  await fields.getByLabel(label).fill('M');
  await fields.getByRole('button', { name: /^Save/ }).click();
  await see(hr, 'Saved.');
  await hr.getByRole('link', { name: 'Assets', exact: true }).last().click();
  await see(hr, laptopName.split(' ')[0]);
  await hr.getByRole('link', { name: 'Verification', exact: true }).last().click();
  await hr.getByText('Verified').first().waitFor({ timeout: 10000 });
  await save(hr, '08-profile-verification');
  ok("HR filled in the field on Neha's profile; her Assets and Verification tabs show the laptop and the case");

  // 5. Import existing employees.
  const csv = path.join(tmp, 'people.csv');
  fs.writeFileSync(csv, [
    'Employee ID,First name,Last name,Personal email,Legal entity,Original date of joining',
    `IMP-${stamp},Ishaan,Imported,ishaan.${stamp.toLowerCase()}@mail.example,Northwind Manufacturing (Demo),2022-04-01`,
    `IMP-${stamp}B,,Missing,,Northwind Manufacturing (Demo),not-a-date`,
  ].join('\n'));
  await hr.goto(BASE + '/employees/import');
  await hr.getByLabel('Filled-in file').setInputFiles(csv);
  await hr.getByRole('button', { name: 'Check the file' }).click();
  await hr.getByRole('table', { name: 'Import results' }).waitFor({ timeout: 15000 }).catch((e) => fail(hr, e));
  await see(hr, 'Enter the first name');
  await save(hr, '09-import-checked');
  await hr.getByRole('button', { name: 'Import 1 person' }).click().catch((e) => fail(hr, e));
  await see(hr, '1 person was added');
  await save(hr, '09b-import-done');
  await hr.goto(BASE + `/employees?q=IMP-${stamp}`);
  await see(hr, 'Ishaan');
  ok('HR checked an import file (one row to fix) and imported the good row');
  fs.rmSync(tmp, { recursive: true, force: true });
}
