/**
 * Employee workspace end-to-end flow in the Web Portal, on the demo workspace (pnpm db:reset first; API on 4000,
 * web on 3000):
 *
 * 1. Home shows Neha her day: the clock card, leave, this month, attendance rewards from HR's rules and her calendar,
 *    with no interview items (she does not recruit).
 * 2. HR gives her a document task. She uploads a PDF with a note; HR verifies it in the portal and the task is done.
 * 3. She sends new bank details. Until HR approves, nothing changes; HR approves from Profile updates and her
 *    profile shows the account number masked, never in full.
 * 4. She opens Appraisal and sees the self-appraisal HR launched for her.
 * Fails on any browser error.
 */
const { chromium } = require('playwright');

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
    await e.getByRole('button', { name: /Clock (in|out)/ }).first().waitFor();
    for (const t of ['This month', 'Attendance rewards', 'My calendar']) await e.getByText(t, { exact: true }).first().waitFor();
    await e.getByText('Perfect attendance').first().waitFor();
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
