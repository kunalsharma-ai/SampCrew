/**
 * Late coming and attendance penalties end to end in a real browser, against the demo workspace.
 *
 *   pnpm db:reset            # fresh demo workspace (includes a week of demo punches with some late arrivals)
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/late-flow.cjs
 *
 * 1. HR switches on late-coming reminders with a deduction tier, and a manual same-day leave penalty.
 * 2. The Assembly supervisor finds Neha's late arrivals and sends her a reminder by hand.
 * 3. Neha sees the reminder in her notifications and on her attendance page.
 * 4. Neha applies leave on the day it starts; the supervisor sees it is same-day leave in Approvals, applies a
 *    penalty of 2 days of pay and approves; the penalty shows on Late coming & penalties.
 * Fails on any browser error. SHOTS=<dir> saves a screenshot of each screen.
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
const SHOTS = process.env.SHOTS;
const save = async (p, name) => {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' });
};
const fail = async (p, e) => {
  await p.screenshot({ path: process.env.SHOT ?? '/tmp/late-fail.png', fullPage: true }).catch(() => {});
  throw e;
};

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
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

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const plus = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekend = (d) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
/** Today, or the Friday before at a weekend (leave on a weekly off has no working days). Backdated leave counts as same-day. */
const leaveDay = () => {
  let d = istToday();
  while (weekend(d)) d = plus(d, -1);
  return d;
};

(async () => {
  const b = await chromium.launch();

  // 1. HR sets the rules.
  const hr = await signIn(b, 'hr.admin@demo.crew.local');
  await hr.goto(BASE + '/settings/attendance');
  const on = hr.getByTestId('late-enabled');
  if ((await on.getAttribute('aria-checked')) !== 'true') await on.click();
  await hr.getByLabel('Count arrivals late by at least (minutes)').fill('15');
  while (await hr.getByTestId('late-tier').count()) await hr.getByTestId('late-tier').first().getByRole('button', { name: /^Remove the tier/ }).click();
  await hr.getByRole('button', { name: 'Add a tier' }).click();
  const tier = hr.getByTestId('late-tier').first();
  await tier.getByLabel('After reminders').fill('3');
  await tier.getByLabel('Percent').fill('5');
  await hr.getByRole('button', { name: 'Save rules' }).click();
  await hr.locator('text=Late-coming rules saved.').waitFor({ timeout: 10000 }).catch((e) => fail(hr, e));
  await save(hr, 'late-1-attendance-settings');
  ok('HR switched on late-coming reminders: 3 reminders deduct 5% of gross pay');

  await hr.goto(BASE + '/settings/leave');
  const sd = hr.getByTestId('same-day-enabled');
  if ((await sd.getAttribute('aria-checked')) !== 'true') await sd.click();
  await hr.getByLabel('How the penalty is applied').selectOption('manual');
  await hr.getByLabel('Penalty (days of pay)').fill('2');
  await hr.getByRole('button', { name: 'Save rule' }).click();
  await hr.locator('text=Same-day leave rule saved.').waitFor({ timeout: 10000 }).catch((e) => fail(hr, e));
  await save(hr, 'late-2-leave-settings');
  ok('HR set a same-day leave penalty of 2 days, applied by the manager');

  // 2. The supervisor reminds Neha about a late arrival.
  const sup = await signIn(b, 'supervisor@demo.crew.local');
  await sup.goto(BASE + '/attendance/late');
  const remindButton = () => sup.locator('tr', { hasText: 'Neha' }).locator('button', { hasText: 'Send reminder' }).first();
  // Early in a month the demo week's late days fall in the previous month.
  if (!(await remindButton().count())) await sup.getByRole('link', { name: 'Previous month' }).click();
  await remindButton().waitFor({ timeout: 10000 }).catch((e) => fail(sup, e));
  await remindButton().click();
  await sup.locator('dialog').getByLabel('Note to the employee').fill('Please be on time for the 09:00 shift.');
  await sup.locator('dialog').getByRole('button', { name: 'Send reminder' }).click();
  await sup.locator('text=Reminder sent.').waitFor({ timeout: 10000 }).catch((e) => fail(sup, e));
  await sup.locator('text=Reminder 1 · by hand').first().waitFor({ timeout: 10000 });
  await save(sup, 'late-3-supervisor-month');
  ok('supervisor sent Neha a late reminder by hand from Late coming & penalties');
  const month = new URL(sup.url()).searchParams.get('month');

  // 3. Neha sees it.
  const neha = await signIn(b, 'operator2@demo.crew.local');
  await neha.goto(BASE + `/attendance${month ? `?month=${month}` : ''}`);
  await neha.getByRole('heading', { name: 'Late reminders and penalties' }).waitFor({ timeout: 10000 }).catch((e) => fail(neha, e));
  await neha.getByText(/^\d+ late reminders?$/).first().waitFor({ timeout: 5000 });
  await neha.locator('text=Please be on time for the 09:00 shift.').first().waitFor({ timeout: 5000 });
  await save(neha, 'late-4-employee-attendance');
  ok('Neha sees the reminder and how many more lead to a deduction on her attendance page');

  // 4. Same-day leave, penalised by the supervisor while approving.
  await neha.goto(BASE + '/leave');
  await neha.getByRole('button', { name: 'Apply for leave' }).click();
  const day = leaveDay();
  const form = neha.locator('#leave-form');
  await form.locator('input[name=startDate]').fill(day);
  await form.locator('input[name=endDate]').fill(day);
  await neha.locator('dialog').getByRole('button', { name: 'Submit request' }).click();
  await neha.locator('text=Same-day leave').first().waitFor({ timeout: 10000 }).catch((e) => fail(neha, e));
  ok(`Neha applied leave for ${day}; it is marked as same-day leave`);

  await sup.goto(BASE + '/approvals');
  const card = sup.getByTestId('same-day-leave').first();
  await card.waitFor({ timeout: 10000 }).catch((e) => fail(sup, e));
  await card.getByLabel('Penalty in days of pay').fill('2');
  await card.getByRole('button', { name: 'Apply penalty' }).click();
  await sup.locator("text=Penalty set to 2 days' pay.").waitFor({ timeout: 10000 }).catch((e) => fail(sup, e));
  await save(sup, 'late-5-approvals-same-day');
  const item = sup.locator('div.p-4', { has: sup.getByTestId('same-day-leave') }).first();
  await item.getByRole('button', { name: 'Approve' }).click();
  await sup.locator('text=Approved').first().waitFor({ timeout: 10000 });
  ok('supervisor applied a 2-day penalty to the same-day leave and approved it');

  await sup.goto(BASE + `/attendance/late?month=${day.slice(0, 7)}`);
  await sup.locator('tr', { hasText: "2 days' pay" }).first().waitFor({ timeout: 10000 }).catch((e) => fail(sup, e));
  await save(sup, 'late-6-penalties');
  ok('the penalty is listed for payroll on Late coming & penalties');

  await b.close();
  if (errs.length) {
    console.error(errs.join('\n'));
    process.exit(1);
  }
  console.log('late-coming flow passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
