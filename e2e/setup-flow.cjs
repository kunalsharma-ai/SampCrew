/**
 * First-login company setup and the first hire, in a real browser.
 *
 *   pnpm db:reset            # fresh demo workspace
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/setup-flow.cjs
 *
 * 1. A new company signs up and is taken to company setup before anything else.
 * 2. The admin fills in the company profile, adds a location, and keeps the ready-made departments and designations.
 * 3. Finishing setup opens the guided hire. The admin adds a designation and a shift without leaving it, uploads a
 *    photo, and creates the SampCrew login with a temporary password, which is shown once.
 * 4. The new employee signs in with the temporary password and has to choose their own before going on.
 * 5. The admin sees the login ID and status on the profile, resets the password (shown once), and locks and unlocks it.
 * Fails on any browser error.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';

const ok = (m) => console.log(`ok - ${m}`);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource.*40[134]/.test(m.text()) && errs.push(`${who} ${m.text()}`));
};
// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const b = await chromium.launch();
  const stamp = Date.now();
  const slug = `setup-${stamp}`;
  const adminEmail = `admin@${slug}.test`;
  const adminPassword = 'Setup-Admin-Pass-2026!';
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const admin = await ctx.newPage();
  watch(admin, 'admin');
  try {
    // 1. Sign up.
    await admin.goto(BASE + '/signup');
    await admin.getByLabel('Company name').fill(`Setup Works ${stamp % 10000}`);
    await admin.getByLabel('Workspace address').fill(slug);
    await admin.fill('input[name=fullName]', 'Asha Admin');
    await admin.fill('input[name=email]', adminEmail);
    await admin.fill('input[name=password]', adminPassword);
    await admin.getByText('I agree to the SAMPLEDGE terms').click();
    await admin.getByRole('button', { name: 'Create workspace' }).click();
    await admin.waitForURL((u) => u.pathname === '/setup', { timeout: 20000 });
    ok('a new workspace opens company setup first');

    // 2. Company, location, departments, designations.
    await admin.locator('select[name=industry]').selectOption('manufacturing');
    await admin.locator('select[name=companySize]').selectOption('51-200');
    await admin.fill('input[name=legalName]', 'Setup Works Private Limited');
    await admin.fill('input[name=contactEmail]', `hr@${slug}.test`);
    await admin.getByRole('button', { name: 'Save and continue' }).click();
    await admin.getByLabel('Location name').waitFor();
    await admin.getByLabel('Location name').fill('Pune plant');
    await admin.getByLabel('City').fill('Pune');
    await admin.getByRole('button', { name: 'Add location' }).click();
    await admin.locator('[aria-label="Locations added"]').getByText('Pune plant').waitFor();
    await admin.getByRole('button', { name: 'Continue' }).click();
    await admin.locator('[aria-label="Suggested departments"]').getByText('Production').waitFor();
    await admin.getByRole('button', { name: /^Add \d+ and continue$/ }).click();
    await admin.locator('[aria-label="Suggested designations"]').getByText('Machine Operator').waitFor();
    await admin.getByRole('button', { name: /^Add \d+ and continue$/ }).click();
    // The summary shows what was added once the page has refreshed.
    await admin.getByText('You are ready to add employees').waitFor();
    for (const label of ['Locations', 'Departments', 'Designations']) await admin.locator('li', { hasText: new RegExp(`^${label}[1-9]\\d* added`) }).waitFor();
    await admin.waitForLoadState('networkidle');
    ok('company profile saved, a location added and the ready-made manufacturing departments and designations kept');

    await admin.getByRole('button', { name: 'Finish setup and add the first employee' }).click();
    await admin.waitForURL(/\/employees\?create=employee/, { timeout: 15000 });
    const dialog = admin.locator('dialog[open]');
    await dialog.locator('input[name=firstName]').waitFor();
    ok('finishing setup opens the guided hire');

    // 3. The first hire.
    const email = `ravi.${stamp}@${slug}.test`;
    const shot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-')), 'ravi.png');
    fs.writeFileSync(shot, PNG);
    await dialog.locator('input[name=firstName]').fill('Ravi');
    await dialog.locator('input[name=lastName]').fill('Kale');
    await dialog.locator('input[name=workEmail]').fill(email);
    await dialog.locator('input[type=file][accept*="image"]').setInputFiles(shot);
    await dialog.getByRole('button', { name: 'Next: Employment' }).click();
    await dialog.locator('h3', { hasText: 'Employment' }).waitFor();
    const designations = await dialog.locator('select[name=designationId] option').allTextContents();
    expect(designations.includes('Machine Operator'), `designations missing: ${designations.join(', ')}`);
    await dialog.getByRole('button', { name: 'New designation' }).click();
    await dialog.getByLabel('New designation name').fill('Line Auditor');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await admin.waitForFunction(() => document.querySelector('dialog[open] select[name=designationId] option:checked')?.textContent === 'Line Auditor');
    // Typing a name that is already on the list picks it instead of adding it twice.
    await dialog.getByRole('button', { name: 'New designation' }).click();
    await dialog.getByLabel('New designation name').fill('machine operator');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await admin.waitForFunction(() => document.querySelector('dialog[open] select[name=designationId] option:checked')?.textContent === 'Machine Operator');
    expect((await dialog.locator('select[name=designationId] option', { hasText: /^Machine Operator$/ }).count()) === 1, 'Machine Operator listed twice');
    await dialog.locator('select[name=designationId]').selectOption({ label: 'Line Auditor' });
    await dialog.getByRole('button', { name: 'Next: Department & reporting' }).click();
    await dialog.locator('select[name=departmentId]').selectOption({ label: 'Production' });
    await dialog.locator('select[name=locationId]').selectOption({ label: 'Pune plant' });
    await dialog.getByRole('button', { name: 'Next: Compensation' }).click();
    await dialog.getByRole('button', { name: 'Next: Documents' }).click();
    await dialog.getByRole('button', { name: 'Next: Attendance & access' }).click();
    await dialog.getByRole('button', { name: 'New shift' }).click();
    await dialog.getByLabel('New shift name').fill('Early shift');
    await dialog.getByLabel('Shift starts').fill('06:00');
    await dialog.getByLabel('Shift ends').fill('14:00');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await admin.waitForFunction(() => document.querySelector('dialog[open] select[name=defaultShiftId] option:checked')?.textContent?.startsWith('Early shift'));
    await dialog.getByText('Create the login now').click();
    await dialog.getByRole('button', { name: 'Next: Review' }).click();
    await dialog.getByText('Production ·').waitFor();
    await dialog.locator('button[type=submit]').click();
    const temp = (await admin.getByTestId('temporary-password').textContent({ timeout: 15000 })).trim();
    expect(temp.length === 16, `temporary password looks wrong: ${temp}`);
    await admin.getByRole('button', { name: 'Done' }).click();
    ok('hired with a photo, a designation and a shift added on the spot, and a login with a one-time temporary password');

    await admin.getByRole('link', { name: /Ravi Kale/ }).first().click();
    await admin.waitForURL(/\/employees\/[0-9a-f-]{36}/);
    const profileUrl = admin.url().split('?')[0];
    await admin.getByRole('heading', { name: 'Ravi Kale' }).waitFor();
    await admin.locator(`img[src*="/employee-photos/"]`).first().waitFor();
    await admin.getByText('Early shift').first().waitFor();
    ok('the profile shows the photo and the usual shift');

    // 4. The employee's first sign-in.
    const ectx = await b.newContext({ viewport: { width: 1360, height: 900 } });
    const emp = await ectx.newPage();
    watch(emp, 'employee');
    const signIn = async (password) => {
      await emp.goto(BASE + '/login');
      await emp.fill('input[name=email]', email);
      await emp.fill('input[name=password]', password);
      await emp.click('button[type=submit]');
    };
    const chooseOwn = async (password, next) => {
      await signIn(password);
      await emp.getByText('Choose your password').first().waitFor({ timeout: 15000 });
      await emp.fill('input[name=newPassword]', next);
      await emp.fill('input[name=confirmPassword]', next);
      await emp.click('button[type=submit]');
      await emp.waitForURL((u) => u.pathname === '/', { timeout: 15000 });
    };
    await chooseOwn(temp, 'Ravi-Own-Password-2026');
    ok('the employee signed in with the temporary password and had to choose their own first');

    // 5. Login control on the profile.
    await admin.goto(profileUrl);
    const card = admin.locator('[aria-label="SampCrew login"]');
    await card.getByTestId('login-id').filter({ hasText: email }).waitFor();
    await card.getByText('Active', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Reset password' }).click();
    await admin.locator('dialog[open]').getByRole('button', { name: 'Reset password' }).click();
    const reset = (await admin.getByTestId('temporary-password').textContent({ timeout: 15000 })).trim();
    expect(reset.length === 16 && reset !== temp, 'no new temporary password after the reset');
    await admin.getByRole('button', { name: 'Done' }).click();
    await card.getByText('Must choose a new password').waitFor();
    await chooseOwn(reset, 'Ravi-Own-Password-2027');
    ok('the admin sees the login ID and status, reset the password once, and the employee chose a new one');

    await admin.reload();
    admin.once('dialog', (d) => d.accept());
    await card.getByRole('button', { name: 'Lock' }).click();
    await card.getByText('Locked by an admin').waitFor();
    await signIn('Ravi-Own-Password-2027');
    await emp.waitForTimeout(1500);
    expect(new URL(emp.url()).pathname === '/login', 'a locked login could still sign in');
    await card.getByRole('button', { name: 'Unlock' }).click();
    await card.getByText('Active', { exact: true }).waitFor();
    await signIn('Ravi-Own-Password-2027');
    await emp.waitForURL((u) => u.pathname === '/', { timeout: 15000 });
    ok('locking stops sign-in and unlocking restores it');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    ok('no browser errors');
  } catch (e) {
    await admin.screenshot({ path: process.env.SHOT ?? '/tmp/setup-fail.png' }).catch(() => {});
    console.error(errs.join('\n'));
    throw e;
  } finally {
    await b.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
