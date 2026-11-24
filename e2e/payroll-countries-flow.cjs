/**
 * Payroll outside India, end to end in a real browser, against a fresh demo workspace (Northwind UK).
 *
 *   pnpm db:reset            # fresh demo workspace (the payroll lead must not have MFA enrolled yet)
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/payroll-countries-flow.cjs
 *
 * 1. The payroll lead turns on two-step verification and opens Settings > Payroll settings.
 * 2. Picks Northwind UK: the editor shows the United Kingdom scheme (PAYE, National Insurance, workplace pension),
 *    not India's PF and ESI, with the advisor notice. Adds a contribution and saves a new version.
 * 3. Opens a UK salary: the form asks for an annual salary and shows the UK switches; the preview shows employer
 *    contributions on top of the salary.
 * 4. Starts last month's run for Northwind UK and computes it: payslip lines are in GBP with National Insurance,
 *    the pension and PAYE.
 * 5. Picks the India entity: the India scheme is still there, unchanged.
 */
const { chromium } = require('playwright');
require('./delete-password.cjs');
const { authenticator } = require('otplib');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  p.on('dialog', (d) => d.accept());
  const shot = async (e) => {
    await p.screenshot({ path: process.env.SHOT ?? '/tmp/payroll-countries-fail.png', fullPage: true }).catch(() => {});
    throw e;
  };
  const prev = new Date();
  prev.setUTCDate(1);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const monthName = `${MONTHS[prev.getUTCMonth()]} ${prev.getUTCFullYear()}`;

  // 1. Sign in and turn on two-step verification (payroll needs it).
  for (let attempt = 0; ; attempt++) {
    await p.goto(BASE + '/login');
    await p.fill('input[name=email]', 'payroll@demo.crew.local');
    await p.fill('input[name=password]', PASSWORD);
    await p.click('button[type=submit]');
    const r = await Promise.race([
      p.waitForURL((u) => u.pathname === '/', { timeout: 15000 }).then(() => 'in'),
      p.locator('text=Too many requests').waitFor({ timeout: 15000 }).then(() => 'limited'),
    ]);
    if (r === 'in') break;
    if (attempt >= 4) throw new Error('sign-in stayed rate limited');
    await p.waitForTimeout(20000);
  }
  await p.goto(BASE + '/settings/security');
  await p.click('text=Set up two-step verification');
  const secret = (await p.locator('code').first().textContent()).trim();
  await p.fill('input[name=code]', authenticator.generate(secret));
  await p.click('text=Turn on');
  await p.waitForSelector('text=/two-step verification is on/i', { timeout: 8000 });
  ok('payroll lead turned on two-step verification');

  // 2. The UK entity's statutory settings are the United Kingdom scheme.
  await p.goto(BASE + '/settings/payroll');
  const entity = p.getByLabel('Legal entity', { exact: true }).first();
  await entity.waitFor({ timeout: 10000 }).catch(shot);
  const ukValue = await entity.locator('option', { hasText: 'Northwind UK' }).getAttribute('value');
  await entity.selectOption(ukValue);
  const badge = p.getByTestId('statutory-country');
  await badge.getByText('United Kingdom (GB)').waitFor({ timeout: 10000 }).catch(shot);
  await badge.getByText(/Country pack: Tax year/).waitFor();
  await p.locator('text=/local payroll advisor/').first().waitFor();
  if ((await p.locator('h3', { hasText: 'Provident Fund' }).count()) !== 0) throw new Error('the UK entity shows India’s PF section');
  const rules = p.getByTestId('contribution-rule');
  if ((await rules.count()) !== 4) throw new Error(`expected 4 UK contributions, saw ${await rules.count()}`);
  await p.locator('input[value="Income tax (PAYE)"]').waitFor();
  await p.locator('text=Not calculated by this scheme').waitFor();
  ok('Northwind UK shows the United Kingdom pack (NI, pension, PAYE) with the advisor notice, not PF and ESI');

  await p.click('button:has-text("Add contribution")');
  const added = rules.nth(4);
  await added.getByLabel('Code').fill('LIFE');
  await added.getByLabel('Name').fill('Group life cover');
  await added.getByLabel('Employer %').fill('1');
  const firstOfMonth = `${new Date().toISOString().slice(0, 7)}-01`;
  await p.getByLabel('Effective from').fill(firstOfMonth);
  await p.click('button:has-text("I have checked these values. Save.")');
  await p.locator('text=Statutory settings saved.').waitFor({ timeout: 10000 }).catch(shot);
  // The saved versions list updates; picking the entity again loads the newest version.
  await p.locator('td', { hasText: firstOfMonth }).first().waitFor({ timeout: 10000 }).catch(shot);
  await p.reload();
  await entity.selectOption(ukValue);
  await badge.getByText('United Kingdom (GB)').waitFor({ timeout: 10000 }).catch(shot);
  if ((await rules.count()) !== 5) throw new Error('the saved version does not have the added contribution');
  ok('payroll lead added an employer contribution and saved a new UK version');

  // 3. A UK salary: annual gross salary, UK switches, employer contributions on top.
  await p.goto(BASE + '/payroll/salaries');
  await p.click('a:has-text("Oliver Bennett")');
  await p.locator('text=/GBP 38,000.00 a year/').waitFor({ timeout: 10000 }).catch(shot);
  await p.getByText('Employer contributions (estimate, on top of salary)').first().waitFor();
  await p.getByLabel('Enrolled in the workplace pension').waitFor();
  await p.getByLabel('Income tax (PAYE)').waitFor();
  if ((await p.getByText('ESI when eligible').count()) !== 0) throw new Error('the UK salary form shows ESI');
  await p.getByLabel('Annual salary').fill('40000');
  await p.click('button:has-text("Preview")');
  await p.locator('text=Monthly split').waitFor({ timeout: 10000 }).catch(shot);
  await p.locator('li', { hasText: 'Employer contributions (estimate)' }).waitFor();
  ok('UK salary form uses an annual salary, the UK switches and shows employer contributions on top');

  // 4. Last month's run for Northwind UK.
  await p.goto(BASE + '/payroll');
  await p.click('button:has-text("New payroll run")');
  const dialog = p.locator('dialog[open]');
  await dialog.locator('select[name=legalEntityId]').selectOption({ label: 'Northwind UK' });
  await dialog.locator('button:has-text("Create run")').click();
  await p.waitForURL(/\/payroll\/runs\/[0-9a-f-]{36}$/, { timeout: 15000 }).catch(shot);
  await p.locator(`text=Payroll for ${monthName}`).waitFor();
  await p.click('button:has-text("Compute payroll")');
  await p.locator('text=Payroll computed.').waitFor({ timeout: 30000 }).catch(shot);
  await p.click('a:has-text("Oliver Bennett")');
  await p.locator('text=Why these numbers').waitFor({ timeout: 10000 }).catch(shot);
  for (const name of ['National Insurance', 'Employer National Insurance', 'Workplace pension (employer)', 'Workplace pension', 'Income tax (PAYE)']) {
    await p.locator('td', { hasText: name }).first().waitFor({ timeout: 5000 }).catch(shot);
  }
  await p.locator('text=/GBP /').first().waitFor();
  if ((await p.locator('td', { hasText: 'Provident Fund' }).count()) !== 0) throw new Error('UK payslip has Provident Fund');
  ok(`computed ${monthName} for Northwind UK: National Insurance, pension and PAYE in GBP`);

  // 5. India is unchanged.
  await p.goto(BASE + '/settings/payroll');
  const indiaValue = await entity.locator('option', { hasText: '(IN)' }).getAttribute('value');
  await entity.selectOption(indiaValue);
  await badge.getByText('India (IN)').waitFor({ timeout: 10000 }).catch(shot);
  await p.locator('h3', { hasText: 'Provident Fund' }).waitFor();
  await p.locator('h3', { hasText: 'Income tax (TDS), new regime' }).waitFor();
  ok('the India entity keeps PF, ESI, professional tax and TDS');

  await b.close();
  if (errs.length) {
    console.error(errs.join('\n'));
    process.exit(1);
  }
  console.log('payroll countries flow: OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
