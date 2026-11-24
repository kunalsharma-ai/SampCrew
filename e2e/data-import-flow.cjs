/**
 * Data import, master data and bulk changes, end to end in a real browser against the demo workspace.
 *
 *   pnpm db:reset
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/data-import-flow.cjs
 *
 * 1. Super Workspace (the owner): the import hub lists every kind of record; the employee template downloads.
 * 2. The owner uploads a CSV of employees. Sure columns are matched, a likely one waits to be confirmed, and an unknown
 *    column ("Canteen Plan") is detected as new: the owner creates a field for it with the suggested type.
 * 3. The check finds an error row and a row matching someone already in SampCrew; the owner decides to update that
 *    person, imports, watches it finish and downloads the report. The new people are real records: their manager
 *    (from the same file), a department added on the way, the custom field value, and the updated existing person.
 * 4. The owner picks two imported people in the Employees list and moves them to another department together.
 * 5. Master data: the owner adds an industry, disables it, and opens the library of job roles.
 * 6. HR Workspace level: the owner makes an HR Workspace with Data import and the supervisor as admin; the supervisor can import
 *    employees. The owner switches "Import employee data" off for it and the supervisor loses Data import. The HR
 *    Workspace is archived at the end, so later flows see the demo workspace as it was.
 * 7. Employee Workspace: an employee without HR access has no Data import and the page refuses them.
 * Fails on any browser error. SHOTS=<dir> saves a screenshot of each screen.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
require('./delete-password.cjs');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));
const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  // Step 6 and 7 open pages the person may not use: the refused request is logged by the browser.
  p.on('console', (m) => m.type() === 'error' && !/status of 403/.test(m.text()) && errs.push(`${who} ${m.text()}`));
};
const SHOTS = process.env.SHOTS;
const save = async (p, name) => {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' });
};
const fail = async (p, e) => {
  await p.screenshot({ path: process.env.SHOT ?? '/tmp/data-import-fail.png', fullPage: true }).catch(() => {});
  throw e;
};
const see = (p, text, timeout = 15000) => p.getByText(text).first().waitFor({ timeout }).catch((e) => fail(p, e));
const stamp = Date.now().toString(36).slice(-5).toUpperCase();

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: SHOTS ? 1600 : 900 }, deviceScaleFactor: SHOTS ? 2 : 1, acceptDownloads: true });
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

(async () => {
  const mongo = await MongoClient.connect(MONGODB_URL);
  const db = mongo.db();
  const b = await chromium.launch();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-import-'));
  try {
    const tenant = await db.collection('tenants').findOne({ slug: 'demo-northwind' });
    const t = { tenant_id: tenant._id };
    const arjun = await db.collection('employees').findOne({ ...t, work_email: 'operator1@demo.crew.local' });

    // 1. The hub and a template.
    const owner = await signIn(b, 'owner@demo.crew.local');
    await owner.goto(BASE + '/imports');
    await see(owner, 'What do you want to import?');
    for (const k of ['employees', 'candidates', 'clients', 'contacts', 'departments', 'job_titles', 'master_values']) await owner.getByTestId(`import-type-${k}`).waitFor({ timeout: 5000 }).catch((e) => fail(owner, e));
    const tpl = await owner.request.get(BASE + '/import-template/employees');
    if (tpl.status() !== 200 || !/spreadsheetml/.test(tpl.headers()['content-type'] ?? '')) throw new Error(`template: ${tpl.status()} ${tpl.headers()['content-type']}`);
    await save(owner, '01-import-hub');
    ok('the Super Workspace sees every kind of import, and the employee template downloads as Excel');

    // 2. Upload and match columns.
    const code = (n) => `E2E-${stamp}-${n}`;
    const mail = (n) => `e2e.${stamp.toLowerCase()}.${n}@northwind.example`;
    const csv = path.join(tmp, 'employees.csv');
    fs.writeFileSync(csv, [
      `Emp ID,Full Name,Work Email,Mobil Number,Company,Department,Designation,Date of Joining,Reporting Manager,Canteen Plan`,
      `${code(1)},Riya Kapoor,${mail(1)},9820012345,Northwind Manufacturing (Demo),Quality Assurance,Quality Inspector,2023-01-10,${code(2)},Veg`,
      `${code(2)},Dev Malhotra,${mail(2)},9820012346,Northwind Manufacturing (Demo),Quality Assurance,Quality Manager,2021-06-01,,Veg`,
      `${code(3)},Sara Iqbal,${mail(3)},9820012347,Northwind Manufacturing (Demo),Data Science ${stamp},Data Analyst,2024-03-04,${code(2)},Non-veg`,
      `${code(4)},Kiran Rao,${mail(4)},9820012348,Northwind Manufacturing (Demo),Assembly Line,Machine Operator,2022-08-05,,Jain`,
      `${arjun.employee_code},Arjun Kulkarni,operator1@demo.crew.local,,Northwind Manufacturing (Demo),Assembly Line,Machine Operator,${String(arjun.date_of_joining).slice(0, 10)},,Veg`,
      `${code(6)},,not-an-email,,Northwind Manufacturing (Demo),Assembly Line,Machine Operator,not-a-date,,Veg`,
    ].join('\n'));
    await owner.getByTestId('import-type-employees').getByRole('link', { name: 'Import' }).click();
    await owner.waitForURL(/\/imports\/new\?type=employees/);
    await owner.getByTestId('import-file').setInputFiles(csv);
    await save(owner, '02-upload');
    await owner.getByRole('button', { name: 'Upload and match columns' }).click();
    await owner.waitForURL(/\/imports\/[0-9a-f-]{36}$/, { timeout: 20000 }).catch((e) => fail(owner, e));
    const jobId = owner.url().split('/').pop();
    await see(owner, 'Match your columns');
    // "Mobil Number" is only likely: it waits for a confirmation, so the check cannot start yet.
    await see(owner, 'Likely: please check');
    if (!(await owner.getByTestId('check-rows').isDisabled())) throw new Error('The check could start with an unconfirmed match');
    await owner.getByTestId('new-column-9').waitFor({ timeout: 5000 }).catch((e) => fail(owner, e));
    await save(owner, '03-mapping-suggested');
    await owner.getByTestId('confirm-3').click();
    await owner.getByTestId('new-column-9').getByRole('button', { name: 'Create field' }).click();
    // The type is suggested from the values: a short list of sizes becomes a dropdown with those choices.
    await owner.waitForFunction(() => [...document.querySelectorAll('select')].some((s) => s.value === 'dropdown'), null, { timeout: 10000 }).catch((e) => fail(owner, e));
    await owner.getByTestId('duplicates').selectOption('ask');
    await owner.getByTestId('hr-workspace').selectOption('central').catch(() => {});
    await save(owner, '04-mapping-new-field');
    await owner.getByTestId('check-rows').click();
    await owner.getByTestId('import-summary').waitFor({ timeout: 30000 }).catch((e) => fail(owner, e));
    ok('sure columns matched, the likely one confirmed, and a new field created for the unknown column');

    // 3. Check, decide, import, report.
    await see(owner, '1 row matches a record you already have');
    await owner.getByTestId('row-7').waitFor({ timeout: 10000 }).catch((e) => fail(owner, e));
    await save(owner, '05-check-problems');
    await owner.getByRole('button', { name: 'All rows' }).click();
    await owner.getByTestId('decide-6').selectOption('update');
    await owner.waitForFunction(() => !document.body.innerText.includes('rows match a record you already have') && !document.body.innerText.includes('row matches a record you already have'), null, { timeout: 15000 }).catch((e) => fail(owner, e));
    await save(owner, '06-check-decided');
    const run = owner.getByTestId('run-import');
    await run.waitFor();
    if (!/Import 5 rows/.test(await run.textContent())) throw new Error(`Import button says: ${await run.textContent()}`);
    await run.click();
    await see(owner, 'Import finished', 60000);
    await see(owner, 'Completed with errors');
    await save(owner, '07-import-finished');
    const report = await owner.request.get(BASE + `/import-report/${jobId}`);
    if (report.status() !== 200 || !/spreadsheetml/.test(report.headers()['content-type'] ?? '')) throw new Error(`report: ${report.status()}`);
    const riya = await db.collection('employees').findOne({ ...t, employee_code: code(1) });
    const dev = await db.collection('employees').findOne({ ...t, employee_code: code(2) });
    if (!riya || !dev) throw new Error('imported employees not found');
    if (riya.current_manager_employee_id !== dev._id) throw new Error(`Riya's manager is ${riya.current_manager_employee_id}, expected Dev from the same file`);
    if (!(await db.collection('departments').findOne({ ...t, name: `Data Science ${stamp}` }))) throw new Error('the new department was not added');
    const field = await db.collection('custom_fields').findOne({ ...t, label: 'Canteen Plan' });
    if (!field || field.type !== 'dropdown') throw new Error(`new field: ${JSON.stringify(field && { type: field.type })}`);
    const values = await db.collection('custom_field_values').find({ ...t, field_id: field._id }).toArray();
    if (!values.some((v) => v.record_id === arjun._id)) throw new Error('the existing employee was not updated with the new field');
    if (await db.collection('employees').findOne({ ...t, employee_code: code(6) })) throw new Error('the error row was imported');
    ok('the error row was left out, the match was updated, and the new people are real records with their manager, department and field');

    await owner.getByRole('link', { name: 'See the records' }).click();
    await owner.waitForURL(/\/employees\?importId=/);
    await see(owner, 'Riya Kapoor');
    await see(owner, 'Showing the people added or updated by one import');

    // 4. Bulk change two of them.
    const rows = owner.getByTestId('row-select');
    await rows.nth(0).check();
    await rows.nth(1).check();
    await owner.getByTestId('bulk-bar').getByRole('button', { name: 'Change them together' }).click();
    const dlg = owner.getByRole('dialog');
    await dlg.getByTestId('bulk-action').selectOption('department');
    await dlg.getByTestId('bulk-target').selectOption({ label: 'Finance' });
    await save(owner, '08-bulk-change');
    await dlg.getByTestId('bulk-apply').click();
    await dlg.getByTestId('bulk-result').waitFor({ timeout: 20000 }).catch((e) => fail(owner, e));
    await dlg.getByText('2 changed').waitFor({ timeout: 5000 }).catch((e) => fail(owner, e));
    await save(owner, '09-bulk-done');
    await dlg.getByRole('button', { name: 'Done' }).click();
    ok('two imported people moved to Finance together, each as a dated job change');

    // 5. Master data.
    await owner.goto(BASE + '/settings/master-data?list=industry');
    await see(owner, 'Industries of clients and companies.');
    await owner.getByTestId('master-add').click();
    const add = owner.getByRole('dialog');
    await add.getByLabel('Name').fill(`Space Tech ${stamp}`);
    await add.getByLabel('Category').fill('Technology');
    await add.getByTestId('master-save').click();
    await see(owner, `Space Tech ${stamp} added`);
    await owner.goto(BASE + `/settings/master-data?list=industry&q=${encodeURIComponent(`Space Tech ${stamp}`)}`);
    await see(owner, `Space Tech ${stamp}`);
    await save(owner, '10-master-data');
    await owner.getByRole('button', { name: 'Disable' }).first().click();
    await see(owner, 'Disabled: it is no longer offered');
    const ind = await db.collection('master_values').findOne({ ...t, list: 'industry', label: `Space Tech ${stamp}` });
    if (!ind?.disabled_at) throw new Error('the industry was not disabled');
    await owner.goto(BASE + '/settings/master-data?list=job_role');
    await owner.getByRole('button', { name: 'Add from the library' }).click();
    await owner.getByRole('dialog').getByText('Job roles: library').waitFor({ timeout: 10000 }).catch((e) => fail(owner, e));
    await save(owner, '11-master-library');
    await owner.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    ok('an industry was added and disabled, and the job role library opens');

    // 6. HR Workspace level and its import switch.
    const NAME = `Import Branch ${stamp}`;
    await owner.goto(BASE + '/hr-workspaces');
    await owner.getByRole('button', { name: 'New HR Workspace' }).first().click();
    const nw = owner.getByRole('dialog');
    await nw.getByLabel('Name').fill(NAME);
    await nw.getByLabel('Short code').fill(`I${stamp}`);
    await nw.getByLabel('Kind').selectOption('branch');
    await nw.getByLabel('Leave management').check();
    await nw.getByLabel(/^Data import from Excel/).check();
    await nw.getByLabel('Find a person').fill('supervisor');
    await nw.locator('label', { hasText: /supervisor/i }).first().click();
    await nw.getByRole('button', { name: 'Create HR Workspace' }).click();
    await owner.waitForURL(/\/hr-workspaces\/[0-9a-f-]{36}/, { timeout: 15000 }).catch((e) => fail(owner, e));
    const wsUrl = owner.url();
    const sup = await signIn(b, 'supervisor@demo.crew.local');
    await sup.goto(BASE + '/imports');
    await see(sup, 'What do you want to import?');
    await sup.getByTestId('import-type-employees').getByRole('link', { name: 'Import' }).waitFor({ timeout: 5000 }).catch((e) => fail(sup, e));
    await save(sup, '12-hr-workspace-imports');
    await owner.getByText('Employee data permissions').first().waitFor({ timeout: 10000 }).catch((e) => fail(owner, e));
    await owner.getByTestId('switch-imports:run').click();
    await see(owner, 'Saved');
    await save(owner, '13-hr-workspace-import-off');
    await sup.goto(BASE + '/imports');
    await sup.waitForTimeout(1000);
    if (await sup.getByText('What do you want to import?').count()) throw new Error('the HR Workspace admin can still import after the switch went off');
    if (await sup.getByRole('link', { name: 'Data import' }).count()) throw new Error('Data import still in the HR Workspace admin’s menu');
    ok('an HR Workspace admin imports until the Super Workspace switches import off for that HR Workspace');
    await owner.goto(wsUrl);
    await owner.getByRole('button', { name: 'Archive' }).click();
    const arch = owner.getByRole('dialog');
    await arch.getByLabel('Reason').fill('End of the browser test');
    await arch.getByRole('button', { name: 'Archive' }).click();
    await owner.waitForURL((u) => u.pathname === '/hr-workspaces', { timeout: 15000 }).catch((e) => fail(owner, e));

    // 7. Employee Workspace.
    const neha = await signIn(b, 'operator2@demo.crew.local');
    if (await neha.getByRole('link', { name: 'Data import' }).count()) throw new Error('Data import in an employee’s menu');
    await neha.goto(BASE + '/imports');
    await neha.waitForTimeout(1000);
    if (await neha.getByText('What do you want to import?').count()) throw new Error('an employee opened Data import');
    await save(neha, '14-employee-no-import');
    ok('the Employee Workspace has no Data import');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('data import flow passed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    await b.close();
    await mongo.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
