/**
 * Employee workspace end-to-end flow in the Web Portal, on the demo workspace (pnpm db:reset first; API on 4000,
 * web on 3000):
 *
 * 1. Home shows Neha her day: the clock card, leave, this month, attendance rewards from HR's rules, her calendar and
 *    her recent notifications, with no interview items (she does not recruit).
 * 2. HR gives her a document task. She uploads a PDF with a note; HR verifies it in the portal and the task is done.
 * 3. She sends new bank details. Until HR approves, nothing changes; HR approves from Profile updates and her
 *    profile shows the account number masked, never in full.
 * 4. She opens Appraisal and sees the self-appraisal HR launched for her.
 * 5. HR sees last month's attendance reward winners, downloads them to Excel and moves between months.
 * 6. HR makes "Always on time" pay a bonus, grants it to last month's winners (each is told; payroll pays it with
 *    the next run), and takes one grant back with a reason.
 * Fails on any browser error.
 */
const { chromium } = require('playwright');
require('./delete-password.cjs');

const BASE = process.env.CREW_WEB_URL ?? 'http://localhost:3000';
const API = (process.env.CREW_API_URL ?? 'http://localhost:4000') + '/api/v1';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const assert = (c, m) => {
  if (!c) throw new Error(`assertion failed: ${m}`);
};

async function api(token, method, p, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }
}
async function apiLogin(email) {
  const r = await api(null, 'POST', '/auth/login', { email, password: PASSWORD });
  if (r.status !== 'ok') throw new Error(`${email} needs ${r.status}; run on a fresh database (pnpm db:reset)`);
  return r.accessToken;
}

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${email} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(`${email} ${m.text()}`));
  p.on('dialog', (d) => d.accept());
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
const soon = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

(async () => {
  const b = await chromium.launch();
  let current;
  try {
    const hrT = await apiLogin('hr.admin@demo.crew.local');
    await api(hrT, 'POST', '/workspace/reward-rules/defaults');
    const run = Date.now().toString(36);
    const neha = (await api(hrT, 'GET', '/tasks/assignable')).hr.find((x) => x.name.startsWith('Neha'));
    const [task] = await api(hrT, 'POST', '/tasks', { category: 'hr', kind: 'document', title: `Upload your degree certificate ${run}`, priority: 'normal', dueOn: soon(4), employeeIds: [neha.id], document: { formats: ['pdf'], maxMb: 5 } });
    const form = await api(hrT, 'POST', '/appraisals/forms/from-template', { key: 'frequent_research' });
    const flat = (l) => l.flatMap((d) => [d, ...flat(d.children ?? [])]);
    const dept = flat(await api(hrT, 'GET', '/org/departments')).find((d) => d.name.toLowerCase().includes('assembly'));
    const cycle = await api(hrT, 'POST', '/appraisals/cycles', { name: `Web appraisal ${run}`, formId: form.id, periodStart: '2026-01-01', periodEnd: '2026-12-31', selfDue: soon(10), managerDue: soon(20), hrDue: soon(30), departmentIds: [dept.id] });
    await api(hrT, 'POST', `/appraisals/cycles/${cycle.id}/launch`);

    // 1. Home.
    const e = (current = await signIn(b, 'operator2@demo.crew.local'));
    await e.getByTestId('attendance-hero').getByRole('button', { name: /^(Check in|Check out|Start break|End break|Check in again)$/ }).first().waitFor();
    for (const t of ['This month', 'Attendance rewards', 'Attendance calendar']) await e.getByText(t, { exact: true }).first().waitFor();
    await e.getByText('Perfect attendance').first().waitFor();
    // Recent notifications, live: HR's new task for Neha is among them.
    await e.getByTestId('recent-notifications').getByText(`Upload your degree certificate ${run}`).first().waitFor();
    assert((await e.getByText('Interviews this week').count()) === 0, 'no interview highlight for a non-recruiter');
    ok('Home shows the clock, this month, rewards and the calendar, and no interviews');

    // 2. Document task.
    await e.goto(`${BASE}/tasks/${task.id}`);
    await e.getByTestId('task-file').setInputFiles({ name: 'degree.pdf', mimeType: 'application/pdf', buffer: PDF });
    await e.getByLabel('Note for HR (optional)').fill('Final year certificate');
    await e.getByRole('button', { name: 'Upload for verification' }).click();
    await e.getByText('Pending review').first().waitFor();
    const hr = (current = await signIn(b, 'hr.admin@demo.crew.local'));
    await hr.goto(`${BASE}/tasks/${task.id}`);
    await hr.getByRole('button', { name: 'Verify document' }).click();
    await hr.getByText('Completed').first().waitFor();
    current = e;
    ok('uploads the document; HR verifies it and the task is completed');

    // 3. Bank details through approval.
    await e.goto(`${BASE}/profile?tab=bank`);
    await e.getByRole('button', { name: 'Update' }).click();
    await e.getByLabel('Account holder name').fill('Neha Sharma');
    await e.getByLabel('Bank name').fill('State Bank of India');
    const account = `1234${String(Date.now()).slice(-8)}`;
    await e.getByLabel(/^Account number(?! again)/).fill(account);
    await e.getByLabel('Account number again').fill(account);
    await e.getByLabel('IFSC').fill('SBIN0001234');
    await e.getByRole('button', { name: 'Send to HR for approval' }).click();
    await e.getByText('Waiting for HR approval').first().waitFor();
    assert((await e.getByText(account).count()) === 0, 'the full account number is never shown');
    current = hr;
    await hr.goto(`${BASE}/profile/updates`);
    await hr.getByRole('link', { name: /Neha/ }).first().click();
    await hr.getByRole('button', { name: 'Approve' }).click();
    await hr.getByText('Approved').first().waitFor();
    current = e;
    await e.goto(`${BASE}/profile?tab=bank`);
    await e.getByText(new RegExp(`${account.slice(-4)}$`)).first().waitFor();
    assert((await e.content()).indexOf(account) === -1, 'the account number stays masked after approval');
    ok('sends bank details; HR approves; the number shows masked');

    // 4. Appraisal.
    await e.goto(`${BASE}/appraisal`);
    await e.getByText(`Web appraisal ${run}`).first().waitFor();
    ok('the self-appraisal HR launched is listed');

    // 5. HR sees last month's reward winners and downloads them.
    await hr.goto(`${BASE}/settings/attendance`);
    current = hr;
    await hr.getByRole('heading', { name: 'Reward winners' }).waitFor();
    await hr.getByTestId('reward-winners').waitFor();
    const winners = await api(hrT, 'GET', '/workspace/reward-winners');
    assert(winners.rules.length >= 2, 'the winners list covers the active rules');
    for (const r of winners.rules) await hr.getByRole('region', { name: `${r.name} winners` }).getByText(`${r.winners.length} earned`).waitFor();
    if (winners.rules.some((r) => r.winners.length)) {
      const [dl] = await Promise.all([hr.waitForEvent('download'), hr.getByRole('link', { name: 'Excel' }).click()]);
      assert(dl.suggestedFilename() === `attendance-rewards-${winners.month}.xlsx`, `downloads ${dl.suggestedFilename()}`);
    }
    await hr.getByRole('link', { name: 'Earlier month' }).click();
    await hr.waitForURL(/winners=\d{4}-\d{2}/);
    await hr.getByTestId('winners-month').waitFor();
    ok(`HR sees last month's reward winners (${winners.rules.map((r) => `${r.name}: ${r.winners.length}`).join(', ')}) and moves between months`);

    // 6. A reward that pays: a bonus for "Always on time", granted to last month's winners.
    await hr.goto(`${BASE}/settings/attendance`);
    const onTime = hr.locator('li', { hasText: 'Always on time' }).first();
    await onTime.getByRole('button', { name: 'Edit' }).click();
    const dialog = hr.locator('dialog[open]', { hasText: 'Edit reward' });
    await dialog.getByLabel('Payout').selectOption('bonus');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.getByText('Enter the bonus amount').waitFor();
    await dialog.getByLabel(/Bonus amount/).fill('500');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await onTime.getByText(/Bonus INR 500 in payroll/).waitFor();
    const before = (await api(hrT, 'GET', '/workspace/reward-winners')).rules.find((r) => r.name === 'Always on time');
    assert(before.payout?.type === 'bonus' && before.toGrant === before.winners.length, 'the rule pays a bonus and nobody has it yet');
    const section = hr.getByRole('region', { name: 'Always on time winners' });
    await section.getByText('Pays a bonus of INR 500.00').waitFor();
    if (before.winners.length) {
      await section.getByRole('button', { name: `Grant to ${before.winners.length}` }).click();
      const confirm = hr.locator('dialog[open]', { hasText: 'Grant Always on time' });
      await confirm.getByText(/a bonus of INR 500\.00/).waitFor();
      await confirm.getByRole('button', { name: 'Grant' }).click();
      await section.getByText(`Granted to ${before.winners.length} ${before.winners.length === 1 ? 'winner' : 'winners'}`).waitFor();
      await section.getByText('In next payroll').first().waitFor();
      assert((await section.getByText('In next payroll').count()) === before.winners.length, 'every winner is marked as in the next payroll');
      // Take one back, with a reason.
      const first = before.winners[0];
      await section.getByRole('row', { name: new RegExp(first.name) }).getByRole('button', { name: 'Take back' }).click();
      const back = hr.locator('dialog[open]', { hasText: `Take back ${first.name}'s reward` });
      await back.getByLabel('Reason').fill('Punched in by a colleague on one day');
      await back.getByRole('button', { name: 'Take back' }).click();
      await section.getByRole('row', { name: new RegExp(first.name) }).getByText('Taken back').waitFor();
      const after = (await api(hrT, 'GET', '/workspace/reward-winners')).rules.find((r) => r.name === 'Always on time');
      const st = after.winners.map((w) => w.grant?.status);
      assert(st.filter((x) => x === 'revoked').length === 1 && st.filter((x) => x === 'granted').length === before.winners.length - 1, `grants recorded: ${st.join(',')}`);
    }
    ok(`HR sets a INR 500 bonus on "Always on time", grants it to ${before.winners.length} winners and takes one back with a reason`);

    assert(errs.length === 0, `no browser errors:\n${errs.join('\n')}`);
    ok('no browser errors');
  } catch (err) {
    await current?.screenshot({ path: process.env.SHOT ?? '/tmp/workspace-fail.png', fullPage: true }).catch(() => {});
    console.error(errs.join('\n'));
    throw err;
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
