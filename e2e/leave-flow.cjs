/**
 * Leave upgrade end-to-end flow in the Web Portal, against the demo workspace.
 *
 *   pnpm db:reset            # fresh demo workspace (HR admin must not have MFA enrolled yet)
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/leave-flow.cjs
 *
 * 1. HR adds maternity leave, compensatory off and work from home from the standard catalogue on Leave settings, and
 *    gives the Assembly Line department its own casual leave policy.
 * 2. An operator applies for a day of casual leave, then changes the request to two days while it waits. The row says
 *    it was changed.
 * 3. The supervisor approves the changed request.
 * 4. The operator changes the approved leave to another day. The original stays approved, marked "Change waiting".
 * 5. The supervisor opens Leave balances, sees the operator's balances, credits a day of comp-off with a remark (which
 *    shows in the adjustment history), and approves the change.
 * 6. The operator sees the original replaced, the comp-off day in their balances, and the new day on the year view.
 * Fails on any browser error.
 */
const { chromium } = require('playwright');
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

(async () => {
  const b = await chromium.launch();
  let current;
  try {
    // 1. HR adds standard types and a department policy.
    const hr = current = await signIn(b, 'hr.admin@demo.crew.local');
    await hr.goto(BASE + '/settings/leave');
    await hr.getByRole('button', { name: 'Add standard types' }).click();
    let d = dialogOf(hr);
    for (const name of ['Maternity leave (ML)', 'Compensatory off (CO)', 'Work from home (WFH)']) await d.getByLabel(name).check();
    await d.getByRole('button', { name: 'Add 3 types' }).click();
    await hr.getByText('Added 3 leave type(s) with starting policies.').waitFor();
    for (const name of ['Maternity leave', 'Compensatory off', 'Work from home']) await hr.getByTestId('leave-type-row').filter({ hasText: name }).first().waitFor();
    await hr.getByTestId('leave-type-row').filter({ hasText: 'Work from home' }).getByText('counts as present').waitFor();
    await hr.getByRole('button', { name: 'Add policy' }).click();
    d = dialogOf(hr);
    await d.locator('select[name=leaveTypeId]').selectOption({ label: 'Casual leave' });
    await d.locator('select[name=departmentId]').selectOption({ label: 'Assembly Line' });
    await d.locator('select[name=accrualMethod]').selectOption('annual_upfront');
    await d.locator('input[name=annualEntitlement]').fill('10');
    await d.getByRole('button', { name: 'Save policy' }).click();
    await hr.getByTestId('policy-scope').filter({ hasText: 'Assembly Line' }).waitFor();
    ok('HR added maternity, comp-off and work from home from the catalogue and a casual leave policy for Assembly Line');

    // 2. The operator applies, then changes the request while it waits.
    const day = leaveDay();
    const neha = current = await signIn(b, 'operator2@demo.crew.local');
    await neha.goto(BASE + `/leave?month=${day.slice(0, 7)}`);
    await neha.getByTestId('leave-calendar').locator(`button[data-date="${day}"]`).click();
    d = dialogOf(neha);
    const cl = await d.locator('select[name=leaveTypeId]').evaluate((el) => [...el.options].find((o) => o.text.startsWith('Casual leave'))?.value);
    await d.locator('select[name=leaveTypeId]').selectOption(cl);
    await d.getByText(/1(\.00)? working day/).waitFor();
    await d.getByRole('button', { name: 'Submit request' }).click();
    await neha.getByTestId('leave-sent').waitFor();
    const row = () => neha.locator('tr').filter({ hasText: 'Casual leave' }).filter({ hasText: day });
    await row().getByRole('button', { name: 'Change' }).click();
    d = dialogOf(neha);
    await d.getByText('Changing a request that is waiting sends it back for approval').waitFor();
    await d.locator('input[name=endDate]').fill(plus(day, 1));
    await d.getByText(/2(\.00)? working days/).waitFor();
    await d.getByRole('button', { name: 'Send change' }).click();
    await neha.getByTestId('leave-sent').waitFor();
    await row().getByText('Changed 1×').waitFor();
    ok(`operator applied for ${day} and changed it to two days while it waited`);

    // 3. The supervisor approves the changed request.
    const sup = current = await signIn(b, 'supervisor@demo.crew.local');
    await approve(sup, 'Neha Deshmukh changed a request');
    ok('supervisor approved the changed request');

    // 4. The operator changes the approved leave.
    current = neha;
    await neha.goto(BASE + `/leave?month=${day.slice(0, 7)}`);
    await row().getByText('Approved').waitFor();
    await row().getByRole('button', { name: 'Change' }).click();
    d = dialogOf(neha);
    await d.getByText('This leave is approved').waitFor();
    const moved = plus(day, 2);
    await d.locator('input[name=startDate]').fill(moved);
    await d.locator('input[name=endDate]').fill(moved);
    await d.getByText(/1(\.00)? working day/).waitFor();
    await d.getByRole('button', { name: 'Send change' }).click();
    await neha.getByTestId('leave-sent').waitFor();
    await neha.getByTestId('leave-change-note').filter({ hasText: `Casual leave ${day}` }).waitFor();
    await row().getByText('Change waiting for approval').waitFor();
    ok('operator asked to move the approved leave; it stays approved until the change is decided');

    // 5. The supervisor reviews balances, credits comp-off and approves the change.
    current = sup;
    await sup.goto(BASE + '/leave/balances');
    const balRow = sup.getByTestId('balance-row').filter({ hasText: 'Neha Deshmukh' });
    await balRow.waitFor();
    await balRow.getByRole('button', { name: 'Adjust' }).click();
    d = dialogOf(sup);
    await d.getByLabel('Leave type').selectOption({ label: 'Compensatory off' });
    await d.getByLabel('Days').fill('1');
    const remark = `Worked the Sunday stock count (${Date.now() % 100000})`;
    await d.getByLabel(/Remark/).fill(remark);
    await d.getByRole('button', { name: 'Save adjustment' }).click();
    await balRow.locator('[data-type="CO"]').getByText('1.00').waitFor();
    await sup.getByRole('link', { name: 'Adjustment history' }).click();
    await sup.getByTestId('adjustment-row').filter({ hasText: remark }).filter({ hasText: 'Neha Deshmukh' }).waitFor();
    ok('supervisor saw team balances, credited a comp-off day with a remark and found it in the history');
    await approve(sup, 'Neha Deshmukh wants to change approved leave');
    ok('supervisor approved the change');

    // 6. The operator sees the result.
    current = neha;
    await neha.goto(BASE + `/leave?month=${day.slice(0, 7)}`);
    await row().getByText('Replaced by an approved change').waitFor();
    await neha.locator('tr').filter({ hasText: moved }).getByText('Approved').waitFor();
    await neha.getByText('Compensatory off').first().waitFor();
    await neha.getByTestId('leave-year-link').click();
    await neha.waitForURL(/view=year/);
    await neha.getByTestId('leave-year').locator(`[data-date="${moved}"][data-leave="CL"]`).waitFor();
    if (await neha.getByTestId('leave-year').locator(`[data-date="${day}"][data-leave]`).count()) throw new Error('the replaced day still shows as leave on the year view');
    ok('operator sees the original replaced, the comp-off credit and the moved day on the year view');
  } catch (e) {
    if (current) await current.screenshot({ path: '/tmp/leave-flow-failure.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await b.close();
  }
  if (errs.length) throw new Error('browser errors:\n' + errs.join('\n'));
  console.log('leave flow: all checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
