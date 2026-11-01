/**
 * HR helpdesk and announcements end-to-end flow in the Web Portal, against the demo workspace.
 *
 *   pnpm db:reset            # fresh demo workspace (HR admin must not have MFA enrolled yet)
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/helpdesk-flow.cjs
 *
 * 1. HR adds a category with a handler and response targets; a confidential category without a handler is refused.
 *    HR writes a help article.
 * 2. An operator starts a question, is shown the article as a suggestion, reads it, and raises the case anyway.
 * 3. HR finds it in the queue, adds an internal note, replies and asks for more; the operator answers (and cannot
 *    see the internal note). HR raises the priority and resolves it; the operator rates it and confirms.
 * 4. The operator raises a confidential grievance; their supervisor cannot open it.
 * 5. HR drafts an announcement for the Assembly Line, asks for acknowledgement and publishes it. The operator sees
 *    it on Home, opens it and acknowledges; HR sees the read receipt.
 * 6. The operator's Security page lists their phones (none yet).
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
  // The supervisor is sent away from a confidential case on purpose; Next logs that 404 to the console.
  p.on('console', (m) => m.type() === 'error' && !/status of 404/.test(m.text()) && errs.push(`${who} ${m.text()}`));
  p.on('dialog', (d) => d.accept());
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

const dialogOf = (p) => p.locator('dialog[open]');
const alertText = (p, re) => p.getByText(re).first().waitFor();

(async () => {
  const b = await chromium.launch();
  const stamp = Date.now();
  let hr;
  let neha;
  let current;
  const shot = async (e) => {
    await current?.screenshot({ path: process.env.SHOT ?? '/tmp/helpdesk-fail.png', fullPage: true }).catch(() => {});
    throw e;
  };
  try {
    // 1. HR configures the helpdesk.
    hr = current = await signIn(b, 'hr.admin@demo.crew.local');
    await hr.goto(BASE + '/settings/helpdesk');
    await hr.getByRole('button', { name: 'Add category' }).click();
    let d = dialogOf(hr);
    await d.getByRole('textbox', { name: /^Name/ }).fill(`Confidential test ${stamp}`);
    await d.getByRole('checkbox', { name: /^Confidential/ }).check();
    await d.getByRole('button', { name: 'Save' }).click();
    await d.getByText('A confidential category needs at least one handler').first().waitFor();
    await d.getByRole('textbox', { name: /^Name/ }).fill(`Canteen and transport ${stamp}`);
    await d.getByRole('checkbox', { name: /^Confidential/ }).uncheck();
    await d.getByLabel('First reply within (hours)').fill('4');
    await d.getByLabel('Resolve within (hours)').fill('24');
    await d.getByRole('checkbox', { name: /^Priya Nair/ }).check();
    await d.getByRole('button', { name: 'Save' }).click();
    await hr.getByRole('row').filter({ hasText: `Canteen and transport ${stamp}` }).getByText('Priya Nair').waitFor();
    ok('HR added a category with a handler and targets; a confidential category without a handler was refused');

    const articleTitle = `Payslip deductions explained ${stamp}`;
    await hr.getByRole('button', { name: 'Write article' }).click();
    d = dialogOf(hr);
    await d.getByLabel('Title').fill(articleTitle);
    await d.getByLabel('Category').selectOption({ label: 'Pay and payslips' });
    await d.getByLabel('Text').fill('Provident fund is 12% of basic pay. Professional tax depends on your state. (e2e)');
    await d.getByRole('button', { name: 'Save' }).click();
    await hr.getByRole('row').filter({ hasText: articleTitle }).getByText('Published').waitFor();
    ok('HR published a help article');

    // 2. The operator asks a question and is shown the article first.
    neha = current = await signIn(b, 'operator2@demo.crew.local');
    await neha.getByRole('link', { name: 'Ask HR' }).first().click();
    await neha.waitForURL(/\/helpdesk$/);
    await neha.getByLabel('What is it about?').selectOption({ label: 'Pay and payslips' });
    const subject = `Payslip deductions question ${stamp}`;
    await neha.getByLabel('Subject').fill(subject);
    await neha.getByRole('button', { name: articleTitle }).first().click();
    await dialogOf(neha).getByText('Provident fund is 12% of basic pay').waitFor();
    await neha.keyboard.press('Escape');
    await neha.getByLabel('Your question').fill('My professional tax went up this month. Why did that happen?');
    await neha.getByRole('button', { name: 'Send to HR' }).click();
    await neha.waitForURL(/\/helpdesk\/[0-9a-f-]{36}$/);
    const caseUrl = neha.url();
    const ref = (await neha.locator('text=/^HR-\\d{4}$/').first().textContent()).trim();
    ok(`operator saw the suggested article, then raised ${ref}`);

    // 3. HR works the case.
    current = hr;
    await hr.goto(BASE + '/helpdesk/queue');
    await hr.getByPlaceholder('HR-0042, subject or name').fill(ref);
    await hr.getByPlaceholder('HR-0042, subject or name').press('Enter');
    await hr.getByRole('link', { name: ref }).click();
    await hr.waitForURL(caseUrl);
    await hr.getByText('Priya Nair').first().waitFor(); // assigned automatically to the category handler
    await hr.getByRole('checkbox', { name: /^Internal note/ }).check();
    await hr.getByLabel(/Internal note \(HR only\)/).fill('Check the state slab change (e2e internal)');
    await hr.getByRole('button', { name: 'Add note' }).click();
    await alertText(hr, /Internal note added/);
    await hr.getByRole('checkbox', { name: /^Internal note/ }).uncheck();
    await hr.getByLabel('Reply to the employee').fill('Which state is your work location registered in?');
    await hr.getByRole('button', { name: 'Send reply' }).click();
    await alertText(hr, /Reply sent/);
    await hr.getByRole('button', { name: 'Ask the employee' }).click();
    await alertText(hr, /asked to reply/);
    ok('HR added an internal note, replied and asked the employee for more');

    current = neha;
    await neha.goto(caseUrl);
    await neha.getByText('HR is waiting for your reply.').waitFor();
    if (await neha.getByText('Check the state slab change').count()) throw new Error('internal note visible to the employee');
    await neha.getByLabel('Your reply').fill('Maharashtra, at the Pune plant.');
    await neha.getByRole('button', { name: 'Send reply' }).click();
    await alertText(neha, /Reply sent/);
    ok('operator answered; the internal note stayed hidden');

    current = hr;
    await hr.goto(caseUrl);
    await hr.getByText('Maharashtra, at the Pune plant.').waitFor();
    await hr.getByLabel('Priority').selectOption('high');
    await alertText(hr, /Priority changed/);
    await hr.getByLabel('Reply to the employee').fill('The Maharashtra slab changed this month; your deduction is correct.');
    await hr.getByRole('button', { name: 'Resolve' }).click();
    await alertText(hr, /Resolved/);
    await hr.getByText('changed the priority').first().waitFor();
    ok('HR raised the priority and resolved it with an answer');

    current = neha;
    await neha.goto(caseUrl);
    await neha.getByText('The Maharashtra slab changed this month').waitFor();
    await neha.getByRole('radio', { name: '4 out of 5' }).click();
    await neha.getByRole('button', { name: 'Send rating' }).click();
    await alertText(neha, /Thanks for the feedback/);
    await neha.getByRole('button', { name: 'Confirm it is solved' }).click();
    await alertText(neha, /case is closed/);
    await neha.getByText('Closed').first().waitFor();
    ok('operator rated the answer and closed the case');

    // 4. A confidential grievance the supervisor cannot see.
    await neha.goto(BASE + '/helpdesk');
    await neha.getByLabel('What is it about?').selectOption({ label: 'Grievance (confidential)' });
    await neha.getByLabel('Subject').fill(`Concern about shift allocation ${stamp}`);
    await neha.getByLabel('Your question').fill('I would like to raise a concern in confidence about how night shifts are allocated.');
    await neha.getByRole('button', { name: 'Send to HR' }).click();
    await neha.waitForURL(/\/helpdesk\/[0-9a-f-]{36}$/);
    const grievanceUrl = neha.url();
    await neha.getByText('Confidential: only you and the named HR handlers can see this case.').waitFor();
    const sup = current = await signIn(b, 'supervisor@demo.crew.local');
    const res = await sup.goto(grievanceUrl);
    if (res.status() !== 404 && !(await sup.getByText(/not found|no access|don't have access/i).count())) throw new Error(`supervisor could open the grievance (status ${res.status()})`);
    await sup.close();
    ok("operator raised a confidential grievance; their supervisor can't open it");

    // 5. Announcement with acknowledgement.
    current = hr;
    const title = `Canteen closed on Saturday ${stamp}`;
    await hr.goto(BASE + '/announcements/manage');
    await hr.getByRole('button', { name: 'New announcement' }).click();
    d = dialogOf(hr);
    await d.getByLabel('Title').fill(title);
    await d.getByLabel('Message').fill('The canteen is closed this Saturday for maintenance. Packed lunches will be provided. (e2e)');
    await d.getByLabel('Department').selectOption({ label: 'Assembly Line' });
    await d.getByRole('checkbox', { name: /^Ask people to acknowledge/ }).check();
    await d.getByRole('button', { name: 'Save draft' }).click();
    const row = hr.getByRole('row').filter({ hasText: title });
    await row.getByText('Draft').waitFor();
    await row.getByRole('button', { name: 'Publish' }).click();
    await alertText(hr, /Published/);
    await row.getByText('Published', { exact: true }).waitFor();
    ok('HR drafted an announcement for the Assembly Line and published it');

    current = neha;
    await neha.goto(BASE + '/');
    const item = neha.getByRole('listitem').filter({ hasText: title });
    await item.getByText('Please acknowledge').waitFor();
    await item.getByRole('link', { name: title }).click();
    await neha.getByRole('button', { name: 'I have read this' }).click();
    await neha.getByText(/You acknowledged this on/).waitFor();
    ok('operator saw it on Home and acknowledged it');

    current = hr;
    await hr.goto(BASE + '/announcements/manage');
    await hr.getByRole('row').filter({ hasText: title }).getByRole('link', { name: title }).click();
    const person = hr.getByRole('row').filter({ hasText: 'Neha Deshmukh' });
    await person.waitFor();
    if (await person.getByText('Not yet').count()) throw new Error('read receipt missing for Neha');
    ok('HR sees that the operator read and acknowledged it');

    // 6. Phones on the Security page.
    current = neha;
    await neha.goto(BASE + '/settings/security');
    await neha.getByText('Mobile app', { exact: true }).waitFor();
    await neha.getByText('No phones yet').waitFor();
    ok('Security page lists signed-in phones');

    if (errs.length) throw new Error('browser errors:\n' + errs.join('\n'));
    console.log('helpdesk flow passed');
  } catch (e) {
    await shot(e);
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
