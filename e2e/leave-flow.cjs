/**
 * Leave management end-to-end flow in the Web Portal, against the demo workspace.
 *
 *   pnpm db:reset            # fresh demo workspace (HR admin must not have MFA enrolled yet)
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/leave-flow.cjs
 *
 * 1. The Super Workspace (the demo owner) creates Compensatory Off with + Create New Leave Type (visible to both
 *    workspaces), sees who created it, and types the operator's Permanent Leave quantity on the Quantities tab. The HR
 *    Workspace sees the types but has no create button, until the Super Workspace switches "Create leave types" on in
 *    Settings > Workspace Permissions; it is switched off again afterwards.
 * 2. An operator sees their leave types with the rules and Not Assigned for comp-off, sees the route choice for sick leave,
 *    applies for a day of casual leave, then changes the request to two days while it waits.
 * 3. The supervisor (reporting manager step) approves the changed request; the HR Workspace then approves it on the
 *    Approvals tab of Leave management. The application page shows both decisions.
 * 4. The operator changes the approved leave to another day. The original stays approved, marked "Change waiting".
 * 5. The supervisor credits a day of comp-off with a remark on Leave balances and approves the change; HR approves it.
 * 6. The operator sees the original replaced, the comp-off day in their balances, and the new day on the year view.
 * 7. The History tab lists the new type with who created it.
 * Fails on any browser error.
 */
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
  p.on('console', (m) => m.type() === 'error' && errs.push(`${who} ${m.text()}`));
};

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
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

const iso = (d) => d.toISOString().slice(0, 10);
const plus = (day, n) => iso(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000));
/** A Tuesday at least ten days away in the current year, so the day after and the Thursday are working days too. */
function leaveDay() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 10);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) throw new Error('Run this test before mid December (leave must fall in the current year)');
  return iso(d);
}
const dialogOf = (p) => p.locator('dialog[open]');

async function approve(p, text) {
  await p.goto(BASE + '/approvals');
  const card = p.locator('div', { hasText: text }).last();
  await card.locator('button', { hasText: 'Approve' }).click();
  await p.locator(`text=${text}`).first().waitFor({ state: 'detached', timeout: 10000 });
}

/** HR approves the operator's application for a day on the Approvals tab of Leave management. */
async function hrApprove(p, day) {
  await p.goto(BASE + '/leave/manage?tab=approvals');
  const r = p.getByTestId('leave-review-row').filter({ hasText: 'Neha Deshmukh' }).filter({ hasText: day });
  await r.getByTestId('leave-approve').click();
  await p.getByText(/Neha Deshmukh’s application is approved/).waitFor();
}

(async () => {
  const b = await chromium.launch();
  // The demo owner is the Super Workspace; an earlier flow may have turned on their MFA.
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const users = mongo.db().collection('users');
  const ownerBefore = await users.findOne({ email: 'owner@demo.crew.local' });
  await users.updateOne({ _id: ownerBefore._id }, { $set: { mfa_enabled: false, mfa_secret_enc: null } });
  let current;
  try {
    // 1. The Super Workspace creates a leave type and types a quantity; nothing is allocated or calculated.
    const sw = current = await signIn(b, 'owner@demo.crew.local');
    await sw.goto(BASE + '/leave/manage?tab=types');
    await sw.getByTestId('leave-type-CL').waitFor();
    await sw.getByTestId('new-leave-type').click();
    let d = dialogOf(sw);
    await d.getByTestId('leave-type-name').fill('Compensatory Off');
    await d.getByLabel(/Leave code/).fill('CO');
    await d.getByTestId('leave-type-visibility').selectOption('both');
    await d.getByTestId('save-leave-type').click();
    await sw.getByText('Compensatory Off created and visible to Both Workspaces').waitFor();
    await sw.getByTestId('leave-type-CO').getByTestId('leave-type-created-by').filter({ hasText: 'Aarav Mehta' }).waitFor();
    ok('the Super Workspace created Compensatory Off for both workspaces; it shows who created it');

    await sw.goto(BASE + '/leave/manage?tab=quantities&q=Neha');
    const qRow = sw.getByTestId('quantity-row').filter({ hasText: 'Neha Deshmukh' });
    await qRow.getByLabel('Compensatory Off days for Neha Deshmukh').waitFor();
    if (await qRow.getByLabel('Compensatory Off days for Neha Deshmukh').inputValue()) throw new Error('comp-off must start Not Assigned');
    const plBox = qRow.getByLabel('Permanent Leave days for Neha Deshmukh');
    await plBox.fill('20');
    await plBox.press('Enter');
    await sw.getByText(/Neha Deshmukh: 20 days of Permanent Leave/).waitFor();
    ok('the Super Workspace typed 20 days of Permanent Leave for the operator; comp-off stays Not Assigned');

    const hr = current = await signIn(b, 'hr.admin@demo.crew.local');
    await hr.goto(BASE + '/leave/manage?tab=types');
    await hr.getByTestId('leave-type-CL').waitFor();
    if (await hr.getByTestId('new-leave-type').count()) throw new Error('the HR Workspace must not create leave types until the Super Workspace allows it');
    current = sw;
    const togglePerm = async (want) => {
      await sw.goto(BASE + '/settings/workspace-permissions?level=hr&groupId=central');
      const cat = sw.getByTestId('perm-category-leave_management');
      if (!(await cat.getByTestId('perm-switch-leave.create_types').count())) await cat.getByRole('button', { name: /Leave/ }).first().click();
      const sw1 = cat.getByTestId('perm-switch-leave.create_types');
      if ((await sw1.getAttribute('aria-checked')) !== String(want)) await sw1.click();
      await sw.getByTestId('perm-save').click();
      await sw.getByText('Permissions saved').waitFor();
    };
    await togglePerm(true);
    current = hr;
    await hr.goto(BASE + '/leave/manage?tab=types');
    await hr.getByTestId('new-leave-type').waitFor();
    current = sw;
    await togglePerm(false);
    current = hr;
    await hr.goto(BASE + '/leave/manage?tab=types');
    await hr.getByTestId('leave-type-CL').waitFor();
    if (await hr.getByTestId('new-leave-type').count()) throw new Error('switching Create leave types off must hide the button again');
    ok('HR gets Create New Leave Type only while Workspace Permissions allow it');

    // 2. The operator sees their types, then applies and changes the request while it waits.
    const day = leaveDay();
    const neha = current = await signIn(b, 'operator2@demo.crew.local');
    await neha.goto(BASE + `/leave?month=${day.slice(0, 7)}`);
    const myTypes = neha.getByTestId('my-leave-types');
    await myTypes.getByRole('region', { name: 'Compensatory Off' }).getByTestId('my-quantity').filter({ hasText: 'Not Assigned' }).waitFor();
    await myTypes.getByRole('region', { name: 'Permanent Leave' }).getByTestId('my-quantity').filter({ hasText: '20.00 days' }).waitFor();
    await myTypes.getByRole('region', { name: 'Casual Leave' }).getByText(/Applications go to: HR Workspace/).waitFor();
    await neha.getByTestId('leave-calendar').locator(`button[data-date="${day}"]`).click();
    d = dialogOf(neha);
    const optionOf = (name) => d.locator('select[name=leaveTypeId]').evaluate((el, n) => [...el.options].find((o) => o.text.startsWith(n))?.value, name);
    await d.locator('select[name=leaveTypeId]').selectOption(await optionOf('Sick Leave'));
    await d.getByTestId('leave-route-choice').getByRole('radio', { name: 'Super Workspace' }).waitFor();
    await d.locator('select[name=leaveTypeId]').selectOption(await optionOf('Casual Leave'));
    await d.getByText(/1(\.00)? working day/).waitFor();
    await d.getByTestId('leave-reviewers').getByText(/after your reporting manager/).waitFor();
    await d.getByTestId('leave-route-choice').waitFor({ state: 'detached' }); // casual leave goes to HR only: no choice
    await d.getByRole('button', { name: 'Submit request' }).click();
    await neha.getByTestId('leave-sent').waitFor();
    const row = () => neha.locator('tr').filter({ hasText: 'Casual Leave' }).filter({ hasText: day });
    await row().getByRole('button', { name: 'Change' }).click();
    d = dialogOf(neha);
    await d.getByText('Changing a request that is waiting sends it back for approval').waitFor();
    await d.locator('input[name=endDate]').fill(plus(day, 1));
    await d.getByText(/2(\.00)? working days/).waitFor();
    await d.getByRole('button', { name: 'Send change' }).click();
    await neha.getByTestId('leave-sent').waitFor();
    await row().getByText('Changed 1×').waitFor();
    ok(`operator saw the route choice for sick leave, applied for ${day} and changed it to two days while it waited`);

    // 3. The supervisor approves, then HR approves on Leave management.
    const sup = current = await signIn(b, 'supervisor@demo.crew.local');
    await approve(sup, 'Neha Deshmukh changed a request');
    ok('supervisor approved the changed request');
    current = hr;
    await hrApprove(hr, day);
    ok('HR approved it on the Approvals tab of Leave management');
    current = neha;
    await neha.goto(BASE + `/leave?month=${day.slice(0, 7)}`);
    await row().getByText('Approved').first().waitFor();
    await row().getByRole('link').first().click();
    await neha.waitForURL(/\/leave\/requests\//);
    const trail = neha.getByRole('table', { name: 'Approval trail' });
    await trail.locator('tr').filter({ hasText: 'Sunita Patil' }).getByText(/approved/i).waitFor();
    await trail.locator('tr').filter({ hasText: 'Priya Nair' }).getByText(/approved/i).waitFor();
    ok('the application page shows the manager and HR decisions');

    // 4. The operator changes the approved leave.
    await neha.goto(BASE + `/leave?month=${day.slice(0, 7)}`);
    await row().getByRole('button', { name: 'Change' }).click();
    d = dialogOf(neha);
    await d.getByText('This leave is approved').waitFor();
    const moved = plus(day, 2);
    await d.locator('input[name=startDate]').fill(moved);
    await d.locator('input[name=endDate]').fill(moved);
    await d.getByText(/1(\.00)? working day/).waitFor();
    await d.getByRole('button', { name: 'Send change' }).click();
    await neha.getByTestId('leave-sent').waitFor();
    await neha.getByTestId('leave-change-note').filter({ hasText: `Casual Leave ${day}` }).waitFor();
    await row().getByText('Change waiting for approval').waitFor();
    ok('operator asked to move the approved leave; it stays approved until the change is decided');

    // 5. The supervisor credits comp-off and approves the change; HR approves it too.
    current = sup;
    await sup.goto(BASE + '/leave/balances');
    const balRow = sup.getByTestId('balance-row').filter({ hasText: 'Neha Deshmukh' });
    await balRow.waitFor();
    await balRow.getByRole('button', { name: 'Adjust' }).click();
    d = dialogOf(sup);
    await d.getByLabel('Leave type').selectOption({ label: 'Compensatory Off' });
    await d.getByLabel('Days').fill('1');
    const remark = `Worked the Sunday stock count (${Date.now() % 100000})`;
    await d.getByLabel(/Remark/).fill(remark);
    await d.getByRole('button', { name: 'Save adjustment' }).click();
    await balRow.locator('[data-type="CO"]').getByText('1.00').waitFor();
    await sup.getByRole('link', { name: 'Adjustment history' }).click();
    await sup.getByTestId('adjustment-row').filter({ hasText: remark }).filter({ hasText: 'Neha Deshmukh' }).waitFor();
    ok('supervisor credited a comp-off day with a remark and found it in the history');
    await approve(sup, 'Neha Deshmukh wants to change approved leave');
    current = hr;
    await hrApprove(hr, moved);
    ok('supervisor and HR approved the change');

    // 6. The operator sees the result.
    current = neha;
    await neha.goto(BASE + `/leave?month=${day.slice(0, 7)}`);
    await row().getByText('Replaced by an approved change').waitFor();
    await neha.locator('tr').filter({ hasText: moved }).getByText('Approved').first().waitFor();
    await neha.getByText('Compensatory Off').first().waitFor();
    await neha.getByTestId('leave-year-link').click();
    await neha.waitForURL(/view=year/);
    await neha.getByTestId('leave-year').locator(`[data-date="${moved}"][data-leave="CL"]`).waitFor();
    if (await neha.getByTestId('leave-year').locator(`[data-date="${day}"][data-leave]`).count()) throw new Error('the replaced day still shows as leave on the year view');
    ok('operator sees the original replaced, the comp-off credit and the moved day on the year view');

    // 7. History lists who created what.
    current = sw;
    await sw.goto(BASE + '/leave/manage?tab=history');
    const hist = sw.getByRole('table', { name: 'Leave history' });
    await hist.locator('tr').filter({ hasText: 'Leave type created' }).filter({ hasText: 'Compensatory Off' }).filter({ hasText: 'Aarav Mehta' }).first().waitFor();
    ok('History shows the type created, with who did it');
  } catch (e) {
    if (current) await current.screenshot({ path: '/tmp/leave-flow-failure.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await users.updateOne({ _id: ownerBefore._id }, { $set: { mfa_enabled: ownerBefore.mfa_enabled ?? false, mfa_secret_enc: ownerBefore.mfa_secret_enc ?? null } });
    await mongo.close();
    await b.close();
  }
  if (errs.length) throw new Error('browser errors:\n' + errs.join('\n'));
  console.log('leave flow: all checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
