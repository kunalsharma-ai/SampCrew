/**
 * Core HR end-to-end flow in a real browser: hire, onboard, apply for leave, approve.
 *
 *   pnpm db:reset            # fresh demo workspace
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/hr-flow.cjs
 *
 * 1. The demo HR admin adds an employee reporting to the assembly supervisor and invites them to CREW.
 * 2. The new joiner accepts the invitation, sees their onboarding tasks and completes one.
 * 3. They apply for a day of casual leave, with a live preview of the days and balance.
 * 4. The supervisor approves it from the Approvals inbox.
 * 5. The joiner sees the approved request and a notification.
 * Also opens every new Core HR screen as HR and fails on any browser error.
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

async function signIn(b, email, password = PASSWORD) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const p = await ctx.newPage();
  watch(p, email);
  await p.goto(BASE + '/login');
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', password);
  await p.click('button[type=submit]');
  await p.waitForURL((u) => u.pathname === '/', { timeout: 15000 });
  return p;
}

/** Next working day at least a week away, in the current year (so the leave balance applies). */
function leaveDay() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) throw new Error('Run this test before late December (leave must fall in the current year)');
  return d.toISOString().slice(0, 10);
}

(async () => {
  const b = await chromium.launch();
  const stamp = Date.now();
  const email = `riya.${stamp}@demo.crew.local`;

  // 1. HR hires and invites.
  const hr = await signIn(b, 'hr.admin@demo.crew.local');
  for (const path of ['/employees', '/approvals', '/leave', '/tasks', '/settings/leave', '/settings/onboarding']) {
    await hr.goto(BASE + path);
    if (hr.url().includes('/no-access') || hr.url().includes('/login')) throw new Error(`HR admin could not open ${path}`);
  }
  ok('HR admin opens every Core HR screen');
  await hr.goto(BASE + '/employees');
  await hr.click('text=Add employee');
  await hr.fill('dialog input[name=firstName]', 'Riya');
  await hr.fill('dialog input[name=lastName]', `Tester ${stamp % 10000}`);
  await hr.fill('dialog input[name=workEmail]', email);
  // The guided hire: personal details, employment, then department and reporting.
  const next = async (label) => { await hr.click(`dialog button:has-text("Next: ${label}")`); await hr.waitForSelector(`dialog h3:has-text("${label}")`); };
  await next('Employment');
  await next('Department & reporting');
  const sunita = await hr.$eval('dialog select[name=managerEmployeeId]', (s) => [...s.options].find((o) => o.text.startsWith('Sunita Patil'))?.value);
  await hr.selectOption('dialog select[name=managerEmployeeId]', sunita);
  await hr.locator('dialog select[name=departmentId]').selectOption({ label: 'Assembly Line' });
  await hr.locator('dialog select[name=locationId]').selectOption({ label: 'Pune Plant' });
  await next('Compensation');
  await next('Documents');
  await next('Access & onboarding');
  await hr.click('dialog label:has-text("Invite them to CREW")');
  if (!(await hr.isChecked('dialog input[type=checkbox]'))) throw new Error('clicking the invite label did not tick the box');
  await next('Review');
  await hr.click('dialog button[type=submit]');
  const link = (await hr.locator('code', { hasText: 'accept-invite' }).textContent({ timeout: 10000 }).catch(async (e) => { await hr.screenshot({ path: process.env.SHOT ?? '/tmp/hr-fail.png' }); throw e; })).trim();
  ok('employee added and invitation queued');
  await hr.fill('input[name=q]', 'Riya');
  await hr.press('input[name=q]', 'Enter');
  await hr.click(`text=Riya Tester ${stamp % 10000}`);
  await hr.waitForURL(/\/employees\/[0-9a-f-]{36}/);
  const profileUrl = hr.url().split('?')[0];
  await hr.goto(profileUrl + '?tab=onboarding');
  await hr.waitForSelector('text=Onboarding checklist');
  const taskCount = await hr.locator('li >> text=/HR|Manager|Employee|IT/').count();
  if (taskCount < 5) throw new Error(`expected an onboarding checklist, saw ${taskCount} tasks`);
  await hr.goto(profileUrl + '?tab=job');
  await hr.waitForSelector('text=Job history');
  await hr.waitForSelector('td >> text=Hire');
  ok(`profile shows the job record and ${taskCount} onboarding tasks`);

  // 2. The joiner accepts the invitation and completes an onboarding task.
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const joiner = await ctx.newPage();
  watch(joiner, 'joiner');
  await joiner.goto(link);
  await joiner.fill('input[name=password]', 'Riya-Tester-2026!');
  await joiner.click('button[type=submit]');
  await joiner.waitForURL((u) => u.pathname === '/', { timeout: 15000 });
  await joiner.goto(BASE + '/tasks');
  const first = joiner.locator('button[aria-label^="Mark"]').first();
  const label = await first.getAttribute('aria-label');
  await first.click();
  await joiner.locator(`button[aria-label='${label.replace(/'/g, "\\'")}']`).waitFor({ state: 'detached', timeout: 10000 });
  ok(`joiner signed in and completed "${label.replace(/^Mark "|" done$/g, '')}"`);

  // 3. Apply for leave with a live preview.
  const day = leaveDay();
  await joiner.goto(BASE + '/leave');
  await joiner.click('text=Apply for leave');
  const cl = await joiner.$eval('dialog select[name=leaveTypeId]', (s) => [...s.options].find((o) => o.text.startsWith('Casual leave'))?.value);
  await joiner.selectOption('dialog select[name=leaveTypeId]', cl);
  await joiner.fill('dialog input[name=startDate]', day);
  await joiner.fill('dialog input[name=endDate]', day);
  await joiner.fill('dialog textarea[name=reason]', 'Browser test');
  await joiner.waitForSelector('dialog >> text=/1\\.00 working day/', { timeout: 10000 });
  await joiner.click('dialog >> text=Submit request');
  await joiner.waitForSelector('td >> text=Pending', { timeout: 10000 });
  ok(`leave requested for ${day} with preview`);

  // 4. The supervisor approves it.
  const sup = await signIn(b, 'supervisor@demo.crew.local');
  await sup.goto(BASE + '/approvals');
  const card = sup.locator('div', { hasText: `Riya Tester ${stamp % 10000}: Casual leave` }).last();
  await card.locator('button', { hasText: 'Approve' }).click();
  // The decision shows briefly, then the item leaves the inbox.
  await sup.locator(`text=Riya Tester ${stamp % 10000}: Casual leave`).waitFor({ state: 'detached', timeout: 10000 });
  ok('supervisor approved from the inbox');

  // 5. The joiner sees the result.
  await joiner.goto(BASE + '/leave');
  await joiner.waitForSelector('td >> text=Approved', { timeout: 10000 });
  const bell = await joiner.getAttribute('button[aria-label^="Notifications"]', 'aria-label');
  if (!/unread/.test(bell ?? '')) throw new Error(`expected an unread notification, bell says: ${bell}`);
  ok(`joiner sees the approved leave and the bell shows "${bell}"`);

  await b.close();
  if (errs.length) throw new Error('browser errors:\n' + errs.join('\n'));
  console.log('hr flow: all checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
