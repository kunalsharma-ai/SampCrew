/**
 * Kunal's six mandatory scenarios for Requests, leave, approvals, My Day and the chat, end to end in the Web Portal on
 * the demo company (28 November 2026 spec).
 *
 *   pnpm build && pnpm db:reset        # demo workspace (CREW_SEED_DEMO=true)
 *   start the API and the Web Portal (:3000)
 *   node e2e/requests-flow.cjs         # E2E_SHOTS=<dir> also saves screenshots
 *
 * 1. Leave: Neha (Employee Workspace) opens Apply for leave for tomorrow. Her details are filled in; she picks the type,
 *    date and reason and submits. It gets a Leave Request ID, shows in her manager's (Sunita) and her HR's (Priya)
 *    My Approvals, both are notified; nothing is booked until both approve, then the leave is approved.
 * 2. Multiple approvers: one work from home request to two approvers and two CC participants. Each approver gets the
 *    same request once, each CC participant one notice, CC cannot decide, and there is one request only.
 * 3. Rejection: Priya cannot reject without a reason; Neha is notified, reads it, and the status is the same in My
 *    Requests and in every approver's list.
 * 4. Cross-workspace: Neha sends a request to the Super Workspace (Aarav) and an HR Workspace user (Priya); each
 *    decides on their own and sees the other's decision.
 * 5. My Day: Priya clicks My Day and sees only her own attendance, requests, leave and activity.
 * 6. Chat: Neha messages Priya from the corner chat; Priya gets a notice and opens the conversation without leaving
 *    the page she is on (online status, read ticks, minimize and maximize).
 * Plus the main menu and the Settings groups from the spec, and the forms at phone width. Fails on any browser error.
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

/** The next weekday after today (tomorrow, or Monday from a Friday), as YYYY-MM-DD. */
function nextWeekday(after = 1) {
  const d = new Date(Date.now() + after * 86_400_000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Pick a role for a person in the people picker, finding them in the directory search first if needed. */
async function role(p, name, label) {
  const btn = p.getByRole('button', { name: `${label}: ${name}`, exact: true }).first();
  if (!(await btn.isVisible().catch(() => false))) {
    await p.getByTestId('people-search').fill(name.split(' ')[0]);
    await btn.waitFor();
  }
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
}

/** A request from the Create Request form: type, dates, reason; approvers and CC as given (the defaults otherwise). */
async function raise(p, { kind, start, end, reason, primary, additional = [], cc = [], dropDefaultsExcept }) {
  await p.goto(BASE + '/requests/new');
  await p.getByTestId(`pick-${kind}`).click();
  await p.getByLabel(/^(Start date|Date)\b/).first().fill(start);
  if (end) await p.getByLabel(/^End date/).fill(end);
  await p.getByLabel(/^Reason/).fill(reason);
  await p.getByTestId('picked-approvers').waitFor();
  if (primary) await role(p, primary, 'Primary approver');
  for (const a of additional) await role(p, a, 'Additional approver');
  for (const c of cc) await role(p, c, 'CC (told, does not approve)');
  if (dropDefaultsExcept) {
    for (const n of ['Sunita Patil', 'Priya Nair']) {
      if (dropDefaultsExcept.includes(n)) continue;
      const on = p.getByRole('button', { name: `Additional approver: ${n}`, exact: true }).first();
      if ((await on.count()) && (await on.getAttribute('aria-pressed')) === 'true') await on.click();
    }
  }
  await p.getByTestId('send-request').click();
  await p.waitForURL(/\/requests\/[0-9a-f-]{36}\?sent=1/);
  return p.url().split('/requests/')[1].split('?')[0];
}

/** An approver decides from the request page: the confirmation dialog, a comment (required to reject or ask changes). */
async function decide(p, id, decision, comment) {
  await p.goto(`${BASE}/requests/${id}`);
  await p.getByTestId(`${decision === 'changes' ? 'changes' : decision}-request`).click();
  if (comment) await p.getByTestId('decision-comment').fill(comment);
  await p.getByTestId(`confirm-${decision}`).click();
  await p.getByTestId('decision-comment').waitFor({ state: 'detached' });
}

const statusOf = async (p, id) => {
  await p.goto(`${BASE}/requests/${id}`);
  return (await p.getByTestId('request-status').first().textContent()).trim();
};

(async () => {
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const db = mongo.db();
  const b = await chromium.launch();
  let current = null;
  try {
    const member = async (email) => {
      const u = await db.collection('users').findOne({ email });
      return (await db.collection('memberships').findOne({ user_id: u._id }))._id;
    };
    const ids = {
      neha: await member('operator2@demo.crew.local'), sunita: await member('supervisor@demo.crew.local'), priya: await member('hr.admin@demo.crew.local'),
      aarav: await member('owner@demo.crew.local'), farhan: await member('qa.lead@demo.crew.local'), arjun: await member('operator1@demo.crew.local'),
    };
    const notices = (who, filter = {}) => db.collection('notifications').find({ membership_id: ids[who], ...filter }).toArray();
    const row = async (id) => {
      for (let i = 0; i < 20; i++) {
        const r = await db.collection('staff_requests').findOne({ _id: id });
        if (r?.approval_request_id) return r;
        await new Promise((res) => setTimeout(res, 250));
      }
      throw new Error(`request ${id} has no approval`);
    };
    const inApprovals = async (p, id, view = 'pending') => {
      await p.goto(`${BASE}/requests/approvals?view=${view}`);
      await p.locator('[data-testid=approval-views]:visible').first().waitFor();
      return p.locator(`[data-testid=approval-row][data-request-id="${id}"]`);
    };

    // The main menu from the spec, and the Settings groups.
    const priya = current = await signIn(b, 'hr.admin@demo.crew.local');
    const nav = priya.getByRole('navigation', { name: 'Main' });
    for (const label of ['Dashboard', 'My Day', 'Attendance', 'Requests', 'Leave Management', 'My Approvals', 'My Requests', 'Employees', 'Reports', 'SampCrew Chat', 'Settings']) {
      assert((await nav.getByText(label, { exact: true }).count()) > 0, `the main menu has no ${label}`);
    }
    await shot(priya, 'menu-main');
    await priya.goto(BASE + '/settings');
    for (const k of ['organization', 'employee', 'attendance_leave', 'requests', 'access', 'communication']) await priya.getByTestId(`settings-category-${k}`).waitFor();
    await priya.getByTestId('settings-category-requests').getByText('Requests & approvals').waitFor();
    await shot(priya, 'settings-groups', true);
    ok('the main menu and the Settings groups match the spec');

    // Scenario 1: leave for tomorrow.
    const neha = current = await signIn(b, 'operator2@demo.crew.local');
    const tomorrow = nextWeekday();
    await neha.goto(BASE + '/leave/apply');
    const details = neha.getByTestId('requester-details');
    await details.waitFor();
    for (const v of ['Neha Deshmukh', 'Machine Operator', 'Sunita Patil', 'Employee Workspace']) await details.getByText(v).first().waitFor();
    assert(!(await details.locator('dd').first().textContent()).includes('—'), 'the employee code is not filled in');
    const cl = await neha.$eval('[data-testid=leave-type]', (s) => [...s.options].find((o) => o.text.startsWith('Casual Leave'))?.value ?? s.options[0].value);
    await neha.selectOption('[data-testid=leave-type]', cl);
    await neha.getByLabel(/^Start date/).fill(tomorrow);
    await neha.getByLabel(/^End date/).fill(tomorrow);
    await neha.getByLabel(/^Reason/).fill('Family function out of town');
    await neha.getByTestId('picked-approvers').getByText('Sunita Patil').waitFor();
    await neha.getByTestId('picked-approvers').getByText('Priya Nair').waitFor();
    await shot(neha, 'leave-apply', true);
    await neha.getByTestId('apply-leave').click();
    await neha.waitForURL(/\/requests\/[0-9a-f-]{36}\?sent=1/);
    const leaveId = neha.url().split('/requests/')[1].split('?')[0];
    const refs = [(await neha.getByTestId('request-ref').first().textContent()).trim()];
    assert(/^LV-/.test(refs[0]), `the leave has no Leave Request ID (${refs[0]})`);
    await shot(neha, 'leave-sent');
    const lr = await row(leaveId);
    let leave = await db.collection('leave_requests').findOne({ _id: lr.leave_request_id });
    assert(leave && leave.status === 'pending', `the leave should wait for approval, it is ${leave?.status}`);
    for (const who of ['sunita', 'priya']) {
      const n = await notices(who, { kind: 'approval.requested', link: { $regex: lr.approval_request_id } });
      assert(n.length === 1, `${who} got ${n.length} notices for the leave`);
    }
    const sunita = await signIn(b, 'supervisor@demo.crew.local');
    current = sunita;
    const sRow = await inApprovals(sunita, leaveId);
    await sRow.waitFor();
    await shot(sunita, 'my-approvals');
    current = priya;
    await (await inApprovals(priya, leaveId)).waitFor();
    current = neha;
    await neha.goto(BASE + '/requests/mine');
    await neha.getByTestId('my-requests').getByText('Pending').first().waitFor();
    // The manager approves from the row (confirmation, optional comment); still waiting for HR, nothing booked.
    current = sunita;
    await sRow.getByTestId('row-approve').click();
    await sunita.getByTestId('decision-comment').fill('Enjoy the function.');
    await sunita.getByTestId('confirm-approve').click();
    await sunita.getByTestId('decision-comment').waitFor({ state: 'detached' });
    leave = await db.collection('leave_requests').findOne({ _id: lr.leave_request_id });
    assert(leave.status === 'pending', 'the leave was booked after one of two approvals');
    current = priya;
    await decide(priya, leaveId, 'approve');
    current = neha;
    assert((await statusOf(neha, leaveId)) === 'Approved', 'the leave is not approved after both approvals');
    await neha.getByTestId('approver-comment').getByText('Enjoy the function.').first().waitFor();
    await shot(neha, 'leave-approved', true);
    leave = await db.collection('leave_requests').findOne({ _id: lr.leave_request_id });
    assert(leave.status === 'approved', `the leave is ${leave.status} after both approvals`);
    const done = await notices('neha', { kind: 'request.approved', link: `/requests/${leaveId}` });
    assert(done.length === 1 && /balance and attendance/.test(done[0].body ?? ''), 'Neha was not told the leave was approved and booked');
    ok(`scenario 1: leave for ${tomorrow} reached Sunita and Priya, was booked only after both approved`);

    // Scenario 2: two approvers, two CC participants, one request.
    current = neha;
    const wfhStart = nextWeekday(20);
    const wfhEnd = nextWeekday(22);
    const wfhId = await raise(neha, { kind: 'wfh', start: wfhStart, end: wfhEnd, reason: 'Internet engineer visiting home to install the new line', cc: ['Farhan Qureshi', 'Arjun Kulkarni'] });
    await neha.getByTestId('request-cc').getByText('Farhan Qureshi').waitFor();
    refs.push((await neha.getByTestId('request-ref').first().textContent()).trim());
    await shot(neha, 'request-sent', true);
    const wr = await row(wfhId);
    assert((await db.collection('staff_requests').countDocuments({ requester_membership_id: ids.neha, kind: 'wfh', start_date: wfhStart })) === 1, 'the request was duplicated');
    for (const who of ['sunita', 'priya']) assert((await notices(who, { kind: 'approval.requested', link: { $regex: wr.approval_request_id } })).length === 1, `${who} did not get the request once`);
    for (const who of ['farhan', 'arjun']) {
      const n = await notices(who, { link: `/requests/${wfhId}` });
      assert(n.length === 1 && /CC/.test(n[0].title), `${who} (CC) got ${n.length} notices`);
    }
    const farhan = current = await signIn(b, 'qa.lead@demo.crew.local');
    await farhan.goto(`${BASE}/requests/${wfhId}`);
    await farhan.getByTestId('request-ref').first().waitFor();
    assert((await farhan.getByTestId('approve-request').count()) === 0, 'a CC participant can decide');
    ok('scenario 2: one request reached both approvers once and both CC participants once; CC cannot decide');

    // Scenario 3: rejection needs a reason.
    current = priya;
    await priya.goto(`${BASE}/requests/${wfhId}`);
    await priya.getByTestId('reject-request').click();
    assert(await priya.getByTestId('confirm-reject').isDisabled(), 'reject is possible without a reason');
    await priya.getByTestId('decision-comment').fill('Month-end audit that week, please pick other days.');
    await shot(priya, 'reject-dialog');
    await priya.getByTestId('confirm-reject').click();
    await priya.getByTestId('decision-comment').waitFor({ state: 'detached' });
    current = neha;
    assert((await statusOf(neha, wfhId)) === 'Rejected', 'the request is not rejected');
    await neha.getByTestId('approver-comment').getByText(/Month-end audit/).first().waitFor();
    const rej = await notices('neha', { kind: 'request.rejected', link: `/requests/${wfhId}` });
    assert(rej.length === 1 && /Month-end audit/.test(rej[0].body ?? ''), 'Neha was not told the reason');
    await neha.goto(BASE + '/requests/mine?status=rejected');
    await neha.getByTestId('my-requests').getByText('Rejected').first().waitFor();
    current = sunita;
    await (await inApprovals(sunita, wfhId, 'rejected')).waitFor();
    assert((await (await inApprovals(sunita, wfhId, 'pending')).count()) === 0, 'the rejected request still waits for Sunita');
    ok('scenario 3: the reason was required, Neha was notified and read it, and the status is Rejected everywhere');

    // Scenario 4: an Employee Workspace member to the Super Workspace and an HR Workspace user.
    current = neha;
    const crossId = await raise(neha, { kind: 'wfh', start: nextWeekday(30), reason: 'Waiting at home for the gas connection', primary: 'Aarav Mehta', additional: ['Priya Nair'], dropDefaultsExcept: ['Priya Nair'] });
    refs.push((await neha.getByTestId('request-ref').first().textContent()).trim());
    const cr = await row(crossId);
    assert(cr.approver_membership_ids.includes(ids.aarav) && cr.approver_membership_ids.includes(ids.priya) && !cr.approver_membership_ids.includes(ids.sunita), 'the approvers are not Aarav and Priya');
    const aarav = current = await signIn(b, 'owner@demo.crew.local');
    await (await inApprovals(aarav, crossId)).waitFor();
    await decide(aarav, crossId, 'approve', 'Fine by me.');
    current = priya;
    await priya.goto(`${BASE}/requests/${crossId}`);
    await priya.getByTestId('request-approvers').getByText(/Approved/).first().waitFor();
    await priya.getByTestId('approver-comment').getByText('Fine by me.').first().waitFor();
    await decide(priya, crossId, 'approve');
    current = aarav;
    assert((await statusOf(aarav, crossId)) === 'Approved', 'the Super Workspace does not see the request approved');
    current = neha;
    assert((await statusOf(neha, crossId)) === 'Approved', 'Neha does not see the request approved');
    ok('scenario 4: the Super Workspace and an HR Workspace user each decided, and both see the same status');

    // Scenario 5: My Day for an HR user.
    current = priya;
    await priya.goto(BASE + '/');
    await nav.getByRole('link', { name: 'My Day', exact: true }).click();
    await priya.waitForURL(/\/my-day$/);
    const myDay = priya.getByTestId('my-day-page');
    await myDay.waitFor();
    assert((await myDay.getAttribute('data-level')) === 'employee', 'My Day does not look like the personal view');
    const own = await priya.getByTestId('my-day-requests').textContent();
    for (const ref of refs) assert(!own.includes(ref), `My Day lists someone else's request ${ref}`);
    for (const t of ['attendance-dashboard', 'overview-attendance', 'approvals-table']) assert((await priya.getByTestId(t).count()) === 0, `My Day shows ${t}`);
    await shot(priya, 'my-day', true);
    ok('scenario 5: My Day showed only Priya\'s own attendance, requests, leave and activity');

    // Scenario 6: the corner chat.
    current = neha;
    await neha.goto(BASE + '/requests/mine');
    await neha.getByTestId('chat-launcher').click();
    await neha.getByTestId('chat-panel').waitFor();
    await neha.getByTestId('chat-new').click();
    await neha.getByLabel('Find a person').fill('HR');
    await neha.getByTestId('chat-people').getByText('Priya Nair').first().waitFor();
    // Priya has SampCrew open, so she shows online.
    await neha.getByTestId('chat-person').filter({ hasText: 'Priya Nair' }).first().getByTestId('presence-online').waitFor({ timeout: 30000 });
    await neha.getByTestId('chat-person').filter({ hasText: 'Priya Nair' }).first().click();
    await neha.getByLabel('Write a message').fill('Hi Priya, thank you for approving my leave!');
    await neha.getByTestId('chat-send').click();
    await neha.getByTestId('chat-messages').getByText('thank you for approving my leave').waitFor();
    await neha.getByTestId('chat-messages').getByTestId('delivery-sent').or(neha.getByTestId('chat-messages').getByTestId('delivery-delivered')).first().waitFor();
    await shot(neha, 'chat-widget');
    current = priya;
    await priya.goto(BASE + '/leave');
    const before = priya.url();
    await Promise.race([priya.getByTestId('chat-unread').waitFor({ timeout: 20000 }), priya.getByTestId('chat-toast').waitFor({ timeout: 20000 })]);
    assert((await db.collection('notifications').countDocuments({ membership_id: ids.priya, kind: { $regex: '^chat\\.' } })) >= 1, 'Priya got no chat notification');
    await priya.getByTestId('chat-launcher').click();
    await priya.getByTestId('chat-filter-unread').click();
    await priya.getByTestId('chat-conversations').getByText('Neha Deshmukh').first().click();
    await priya.getByTestId('chat-messages').getByText('thank you for approving my leave').waitFor();
    assert(priya.url() === before, 'opening the conversation left the page');
    await priya.getByTestId('chat-maximize').click();
    assert((await priya.getByTestId('chat-panel').getAttribute('data-size')) === 'max', 'the chat did not maximize');
    await shot(priya, 'chat-maximized');
    await priya.getByLabel('Write a message').fill('You are welcome, Neha.');
    await priya.getByTestId('chat-send').click();
    await priya.getByTestId('chat-minimize').click();
    await priya.getByTestId('chat-restore').waitFor();
    await shot(priya, 'chat-minimized');
    current = neha;
    await neha.getByTestId('chat-messages').getByText('You are welcome, Neha.').waitFor({ timeout: 20000 });
    await neha.getByTestId('chat-messages').getByTestId('delivery-read').first().waitFor({ timeout: 20000 });
    await neha.goto(BASE + '/communication/chat');
    assert((await neha.getByTestId('chat-launcher').count()) === 0, 'the chat button sits on the chat page');
    ok('scenario 6: Neha messaged Priya; Priya was notified and replied from the corner without leaving the page; read ticks, online, minimize and maximize work');

    // Phone width: the forms and the chat stay on screen.
    const phone = current = await signIn(b, 'operator2@demo.crew.local', { width: 390, height: 844 });
    for (const path of ['/requests/new', '/leave/apply', '/requests/mine']) {
      await phone.goto(BASE + path);
      await phone.waitForLoadState('networkidle');
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `${path} scrolls sideways on a phone (${overflow}px)`);
    }
    await shot(phone, 'leave-apply-phone', true);
    ok('the request and leave forms fit a phone');

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
