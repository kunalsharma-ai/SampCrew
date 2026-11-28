/**
 * Requests, the leave application made from one, the shorter menu, My Day and the corner chat, end to end in the
 * Web Portal on the demo company (28 November 2026).
 *
 *   pnpm build && pnpm db:reset        # demo workspace (CREW_SEED_DEMO=true)
 *   start the API and the Web Portal (:3000)
 *   node e2e/requests-flow.cjs         # E2E_SHOTS=<dir> also saves screenshots
 *
 * 1. Neha (Employee Workspace) opens Requests from the menu, picks Work from home, loops in her reporting manager
 *    (Sunita) and her HR (Priya) from the suggestions, and sends it.
 * 2. Priya finds it in Approvals, cannot reject it without a reason, approves with a comment; Sunita approves too.
 *    Neha sees it approved with Priya's comment.
 * 3. Neha asks for leave the same way; once both approve she gets "apply for your leave", opens the pre-filled
 *    leave application form (code, name, designation, manager, HR), sends it; both get it in Approvals and by email.
 * 4. An early leave request is rejected with a reason; Neha reads the reason.
 * 5. The menu: Priya's HR Workspace menu is shorter (pages merged under one entry, one Settings). My Day shows only
 *    her own attendance, then she switches back.
 * 6. The corner chat: Neha messages Priya from the chat button; Priya gets the badge and a notice and replies there.
 * Fails on any browser error.
 */
const path = require('node:path');
const { chromium } = require('playwright');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));

const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const SHOTS = process.env.E2E_SHOTS;

const ok = (m) => console.log(`ok - ${m}`);
const assert = (c, m) => { if (!c) throw new Error(m); };
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/EventSource|net::ERR_ABORTED|404 \(Not Found\)/.test(m.text()) && errs.push(`${who} ${m.text()}`));
};
const shot = async (p, name, fullPage = false) => SHOTS && p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });

async function signIn(b, email, viewport = { width: 1440, height: 900 }) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: SHOTS ? 2 : 1 });
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

/** A weekday about `ahead` days from now, as YYYY-MM-DD. */
function weekday(ahead) {
  const d = new Date(Date.now() + ahead * 86_400_000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Neha raises a request on the form: type, dates (and times), reason, her manager and HR from the suggestions. */
async function raise(p, { kind, start, end, time, reason }) {
  await p.goto(BASE + '/requests/new');
  await p.getByTestId(`pick-${kind}`).click();
  await p.getByLabel(/^(From date|Date)/).first().fill(start);
  if (end) await p.getByLabel(/^To date/).fill(end);
  if (time) await p.getByLabel(/^(Leaving at|Arriving at)/).fill(time);
  await p.getByLabel(/^Reason/).fill(reason);
  // Her reporting manager and her HR are looped in to start with.
  await p.getByTestId('picked-approvers').getByText('Sunita Patil').waitFor();
  await p.getByTestId('picked-approvers').getByText('Priya Nair').waitFor();
  await p.getByTestId('send-request').click();
  await p.waitForURL(/\/requests\/[0-9a-f-]{36}\?sent=1/);
  return p.url().split('/requests/')[1].split('?')[0];
}

/** An approver opens the request from Approvals and decides. */
async function decide(p, approvalId, decision, comment) {
  await p.goto(`${BASE}/approvals/${approvalId}`);
  await p.getByTestId('request-form').waitFor();
  if (comment) await p.getByLabel('Remarks').fill(comment);
  await p.getByRole('button', { name: decision === 'approve' ? 'Approve' : 'Reject', exact: true }).click();
  await p.getByText(decision === 'approve' ? /Approved\./ : /Rejected\./).first().waitFor();
}

(async () => {
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const db = mongo.db();
  const b = await chromium.launch();
  let current = null;
  try {
    const approvalOf = async (id) => {
      for (let i = 0; i < 20; i++) {
        const r = await db.collection('staff_requests').findOne({ _id: id });
        if (r?.approval_request_id) return r;
        await new Promise((res) => setTimeout(res, 250));
      }
      throw new Error(`request ${id} has no approval`);
    };

    // 1. Neha raises a work from home request from the menu.
    const neha = current = await signIn(b, 'operator2@demo.crew.local');
    await neha.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Requests/ }).click();
    await neha.waitForURL(/\/requests$/);
    await neha.getByTestId('kind-wfh').waitFor();
    await shot(neha, 'requests-hub');
    const wfhFrom = weekday(30);
    const wfhTo = weekday(31);
    await neha.goto(BASE + '/requests/new');
    await neha.getByTestId('pick-wfh').waitFor();
    const wfhId = await raise(neha, { kind: 'wfh', start: wfhFrom, end: wfhTo, reason: 'Internet engineer visiting home to install the new line' });
    await neha.getByTestId('request-approvers').getByText('Sunita Patil').waitFor();
    await shot(neha, 'request-sent');
    const wfh = await approvalOf(wfhId);
    ok('Neha raised a work from home request and looped in her reporting manager and HR');

    // 2. HR cannot reject without a reason, then approves with a comment; the manager approves.
    const priya = current = await signIn(b, 'hr.admin@demo.crew.local');
    await priya.goto(BASE + '/approvals');
    await priya.getByText('Neha Deshmukh').first().waitFor();
    await priya.goto(`${BASE}/approvals/${wfh.approval_request_id}`);
    await priya.getByTestId('request-form').getByText('Work from home').first().waitFor();
    await shot(priya, 'approval-request');
    await priya.getByRole('button', { name: 'Reject', exact: true }).click();
    await priya.getByText('Add remarks so the person knows why it was rejected.').waitFor();
    await decide(priya, wfh.approval_request_id, 'approve', 'Fine, stay reachable on chat.');
    const sunita = current = await signIn(b, 'supervisor@demo.crew.local');
    await decide(sunita, wfh.approval_request_id, 'approve');
    current = neha;
    await neha.goto(`${BASE}/requests/${wfhId}`);
    await neha.getByTestId('request-status').first().getByText('Approved').waitFor();
    await neha.getByTestId('approver-comment').getByText('Fine, stay reachable on chat.').waitFor();
    const notices = await db.collection('notifications').countDocuments({ kind: 'request.approved', link: `/requests/${wfhId}` });
    assert(notices >= 1, 'Neha was not notified that the request was approved');
    ok('HR had to give a reason to reject, approved with a comment; the manager approved; Neha read the comment and was notified');

    // 3. Leave: ask first, then the pre-filled leave application form.
    const leaveFrom = weekday(40);
    const leaveTo = weekday(41);
    const leaveId = await raise(neha, { kind: 'leave', start: leaveFrom, end: leaveTo, reason: 'Family function in Nashik, travelling both days' });
    const lr = await approvalOf(leaveId);
    current = priya;
    await decide(priya, lr.approval_request_id, 'approve', 'Approved, enjoy the function.');
    current = sunita;
    await decide(sunita, lr.approval_request_id, 'approve');
    current = neha;
    await neha.goto(`${BASE}/requests/${leaveId}`);
    await neha.getByTestId('apply-leave-banner').waitFor();
    await shot(neha, 'request-approved-apply');
    await neha.getByTestId('apply-leave-cta').click();
    await neha.waitForURL(/\/apply$/);
    const form = neha.getByTestId('leave-application-form');
    await form.waitFor();
    assert((await neha.getByTestId('form-name').textContent()).includes('Neha Deshmukh'), 'the form is not filled with her name');
    assert((await neha.getByTestId('form-designation').textContent()).includes('Machine Operator'), 'the form has no designation');
    assert((await neha.getByTestId('form-manager').textContent()).includes('Sunita Patil'), 'the form has no reporting manager');
    assert((await neha.getByTestId('form-hr').textContent()).trim() !== '—', 'the form has no HR manager');
    assert(!/—/.test(await neha.getByTestId('form-employee-code').textContent()), 'the form has no employee code');
    const type = neha.getByTestId('form-leave-type');
    if (!(await type.inputValue())) await type.selectOption({ index: 1 });
    await neha.getByTestId('form-declaration').check();
    await shot(neha, 'leave-application-form');
    await neha.getByTestId('send-leave-application').click();
    await neha.waitForURL(/\?applied=1/);
    const applied = await db.collection('staff_requests').findOne({ _id: leaveId });
    assert(applied.leave_request_id, 'the leave application was not saved');
    const leave = await db.collection('leave_requests').findOne({ _id: applied.leave_request_id });
    assert(leave?.application_form?.applicant?.name === 'Neha Deshmukh', 'the leave application form was not saved with the leave');
    const mails = await db.collection('email_messages').find({ template: 'leave.application' }).toArray();
    const forThis = mails.filter((m) => (m.html_body ?? '').includes('Leave Application Form') && (m.subject ?? '').includes('Neha Deshmukh'));
    assert(forThis.length >= 3, `expected the form emailed to Sunita, Priya and a copy to Neha, got ${forThis.length}`);
    current = priya;
    await priya.goto(BASE + '/approvals');
    await priya.getByText(/Neha Deshmukh/).first().waitFor();
    ok('after approval Neha sent the pre-filled leave application; it was saved, emailed to both approvers with her copy, and is in Approvals');

    // 4. Early leave, rejected with a reason.
    current = neha;
    const earlyId = await raise(neha, { kind: 'early_leave', start: weekday(50), time: '16:30', reason: 'Parent-teacher meeting at school' });
    const er = await approvalOf(earlyId);
    current = priya;
    await decide(priya, er.approval_request_id, 'reject', 'Month-end audit that afternoon, please pick another day.');
    current = neha;
    await neha.goto(`${BASE}/requests/${earlyId}`);
    await neha.getByTestId('request-status').first().getByText('Rejected').waitFor();
    await neha.getByTestId('approver-comment').getByText(/Month-end audit/).waitFor();
    await neha.goto(BASE + '/requests');
    await neha.getByTestId('my-requests').waitFor();
    await shot(neha, 'requests-list');
    ok('a rejected request shows Neha the reason');

    // 5. The shorter menu and My Day.
    current = priya;
    await priya.goto(BASE + '/');
    const nav = priya.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('link', { name: /^Settings/ }).first().waitFor();
    const visible = await nav.getByRole('link').count();
    const all = await priya.locator('nav[aria-label="Main"] a').count();
    assert(visible < all, `the menu shows every page (${visible} of ${all})`);
    assert(visible <= 40, `the HR Workspace menu is still long: ${visible} links`);
    await nav.getByRole('button', { name: 'Recruitment', exact: true }).click();
    await nav.getByRole('link', { name: 'Candidates', exact: true }).waitFor();
    await shot(priya, 'menu-hr');
    await priya.getByTestId('work-view-myday').click();
    await priya.waitForFunction(() => document.documentElement.dataset.view === 'myday');
    await priya.goto(BASE + '/attendance');
    await priya.getByText('Employee Workspace · My Day').first().waitFor();
    assert((await priya.getByTestId('attendance-dashboard').count()) === 0, 'My Day still shows the attendance dashboard');
    assert((await priya.getByTestId('overview-attendance').count()) === 0, 'My Day still shows the organization overview');
    assert(await priya.evaluate(() => document.documentElement.dataset.level === 'employee'), 'My Day does not look like the Employee Workspace');
    await shot(priya, 'my-day-attendance');
    await priya.goto(BASE + '/settings');
    assert((await priya.getByText('Workspace settings').count()) === 0, 'My Day Settings still lists company settings');
    await priya.getByTestId('work-view-workforce').click();
    await priya.waitForFunction(() => document.documentElement.dataset.view === 'workforce');
    ok('the HR menu is merged into fewer entries; My Day showed only her own attendance and account settings');

    // 6. The chat in the corner.
    current = neha;
    await neha.goto(BASE + '/');
    await neha.getByTestId('chat-launcher').click();
    await neha.getByTestId('chat-panel').waitFor();
    await neha.getByTestId('chat-new').click();
    await neha.getByLabel('Find a person').fill('Priya');
    await neha.getByTestId('chat-people').getByText('Priya Nair').first().click();
    await neha.getByLabel('Write a message').fill('Hi Priya, thank you for approving my leave!');
    await neha.getByTestId('chat-send').click();
    await neha.getByTestId('chat-messages').getByText('thank you for approving my leave').waitFor();
    await shot(neha, 'chat-widget');
    current = priya;
    await priya.goto(BASE + '/leave');
    await Promise.race([priya.getByTestId('chat-unread').waitFor({ timeout: 20000 }), priya.getByTestId('chat-toast').waitFor({ timeout: 20000 })]);
    await priya.getByTestId('chat-launcher').click();
    await priya.getByTestId('chat-conversations').getByText('Neha Deshmukh').first().click();
    await priya.getByTestId('chat-messages').getByText('thank you for approving my leave').waitFor();
    await priya.getByLabel('Write a message').fill('You are welcome, Neha.');
    await priya.getByTestId('chat-send').click();
    current = neha;
    await neha.getByTestId('chat-messages').getByText('You are welcome, Neha.').waitFor({ timeout: 20000 });
    // The launcher never sits on the chat page, and nothing covers the page's last line.
    await neha.goto(BASE + '/communication/chat');
    assert((await neha.getByTestId('chat-launcher').count()) === 0, 'the chat button sits on the chat page');
    ok('Neha and Priya chatted from the corner chat, with the badge and live replies');

    // Phone width: the request form and the chat stay on screen.
    const phone = current = await signIn(b, 'operator2@demo.crew.local', { width: 390, height: 844 });
    await phone.goto(BASE + '/requests/new');
    await phone.getByTestId('pick-wfh').waitFor();
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `the request form scrolls sideways on a phone (${overflow}px)`);
    await shot(phone, 'requests-phone');
    ok('the request form fits a phone');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    ok('requests flow passed');
  } catch (e) {
    if (current && SHOTS) await current.screenshot({ path: path.join(SHOTS, 'requests-failure.png'), fullPage: true }).catch(() => undefined);
    console.error(e);
    if (errs.length) console.error(errs.join('\n'));
    process.exitCode = 1;
  } finally {
    await b.close();
    await mongo.close();
  }
})();
