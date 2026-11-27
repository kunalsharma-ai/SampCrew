/**
 * Issue #91 (27 Nov feedback) end to end in a real browser, against a fresh demo workspace (it changes the Leave
 * request and Add Employee forms and adds custom fields, so CI runs it in its own step after `pnpm db:reset`).
 *
 *   pnpm db:reset
 *   node apps/api/dist/main.js & pnpm --filter @crew/web start &
 *   node e2e/form-management-flow.cjs        (SHOTS=<dir> saves a screenshot of each screen)
 *
 * 1. Super Workspace, Form management: every form is listed; the Leave request form gets a renamed, required reason
 *    with a placeholder and a custom "Cover person" field; Add Employee hides Grade and gets a custom employee field.
 * 2. HR Workspace: the old Custom fields and Employee form links open Form management read-only, without Save.
 * 3. HR Workspace, Add Employee: the custom employee field is on the form, Grade is not, and no leave days are asked.
 * 4. Employee Workspace, Leave: counts, then My requests (collapses and expands), then the calendar, then My leave
 *    types at the bottom; applying follows the form (required reason with its new label, the custom field), and the
 *    request is sent.
 * 5. Employee Workspace, Attendance: the export dialog offers the report templates; the Monthly Attendance Report
 *    downloads as CSV with the person's own row only.
 * 6. The clock on the home page is the server's: the attendance card shows the server time even with the browser's
 *    clock set hours off.
 * Fails on any browser error.
 */
const path = require('node:path');
const { chromium } = require('playwright');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));

const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const API = `${process.env.CREW_API_URL ?? 'http://localhost:4000'}/api/v1`;
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/status of 404/.test(m.text()) && errs.push(`${who} ${m.text()}`));
};
const SHOTS = process.env.SHOTS;
const save = async (p, name) => {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' });
};
const fail = async (p, e) => {
  await p.screenshot({ path: process.env.SHOT ?? '/tmp/form-management-fail.png', fullPage: true }).catch(() => {});
  throw e;
};
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const see = (p, text, timeout = 20000) => p.getByText(text).first().waitFor({ timeout }).catch((e) => fail(p, e));
const dialogOf = (p) => p.locator('dialog[open]');
const iso = (d) => d.toISOString().slice(0, 10);
/** A Tuesday to Thursday at least three days away in the current year. */
function leaveDay() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 3);
  while (![2, 3, 4].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) throw new Error('Run this test before the last days of December (leave must fall in the current year)');
  return iso(d);
}

async function signIn(b, email, opts = {}) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, acceptDownloads: true, ...opts });
  const p = await ctx.newPage();
  watch(p, email);
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

async function apiAs(email) {
  const r = await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) })).json();
  if (r.status !== 'ok') throw new Error(`${email} API sign-in needs ${r.status}`);
  return async (method, url, body) => {
    const res = await fetch(`${API}${url}`, { method, headers: { authorization: `Bearer ${r.accessToken}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

/** Adds a short text custom field from the Form management page that is open. */
async function addField(p, label) {
  await p.getByTestId('form-add-field').click();
  const fd = dialogOf(p);
  await fd.getByLabel('Label').fill(label);
  await fd.getByLabel('Field type').selectOption('short_text');
  await fd.getByRole('button', { name: 'Save field' }).click();
  await p.getByRole('table', { name: 'Custom fields' }).getByText(label).waitFor({ timeout: 15000 }).catch((e) => fail(p, e));
}

(async () => {
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const db = mongo.db();
  const b = await chromium.launch();
  const stamp = Date.now().toString(36).slice(-4).toUpperCase();
  const asOwner = await apiAs('owner@demo.crew.local');
  const reason = `Why are you away ${stamp}`;
  const cover = `Cover person ${stamp}`;
  const blood = `Blood group ${stamp}`;
  try {
    // 1. Super Workspace: Form management.
    const owner = await signIn(b, 'owner@demo.crew.local');
    await owner.goto(BASE + '/settings/forms');
    const picker = owner.getByTestId('form-picker');
    for (const key of ['add_employee', 'employee_profile', 'leave_request', 'asset', 'bgv_case', 'candidate', 'client']) await picker.getByTestId(`form-pick-${key}`).waitFor();
    await owner.getByTestId('form-current').getByRole('heading', { name: 'Add Employee form' }).waitFor();
    // No field is required by default except the first name.
    const firstName = owner.getByTestId('employee-form-field-firstName');
    await firstName.getByText('Always on: a record needs it').waitFor();
    expect(await owner.getByLabel('Require Last name').isChecked() === false, 'Last name should be optional by default');
    expect(await owner.getByLabel('Show Work email').isEnabled(), 'Work email should be hideable');
    await owner.getByLabel('Show Grade').uncheck();
    await owner.getByTestId('employee-form-save').click();
    await see(owner, 'Saved. The form shows it straight away');
    await save(owner, '01-add-employee-form');

    await picker.getByTestId('form-pick-employee_profile').click();
    await owner.waitForURL(/form=employee_profile/);
    await owner.getByTestId('form-current').getByRole('heading', { name: 'Employee profile form' }).waitFor();
    await addField(owner, blood);
    ok('Super Workspace: every form listed; Add Employee hides Grade; a custom employee field added');

    await picker.getByTestId('form-pick-leave_request').click();
    await owner.waitForURL(/form=leave_request/);
    await owner.getByTestId('form-current').getByRole('heading', { name: 'Leave request form' }).waitFor();
    await owner.getByLabel('Require Reason').check();
    await owner.getByLabel('Label for Reason').fill(reason);
    await owner.getByLabel('Placeholder for Reason').fill('For example: family function');
    await owner.getByTestId('employee-form-save').click();
    await see(owner, 'Saved. The form shows it straight away');
    await addField(owner, cover);
    await save(owner, '02-leave-request-form');
    const rules = await asOwner('GET', '/forms/leave_request');
    expect(rules.resolved[0].required && rules.resolved[0].label === reason, `the reason rule did not save: ${JSON.stringify(rules.resolved)}`);
    ok('Super Workspace: the Leave request form has a required, renamed reason and a custom field');

    // 2. HR Workspace: read-only, from the old links too.
    const hr = await signIn(b, 'hr.admin@demo.crew.local');
    await hr.goto(BASE + '/settings/employee-form');
    await hr.waitForURL(/\/settings\/forms\?form=add_employee/, { timeout: 15000 }).catch((e) => fail(hr, e));
    await see(hr, 'Only the Super Workspace sets up forms');
    expect(await hr.getByTestId('employee-form-save').count() === 0, 'HR must not see Save on Form management');
    await hr.goto(BASE + '/settings/custom-fields?entity=leave_request');
    await hr.waitForURL(/\/settings\/forms\?form=leave_request/, { timeout: 15000 }).catch((e) => fail(hr, e));
    await hr.getByRole('table', { name: 'Custom fields' }).getByText(cover).waitFor();
    expect(await hr.getByTestId('form-add-field').count() === 0, 'HR must not add form fields');
    ok('HR Workspace: Form management opens read-only from the old links');

    // 3. HR Workspace: Add Employee follows the form.
    await hr.goto(BASE + '/employees');
    await hr.getByRole('button', { name: 'Add employee', exact: true }).click();
    const hire = dialogOf(hr);
    await hire.getByTestId('hire-custom-fields').getByText(blood).waitFor({ timeout: 15000 }).catch((e) => fail(hr, e));
    await hire.locator('input[name=firstName]').fill('Form');
    await hire.locator('input[name=lastName]').fill(`Check ${stamp}`);
    await hire.getByRole('button', { name: 'Next: Employment' }).click();
    await hire.locator('h3', { hasText: 'Employment' }).waitFor();
    expect(await hire.locator('input[name=grade]').count() === 0, 'Grade is hidden on Add Employee but still shown');
    expect(await hire.getByTestId('hire-leave').count() === 0, 'the registration form still asks for leave days');
    await hire.locator('[data-testid=hire-leave-rules], [data-testid=hire-leave-later]').first().waitFor();
    await save(hr, '03-add-employee');
    await hr.keyboard.press('Escape');
    ok('HR Workspace: Add Employee shows the custom field, hides Grade and asks for no leave days');

    // 4. Employee Workspace: the Leave page.
    const day = leaveDay();
    const op = await signIn(b, 'operator2@demo.crew.local');
    await op.goto(BASE + `/leave?month=${day.slice(0, 7)}`);
    const top = async (id) => (await op.getByTestId(id).boundingBox()).y;
    await op.getByTestId('my-requests').waitFor();
    const [requestsY, calendarY, typesY] = [await top('my-requests'), await top('leave-calendar'), await top('my-leave-types')];
    expect(requestsY < calendarY && calendarY < typesY, `Leave page order is wrong: requests ${requestsY}, calendar ${calendarY}, types ${typesY}`);
    expect(await top('leave-balances') < requestsY, 'the leave count cards should come before My requests');
    ok('Employee Workspace: counts, My requests, calendar, then My leave types at the bottom');

    await op.getByTestId('leave-calendar').locator(`button[data-date="${day}"]`).click();
    let d = dialogOf(op);
    const optionOf = (name) => d.locator('select[name=leaveTypeId]').evaluate((el, n) => [...el.options].find((o) => o.text.startsWith(n))?.value, name);
    await d.locator('select[name=leaveTypeId]').selectOption(await optionOf('Casual Leave'));
    await d.getByText(reason).waitFor();
    expect(await d.locator('textarea[name=reason]').getAttribute('placeholder') === 'For example: family function', 'the reason placeholder is not the one set');
    await d.getByLabel(cover).fill('Ravi Kumar');
    await d.getByRole('button', { name: 'Submit request' }).click();
    await d.getByText(`${reason} is required`).waitFor();
    await d.locator('textarea[name=reason]').fill('Family function');
    await d.getByRole('button', { name: 'Submit request' }).click();
    await op.getByTestId('leave-sent').waitFor();
    await save(op, '04-leave-sent');
    const req = await db.collection('leave_requests').findOne({ reason: 'Family function', start_date: day });
    expect(req, 'the leave request was not saved');
    const field = await db.collection('custom_fields').findOne({ label: cover });
    const value = await db.collection('custom_field_values').findOne({ field_id: field._id, record_id: req._id });
    expect(value?.value === 'Ravi Kumar', `the custom leave field was not saved: ${JSON.stringify(value)}`);
    ok('Employee Workspace: the leave form asks for the renamed reason, refuses it empty and saves the custom field');

    const requests = op.getByTestId('my-requests');
    await requests.getByText('Family function').first().waitFor();
    await op.getByTestId('my-requests-toggle').click();
    expect(await op.getByTestId('my-requests-toggle').getAttribute('aria-expanded') === 'false', 'My requests did not collapse');
    await requests.getByText('Family function').first().waitFor({ state: 'hidden' });
    await op.getByTestId('my-requests-toggle').click();
    await requests.getByText('Family function').first().waitFor();
    ok('Employee Workspace: My requests collapses and expands');

    // 5. Employee Workspace: report templates in the export dialog.
    await op.goto(BASE + '/attendance');
    await op.getByRole('button', { name: 'Export my attendance' }).click();
    const ed = op.getByTestId('attendance-export-dialog');
    await ed.waitFor();
    const kinds = await ed.getByTestId('export-report').evaluate((el) => [...el.options].map((o) => o.value));
    for (const k of ['standard', 'leave_details', 'monthly_present', 'monthly_performance', 'datewise_performance', 'monthly_attendance', 'monthly_summary', 'in_out']) expect(kinds.includes(k), `the export dialog has no ${k} report`);
    await ed.getByTestId('export-report').selectOption('monthly_attendance');
    await ed.getByTestId('export-format').selectOption('csv');
    await save(op, '05-export-report');
    const href = await ed.getByTestId('export-download').getAttribute('href');
    expect(/report=monthly_attendance/.test(href) && /format=csv/.test(href), `the download link misses the report: ${href}`);
    const res = await op.request.get(new URL(href, BASE).toString());
    expect(res.ok(), `report download failed: ${res.status()} ${await res.text()}`);
    const lines = (await res.text()).replace(/^﻿/, '').trim().split('\r\n');
    expect(/^Emp Code,Name,Department,D01,/.test(lines[1]), `not the Monthly Attendance Report: ${lines[1]}`);
    expect(lines.slice(2, -1).length === 1, `an Employee Workspace export should hold only their own row: ${lines.length}`);
    ok('Employee Workspace: the export dialog offers the report templates; the Monthly Attendance Report downloads with their own row');

    // 6. The server clock: the browser's clock is four hours off, the home page still shows the server's time.
    const skewed = await signIn(b, 'operator2@demo.crew.local');
    await skewed.clock.install({ time: new Date(Date.now() - 4 * 3600_000) });
    await skewed.goto(BASE + '/');
    await skewed.waitForTimeout(1500);
    const shown = (await skewed.getByTestId('home-header').innerText()).replace(/\s+/g, ' ');
    const tz = (await asOwner('GET', '/me')).tenant?.timezone ?? 'Asia/Kolkata';
    // The header's own format: 12-hour with minutes, in the workspace time zone.
    const fmt = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(t).replace(/\s+/g, ' ');
    const near = [-1, 0, 1].map((m) => fmt(new Date(Date.now() + m * 60_000)));
    expect(near.some((t) => shown.includes(t)), `the home page does not show the server time (${near.join(' / ')}); it shows: ${shown}`);
    ok('The home page clock follows the server, not the laptop');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('form management flow passed');
  } finally {
    // Leave the demo workspace as it was for anyone running flows after this one.
    await asOwner('PUT', '/forms/leave_request', { fields: {} }).catch(() => {});
    await asOwner('PUT', '/forms/add_employee', { workEmailDomains: [], enforceWorkEmailDomain: false, fields: {} }).catch(() => {});
    for (const label of [cover, blood]) {
      const f = await db.collection('custom_fields').findOne({ label });
      // Archiving counts as a delete: confirmed with the password first, like the person would.
      if (f) await asOwner('POST', '/me/delete-confirmation', { password: PASSWORD }).then(() => asOwner('POST', `/custom-fields/${f._id}/archive`, { archived: true })).catch((e) => console.log(`cleanup: ${e.message}`));
    }
    await b.close();
    await mongo.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
