/**
 * AI copilots, Automation Studio and insights end-to-end flow in the Web Portal, against the demo workspace and the
 * local AI TEST STUB (e2e/ai-stub.cjs). No real AI model is called: the stub returns fixed answers. This proves
 * CREW's side of every AI feature (settings, redaction, grounding, logging, review before use) works end to end.
 *
 *   pnpm db:reset                          # fresh demo workspace (owner and hr.ops must not have MFA yet)
 *   node e2e/ai-stub.cjs &                 # test stub on 4010
 *   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=test-key-not-real ANTHROPIC_BASE_URL=http://localhost:4010 node apps/api/dist/main.js &
 *   pnpm --filter @crew/web start &
 *   node e2e/ai-flow.cjs
 *
 * 1. The owner opens AI settings, switches the HR assistant off (an operator no longer sees it) and on again.
 * 2. An operator asks the assistant a question that includes their email address: the answer cites the payslip
 *    article, the email never reaches the AI (checked at the stub), and they mark it helpful. A question no
 *    article covers gets "no answer found" without calling the AI.
 * 3. HR asks for a reply draft on a helpdesk case, edits it and sends it; the message is marked "Drafted with AI".
 * 4. HR drafts a workflow with AI, saves it, tests it with sample values and activates it. The operator applies
 *    for two days' leave; the live run asks the supervisor, who approves in Approvals; the run finishes and the
 *    operator is notified. HR reads the run's trace.
 * 5. HR opens attrition risk, recalculates, opens a person and records a review. A manager is refused.
 * 6. The auditor opens the AI activity log and sees the redacted question that was sent.
 * Fails on any browser error.
 */
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const API = (process.env.CREW_API_URL ?? 'http://localhost:4000') + '/api/v1';
const STUB = process.env.AI_STUB_URL ?? 'http://localhost:4010';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(`${who} ${m.text()}`));
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

async function enrolMfa(p) {
  await p.goto(BASE + '/settings/security');
  await p.click('text=Set up two-step verification');
  const secret = (await p.locator('code').first().textContent()).trim();
  await p.fill('input[name=code]', authenticator.generate(secret));
  await p.click('text=Turn on');
  await p.waitForSelector('text=/two-step verification is on/i', { timeout: 8000 });
}

async function api(token, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}
async function apiLogin(email) {
  const r = await api(null, 'POST', '/auth/login', { email, password: PASSWORD });
  if (r.body?.status !== 'ok') throw new Error(`${email} needs ${r.body?.status ?? r.status} to sign in through the API; run on a fresh database (pnpm db:reset)`);
  return r.body.accessToken;
}

/** Two consecutive weekdays (Monday and Tuesday) at least two weeks ahead (clear of the demo's pending request), in this year. */
function leaveDays() {
  const d = new Date();
  // Three weeks out: the demo seeds a pending leave for Arjun 8 to 14 days ahead.
  d.setUTCDate(d.getUTCDate() + 21);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  const from = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 1);
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) throw new Error('Run this test before late December (leave must fall in the current year)');
  return [from, d.toISOString().slice(0, 10)];
}

const until = async (what, fn, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};

(async () => {
  const health = await fetch(STUB + '/__requests').catch(() => null);
  if (!health?.ok) throw new Error(`The AI test stub is not running at ${STUB} (node e2e/ai-stub.cjs)`);
  const b = await chromium.launch();
  let current;
  const stamp = Date.now();
  try {
    // API sessions for the parts done behind the scenes (before anyone enrols MFA).
    const arjunTok = await apiLogin('operator1@demo.crew.local');
    const supTok = await apiLogin('supervisor@demo.crew.local');
    const hrTok = await apiLogin('hr.ops@demo.crew.local');
    const holidayCase = (await api(hrTok, 'GET', '/helpdesk/cases?view=queue&assigned=all&q=Holiday')).body.find((c) => /Holiday list/.test(c.subject));
    if (!holidayCase) throw new Error('demo case "Holiday list for next year" not found');

    // 1. The owner switches the assistant off and on again.
    const owner = current = await signIn(b, 'owner@demo.crew.local');
    await enrolMfa(owner);
    await owner.goto(BASE + '/settings/ai');
    await owner.getByText(/AI provider: Anthropic Claude API/).waitFor();
    const assistantBox = owner.getByRole('checkbox', { name: /^HR assistant/ });
    if (!(await assistantBox.isChecked())) throw new Error('demo workspace should start with the assistant on');
    await assistantBox.uncheck();
    await owner.click('text=Save AI settings');
    await owner.getByText('AI settings saved.').waitFor();
    const arjun = current = await signIn(b, 'operator1@demo.crew.local');
    await arjun.goto(BASE + '/helpdesk');
    await arjun.getByRole('heading', { name: /Ask HR/ }).first().waitFor();
    if (await arjun.getByText('Ask the HR assistant').count()) throw new Error('assistant still shown after it was switched off');
    current = owner;
    await assistantBox.check();
    await owner.click('text=Save AI settings');
    await owner.getByText('AI settings saved.').waitFor();
    ok('owner switched the HR assistant off (operator no longer sees it) and on again');

    // 2. The operator asks the assistant.
    current = arjun;
    await arjun.reload();
    await arjun.getByText('Ask the HR assistant').waitFor();
    await arjun.getByLabel('Question for the assistant', { exact: true }).fill('How do I read my payslip? You can reply to arjun.k@example.com');
    await arjun.click('text=Ask the assistant');
    const answer = arjun.getByTestId('assistant-answer');
    await answer.getByText('AI answer').waitFor({ timeout: 20000 });
    await answer.getByText(/Net pay is earnings minus deductions/).waitFor();
    await answer.getByRole('button', { name: 'How to read your payslip' }).waitFor();
    const sent = await (await fetch(STUB + '/__requests')).json();
    const last = JSON.stringify(sent.at(-1).body);
    if (last.includes('arjun.k@example.com')) throw new Error('the email address reached the AI provider');
    if (!last.includes('[email]')) throw new Error('expected the email to be replaced by [email] in what was sent');
    await answer.getByRole('button', { name: 'Yes' }).click();
    await answer.getByText('Thanks for the feedback.').waitFor();
    const before = sent.length;
    await arjun.getByLabel('Question for the assistant', { exact: true }).fill('When does the canteen serve dinner on Sundays?');
    await arjun.click('text=Ask the assistant');
    await answer.getByText('No answer found').waitFor({ timeout: 15000 });
    if ((await (await fetch(STUB + '/__requests')).json()).length !== before) throw new Error('the AI was called although no article matched');
    ok('assistant answered from the payslip article with a citation, the email was removed before sending, and an unmatched question did not call the AI');

    // 3. HR drafts, edits and sends a reply.
    const hr = current = await signIn(b, 'hr.ops@demo.crew.local');
    await enrolMfa(hr);
    await hr.goto(`${BASE}/helpdesk/${holidayCase.id}`);
    await hr.click('text=Draft a reply with AI');
    await hr.getByText('AI draft: check and edit it before sending').waitFor({ timeout: 20000 });
    const box = hr.locator('textarea[name=body]');
    const draft = await box.inputValue();
    if (!/holiday calendar/i.test(draft)) throw new Error(`unexpected draft: ${draft}`);
    const edited = `${draft.replace(/\s*\[[^\]]*\]/g, '')} We expect it in the first week of December. (${stamp})`;
    await box.fill(edited);
    await hr.click('button:has-text("Send reply")');
    await hr.getByText(`(${stamp})`).waitFor();
    await hr.getByText('Drafted with AI').first().waitFor();
    ok('HR drafted a reply with AI, edited it and sent it; it is marked as drafted with AI');

    // 4. Automation Studio: draft with AI, save, test, activate, live run with approval.
    await hr.goto(BASE + '/automation/new');
    await hr.getByPlaceholder(/When someone in Assembly Line/).fill('When someone applies for two or more days of leave, ask their manager to take a look, then tell the employee.');
    await hr.click('text=Draft steps');
    await hr.getByText(/AI draft loaded/).waitFor({ timeout: 20000 });
    await hr.getByRole('textbox', { name: /^Name/ }).fill(`Extra check for longer leave ${stamp}`);
    await hr.click('text=Save workflow');
    await hr.waitForURL(/\/automation\/[0-9a-f-]{36}$/, { timeout: 15000 });
    await hr.getByText('Not tested').first().waitFor();
    await hr.getByLabel('Days requested').fill('3');
    await hr.getByLabel('Leave type').fill('Casual leave');
    await hr.click('text=Run test');
    await hr.getByText('Test passed').waitFor({ timeout: 15000 });
    await hr.getByText(/Would ask for approval/).first().waitFor();
    await hr.click('text=Activate version 1');
    await hr.getByText(/Workflow active/).waitFor();
    const workflowUrl = hr.url();
    ok('HR drafted a workflow with AI, saved it, test-ran it and activated it');

    const types = (await api(arjunTok, 'GET', '/leave/types')).body;
    const cl = (Array.isArray(types) ? types : types.items).find((t) => /^Casual/.test(t.name));
    const [from, to] = leaveDays();
    const req = await api(arjunTok, 'POST', '/leave/requests', { leaveTypeId: cl.id, startDate: from, endDate: to, reason: `AI flow ${stamp}` });
    if (req.status >= 300) throw new Error(`leave request failed: ${JSON.stringify(req.body)}`);
    await until('the workflow approval to reach the supervisor', async () => (await api(supTok, 'GET', '/approvals/inbox')).body.find((r) => r.resourceType === 'workflow_run'));
    const sup = current = await signIn(b, 'supervisor@demo.crew.local');
    await sup.goto(BASE + '/approvals');
    const card = sup.locator('div', { hasText: 'Extra check: Arjun Kulkarni asked for 2 days of Casual leave' }).last();
    await card.locator('button', { hasText: 'Approve' }).click();
    await sup.locator('text=Extra check: Arjun Kulkarni asked for 2 days').waitFor({ state: 'detached', timeout: 10000 });
    await until('the operator to be notified', async () => {
      const n = (await api(arjunTok, 'GET', '/notifications')).body;
      return (Array.isArray(n) ? n : n.items).some((x) => x.title === 'Your leave plan was reviewed');
    });
    current = hr;
    await hr.goto(workflowUrl);
    await hr.click('text=All runs');
    const runLink = hr.locator('tr', { hasText: 'Arjun Kulkarni' }).first();
    await runLink.getByText('Finished').waitFor({ timeout: 10000 });
    await runLink.locator('a').first().click();
    await hr.getByText(/Ask the employee's manager to approve/).first().waitFor();
    if ((await hr.getByText('Done', { exact: true }).count()) < 3) throw new Error('expected three completed steps in the trace');
    ok('the operator\'s leave started a live run; the supervisor approved in Approvals; the run finished, notified the operator and its trace shows each step');

    // 5. Attrition risk.
    await hr.goto(BASE + '/insights/attrition');
    await hr.getByText('How scores work').waitFor();
    await hr.click('button:has-text("Recalculate")');
    await hr.getByText(/Scores recalculated/).waitFor();
    await hr.locator('tbody tr a').first().click();
    await hr.getByText('Why this score').waitFor();
    await hr.getByLabel('Outcome').selectOption('no_action');
    await hr.getByLabel('Note').fill(`Checked in, nothing needed (${stamp})`);
    await hr.click('text=Record review');
    await hr.getByText(`Checked in, nothing needed (${stamp})`).waitFor();
    const refused = await api(supTok, 'GET', '/insights/attrition');
    if (refused.status !== 403) throw new Error(`a manager should be refused attrition scores, got ${refused.status}`);
    ok('HR recalculated attrition risk, read why a score was given and recorded a review; a manager is refused');

    // 6. The auditor reads the AI activity log.
    const auditor = current = await signIn(b, 'auditor@demo.crew.local');
    await auditor.goto(BASE + '/settings/ai/activity?feature=assistant');
    const answered = auditor.locator('tr', { hasText: 'Answered' }).first();
    await answered.locator('a').first().click();
    await auditor.getByText('Question or request sent').waitFor();
    await auditor.getByText(/reply to \[email\]/).waitFor();
    if (await auditor.getByText('arjun.k@example.com').count()) throw new Error('the log shows the email address');
    await auditor.goto(BASE + '/settings/ai/activity');
    for (const f of ['HR assistant', 'Reply drafts', 'Workflow drafts']) await auditor.locator('td', { hasText: f }).first().waitFor();
    ok('auditor sees every AI call, and the logged question has the email removed');

    if (errs.length) throw new Error('browser errors:\n' + errs.join('\n'));
    ok('no browser errors');
    await b.close();
  } catch (e) {
    await current?.screenshot({ path: process.env.SHOT ?? '/tmp/ai-fail.png', fullPage: true }).catch(() => {});
    await b.close();
    console.error(e);
    process.exit(1);
  }
})();
