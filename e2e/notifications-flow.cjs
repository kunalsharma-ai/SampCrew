/**
 * Notification Center and Approvals end-to-end flow in the Web Portal, against the demo workspace.
 *
 *   pnpm db:reset
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/notifications-flow.cjs
 *
 * 1. The operator opens notification settings: sound is off by default. They switch it on and save; reloading a page
 *    plays nothing (sound never autoplays), and the preview button plays a tone.
 * 2. The supervisor has Home open in one tab and Approvals in another. The operator applies for casual leave; without
 *    reloading, the bell count goes up, a pop-up shows on Home (not on Approvals, which updates by itself), and the
 *    Casual Leave card's pending count goes up.
 * 3. The supervisor opens the request (/approvals/[id]): request ID, type, approval authority and history show.
 *    Rejecting without remarks is refused; rejecting with remarks works and the history shows them.
 * 4. The operator gets the rejection live, sees it in the Notification Center (Approvals category, Important),
 *    and the request in "My requests" says it was rejected with the remarks.
 * 5. Mark all read empties the unread count.
 * Fails on any browser error.
 */
const { chromium } = require('playwright');
require('./delete-password.cjs');
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
  // Counts tones started, so the test can tell whether anything played.
  await ctx.addInitScript(() => {
    window.__tones = 0;
    const O = window.OscillatorNode;
    if (O) {
      const start = O.prototype.start;
      O.prototype.start = function (...a) { window.__tones++; return start.apply(this, a); };
    }
  });
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

function leaveDay() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 9);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) throw new Error('Run this test before late December (leave must fall in the current year)');
  return d.toISOString().slice(0, 10);
}

const count = async (p) => {
  const el = p.getByTestId('notification-count');
  return (await el.count()) ? Number((await el.textContent()).replace(/\D/g, '')) : 0;
};

(async () => {
  const b = await chromium.launch();
  try {
    // 1. Sound settings.
    const op = await signIn(b, 'operator2@demo.crew.local');
    await op.goto(BASE + '/settings/notifications');
    const sound = op.getByTestId('sound-enabled');
    // Issue #89: notices sound by default; each person can still switch it off.
    if ((await sound.getAttribute('aria-checked')) !== 'true') throw new Error('sound should be on by default');
    if (!(await op.getByRole('switch', { name: 'Approvals in SampCrew' }).isDisabled())) throw new Error('approval notices should not be switchable off');
    await sound.click();
    await op.click('text=Save notification settings');
    await op.getByText(/saved/i).first().waitFor();
    await op.reload();
    await op.getByTestId('sound-enabled').waitFor();
    if ((await op.getByTestId('sound-enabled').getAttribute('aria-checked')) !== 'false') throw new Error('switching sound off did not persist');
    await op.getByTestId('sound-enabled').click();
    await op.click('text=Save notification settings');
    await op.getByText(/saved/i).first().waitFor();
    await op.reload();
    await op.getByTestId('sound-enabled').waitFor();
    if ((await op.getByTestId('sound-enabled').getAttribute('aria-checked')) !== 'true') throw new Error('sound setting did not persist');
    await op.waitForTimeout(800);
    if ((await op.evaluate(() => window.__tones)) !== 0) throw new Error('a sound played on page load');
    await op.getByRole('button', { name: 'Urgent' }).click();
    await op.waitForFunction(() => window.__tones > 0);
    ok('sound is on by default, can be switched off and on, never plays on load, preview plays');

    // 2. The supervisor sees a new request arrive live.
    const sup = await signIn(b, 'supervisor@demo.crew.local');
    const board = await sup.context().newPage();
    await board.goto(BASE + '/approvals');
    const pendingOn = async () => {
      const c = board.getByTestId('approval-card-casual_leave');
      return (await c.count()) ? Number((await c.innerText()).match(/(\d+)\s*pending/)?.[1] ?? 0) : 0;
    };
    const pendingBefore = await pendingOn();
    await sup.reload();
    await sup.getByTestId('notification-bell').waitFor();
    await sup.waitForTimeout(1500); // the live stream connects

    const day = leaveDay();
    await op.goto(BASE + `/leave?month=${day.slice(0, 7)}`);
    await op.getByTestId('leave-calendar').locator(`button[data-date="${day}"]`).click();
    await op.waitForSelector('dialog[open]');
    const cl = await op.$eval('dialog select[name=leaveTypeId]', (s) => [...s.options].find((o) => o.text.startsWith('Casual Leave'))?.value);
    await op.selectOption('dialog select[name=leaveTypeId]', cl);
    await op.fill('dialog input[name=endDate]', day);
    await op.fill('dialog textarea[name=reason]', 'Notification browser test');
    await op.waitForSelector('dialog >> text=/1\\.00 working day/', { timeout: 10000 });
    const supToast = sup.getByTestId('notification-toasts').getByText(/awaiting your approval/).waitFor({ timeout: 20000 });
    await op.click('dialog >> text=Submit request');
    await op.getByTestId('leave-sent').waitFor({ timeout: 10000 });

    // The pop-up proves the notice arrived live; the bell then counts it. (The other tab on Approvals marks that
    // category read when it opens, so the count is not compared with the one taken before.)
    await supToast;
    await sup.waitForFunction(() => {
      const el = document.querySelector('[data-testid=notification-count]');
      return el && Number(el.textContent.replace(/\D/g, '')) > 0;
    }, null, { timeout: 15000 });
    await board.waitForFunction((n) => {
      const c = document.querySelector('[data-testid=approval-card-casual_leave]');
      return c && Number((c.textContent.match(/(\d+)\s*pending/) || [])[1] || 0) > n;
    }, pendingBefore, { timeout: 10000 });
    if ((await board.getByTestId('notification-toasts').locator('[role=status]').count()) !== 0) throw new Error('the Approvals page popped up a notice about itself');
    await board.close();
    ok('supervisor bell, pop-up and Casual Leave card updated live without reloading');

    // 3. Detail page, reject with remarks.
    await sup.goto(BASE + '/approvals');
    await sup.getByTestId('approval-card-casual_leave').click();
    await sup.waitForURL(/category=casual_leave/);
    await sup.locator('div', { hasText: /Notification browser test/ }).last().locator('a', { hasText: 'Details and history' }).click();
    await sup.waitForURL(/\/approvals\/[0-9a-f-]{36}$/);
    await sup.getByText(/^APR-[A-Z0-9]{6}$/).first().waitFor();
    await sup.getByText(/Notification browser test/).first().waitFor();
    await sup.getByText('This request is waiting for your decision.').waitFor();
    await sup.getByText('Approval authority').waitFor();
    await sup.getByTestId('approval-trail').getByText('Submitted').waitFor();
    await op.goto(BASE + '/'); // away from the leave page, so the decision pops up
    await op.getByTestId('notification-bell').waitFor();
    await op.waitForTimeout(1500); // the live stream connects
    await sup.getByRole('button', { name: 'Reject' }).click();
    await sup.getByText('Add remarks so the person knows why it was rejected.').waitFor();
    await sup.fill('textarea[aria-label=Remarks]', 'Line is short that week, please pick another day');
    // Pop-ups go after a few seconds, so start watching for the operator's before deciding.
    const toast = op.getByTestId('notification-toasts').getByText(/rejected/i).first().waitFor({ timeout: 20000 });
    await sup.getByRole('button', { name: 'Reject' }).click();
    await sup.getByText('Rejected. The person has been told, with your remarks.').waitFor();
    await sup.getByTestId('approval-trail').getByText('Remarks: Line is short that week, please pick another day').waitFor({ timeout: 10000 });
    const detailUrl = sup.url();
    ok('detail shows ID, authority and history; reject needs remarks; remarks recorded in the history');

    // 4. The operator hears about it.
    await toast;
    await op.goto(BASE + '/notifications?category=approvals');
    const item = op.getByTestId('notification-item').filter({ hasText: /rejected/i }).first();
    await item.waitFor();
    await item.getByText('Important').waitFor();
    await item.getByText(/Remarks: Line is short/).waitFor();
    await op.goto(BASE + '/approvals?view=mine');
    await op.getByTestId('approval-card-casual_leave').waitFor();
    await op.getByTestId('approval-row').filter({ hasText: 'Rejected' }).first().waitFor();
    await op.goto(detailUrl);
    await op.getByTestId('approval-status-message').getByText(/rejected\. Please check the remarks/i).waitFor();
    await op.getByTestId('approval-trail').getByText('Remarks: Line is short that week, please pick another day').waitFor();
    ok('operator told live (pop-up, Important, Approvals category) and sees the rejection with remarks');

    // 5. Mark all read.
    await op.goto(BASE + '/notifications');
    // Opening Approvals above already read its notices, so mark one unread again first.
    if ((await count(op)) === 0) {
      await op.getByTestId('notification-item').first().getByRole('button', { name: 'Mark unread' }).click();
      await op.getByTestId('notification-count').waitFor({ timeout: 10000 });
    }
    if ((await count(op)) === 0) throw new Error('expected unread notices before Mark all read');
    await op.getByRole('button', { name: 'Mark all read' }).click();
    await op.waitForFunction(() => !document.querySelector('[data-testid=notification-count]'), null, { timeout: 10000 });
    await op.reload();
    if ((await count(op)) !== 0) throw new Error('unread count came back after reload');
    ok('Mark all read clears the bell, and it stays cleared');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('notifications flow passed');
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  if (errs.length) console.error(errs.join('\n'));
  process.exit(1);
});
