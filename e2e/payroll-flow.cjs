/**
 * Payroll and expenses end-to-end flow in a real browser, against the demo workspace.
 *
 *   pnpm db:reset            # fresh demo workspace (payroll and finance must not have MFA enrolled yet)
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/payroll-flow.cjs
 *
 * 1. The payroll lead turns on two-step verification (payroll needs it) and reviews settings and salaries.
 * 2. An operator submits an expense claim with a receipt; their supervisor approves the pending demo claim.
 * 3. The payroll lead starts last month's run, computes it, opens one payslip calculation, adds an adjustment
 *    and sends the run for approval. The stepper above the run follows: Inputs and Compute, then Review, then
 *    Approval, then every step done.
 * 4. The finance manager turns on two-step verification and approves; the run is finalised.
 * 5. The payroll lead downloads the register. The operator opens their payslip, with the reimbursed expense.
 * Also opens every payroll screen and fails on any browser error.
 */
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(`${who} ${m.text()}`));
  p.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Demo e2e reason') : d.accept()));
};

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const p = await ctx.newPage();
  watch(p, email);
  // Sign-in is rate limited per address (10 a minute). After the other flows in CI, wait for the window instead of failing.
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

async function enrolMfa(p) {
  await p.goto(BASE + '/settings/security');
  await p.click('text=Set up two-step verification');
  const secret = (await p.locator('code').first().textContent()).trim();
  await p.fill('input[name=code]', authenticator.generate(secret));
  await p.click('text=Turn on');
  await p.waitForSelector('text=/two-step verification is on/i', { timeout: 8000 });
}

const shot = async (p, e) => {
  await p.screenshot({ path: process.env.SHOT ?? '/tmp/payroll-fail.png', fullPage: true }).catch(() => {});
  throw e;
};
const dialogOf = (p) => p.locator('dialog[open]');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

(async () => {
  const b = await chromium.launch();
  const prev = new Date();
  prev.setUTCDate(1);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const monthName = `${MONTHS[prev.getUTCMonth()]} ${prev.getUTCFullYear()}`;

  // 1. The payroll lead enrols MFA, then reviews settings and salaries.
  const pay = await signIn(b, 'payroll@demo.crew.local');
  await pay.goto(BASE + '/payroll');
  await pay.waitForURL(/no-access/, { timeout: 10000 }).catch((e) => shot(pay, e));
  ok('payroll is closed until two-step verification is on');
  await enrolMfa(pay);
  await pay.goto(BASE + '/settings/payroll');
  await pay.locator('text=Statutory settings').first().waitFor();
  await pay.locator('text=Attendance and unpaid leave').first().waitFor();
  await pay.locator('text=Standard').first().waitFor();
  await pay.goto(BASE + '/payroll/salaries');
  await pay.click('a:has-text("Ganesh Pawar")');
  await pay.locator('text=/INR 2,16,000.00 a year/').waitFor({ timeout: 10000 }).catch((e) => shot(pay, e));
  await pay.fill('input[inputmode=decimal]', '228000');
  await pay.click('button:has-text("Preview")');
  await pay.locator('text=Monthly split').waitFor({ timeout: 10000 }).catch((e) => shot(pay, e));
  ok('payroll lead reviewed statutory settings and previewed a salary revision');

  // 2. Expenses: an operator claims with a receipt; the supervisor approves the pending demo claim.
  const arjun = await signIn(b, 'operator1@demo.crew.local');
  await arjun.goto(BASE + '/expenses');
  await arjun.selectOption('select[name=categoryId]', { label: 'Travel' });
  await arjun.fill('input[name=spentOn]', new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  await arjun.fill('input[name=amount]', '320');
  await arjun.fill('textarea[name=description]', 'Bus to the Chakan vendor site');
  await arjun.setInputFiles('input[name=receipt]', { name: 'bus-ticket.png', mimeType: 'image/png', buffer: PNG });
  await arjun.click('button:has-text("Submit claim")');
  await arjun.locator('text=Claim submitted').waitFor({ timeout: 10000 }).catch((e) => shot(arjun, e));
  await arjun.locator('text=Bus to the Chakan vendor site').waitFor();
  ok('operator submitted an expense claim with a receipt');

  const sup = await signIn(b, 'supervisor@demo.crew.local');
  await sup.goto(BASE + '/expenses?view=approvals');
  const row = sup.locator('tr', { hasText: 'Neha Deshmukh' }).first();
  await row.waitFor({ timeout: 10000 }).catch((e) => shot(sup, e));
  await row.locator('button:has-text("Approve")').click();
  await sup.locator('tr', { hasText: 'night-shift handover' }).waitFor({ state: 'detached', timeout: 10000 }).catch((e) => shot(sup, e));
  ok('supervisor approved a pending expense claim');

  // 3. The payroll lead runs last month's payroll.
  await pay.goto(BASE + '/payroll');
  await pay.click('button:has-text("New payroll run")');
  await dialogOf(pay).locator('button:has-text("Create run")').click();
  await pay.waitForURL(/\/payroll\/runs\/[0-9a-f-]{36}$/, { timeout: 15000 }).catch((e) => shot(pay, e));
  const runUrl = pay.url();
  await pay.locator(`text=Payroll for ${monthName}`).waitFor();
  const stepper = pay.getByRole('navigation', { name: 'Payroll steps' });
  const current = async () => (await stepper.locator('li[aria-current=step]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label').split(':')[0]))).join(',');
  if ((await current()) !== 'Inputs,Compute') throw new Error(`new run: current steps ${await current()}`);
  await pay.click('button:has-text("Compute payroll")');
  await pay.locator('text=Payroll computed.').waitFor({ timeout: 30000 }).catch((e) => shot(pay, e));
  await pay.locator('a:has-text("Arjun Kulkarni")').first().waitFor();
  ok(`payroll lead computed ${monthName}`);
  await stepper.getByText(/people, net /).waitFor();
  if ((await current()) !== 'Review') throw new Error(`computed run: current step ${await current()}`);
  ok('the stepper moved on to Review, with the head count and net pay under Compute');
  await pay.locator('text=Checks before approval').waitFor({ timeout: 10000 }).catch((e) => shot(pay, e));
  await pay.locator('text=/compared with each person.s last three finalised months/').waitFor();
  ok('payroll checks compare every payslip with the person\'s earlier months before approval');

  await pay.click('a:has-text("Arjun Kulkarni")');
  await pay.locator('text=Why these numbers').waitFor({ timeout: 10000 }).catch((e) => shot(pay, e));
  await pay.locator('text=Provident Fund').first().waitFor();
  await pay.locator('text=Approved expense claim, not taxable').waitFor();
  ok('payslip calculation explains every line, with the approved expense reimbursed');

  await pay.goto(runUrl);
  await pay.click('button:has-text("Add adjustment")');
  const adj = dialogOf(pay);
  const arjunOption = await adj.locator('select[name=employeeId] option', { hasText: 'Arjun Kulkarni' }).getAttribute('value');
  await adj.locator('select[name=employeeId]').selectOption(arjunOption);
  await adj.locator('input[name=label]').fill('Night shift allowance');
  await adj.locator('input[name=amount]').fill('1500');
  await adj.locator('textarea[name=reason]').fill('Covered four night shifts');
  await adj.locator('button:has-text("Add and recompute")').click();
  await pay.locator('td:has-text("Night shift allowance")').waitFor({ timeout: 15000 }).catch((e) => shot(pay, e));
  await pay.click('button:has-text("Send for approval")');
  await pay.locator('text=Waiting for approval').first().waitFor({ timeout: 15000 }).catch((e) => shot(pay, e));
  if ((await current()) !== 'Approval') throw new Error(`submitted run: current step ${await current()}`);
  await stepper.getByText('1 adjustment').waitFor();
  ok('payroll lead added an adjustment and sent the run for approval; the stepper is at Approval');

  // 4. Finance approves.
  const fin = await signIn(b, 'finance@demo.crew.local');
  await enrolMfa(fin);
  await fin.goto(BASE + '/approvals');
  const card = fin.locator('div', { hasText: new RegExp(`Payroll for .*${monthName}`) }).filter({ has: fin.locator('button:has-text("Approve")') }).last();
  await card.locator('button:has-text("Approve")').click();
  await fin.locator(`text=/Payroll for .*${monthName}/`).waitFor({ state: 'detached', timeout: 15000 }).catch((e) => shot(fin, e));
  await pay.goto(runUrl);
  await pay.locator('text=Finalised').first().waitFor({ timeout: 10000 }).catch((e) => shot(pay, e));
  if ((await stepper.locator('li[aria-label$=": done"]').count()) !== 6) throw new Error('finalised run: not every step is done');
  ok('finance manager approved; the run is finalised and every step is done');

  // 5. Exports and payslips.
  const reg = await pay.request.get(runUrl.replace('/payroll/runs/', '/payroll-files/') + '/register');
  if (reg.status() !== 200 || !(await reg.text()).startsWith('Employee code,Name,Status')) throw new Error(`register download failed: ${reg.status()}`);
  ok('payroll lead downloaded the payroll register');

  await arjun.goto(BASE + '/payslips');
  await arjun.click(`a:has-text("${monthName}")`);
  await arjun.locator(`text=Payslip for ${monthName}`).waitFor({ timeout: 10000 }).catch((e) => shot(arjun, e));
  await arjun.locator('text=Night shift allowance').waitFor();
  await arjun.locator('text=Reimbursements (not taxable)').waitFor();
  ok('operator opened their payslip with the allowance and the reimbursed expense');

  for (const path of ['/payroll', '/payroll/salaries', '/settings/payroll', '/payslips?view=all', '/expenses?view=all']) {
    await pay.goto(BASE + path);
    await pay.waitForLoadState('networkidle');
  }
  ok('every payroll screen renders');

  await b.close();
  if (errs.length) {
    console.error(errs.join('\n'));
    process.exit(1);
  }
  console.log('payroll flow: OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
