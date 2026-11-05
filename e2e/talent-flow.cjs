/**
 * Performance, learning and engagement end-to-end flow in a real browser, against the demo workspace.
 *
 *   pnpm db:reset            # fresh demo workspace (HR admin must not have MFA enrolled yet)
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/talent-flow.cjs
 *
 * 1. An operator adds a goal with a key result and checks in.
 * 2. The operator writes and submits their self review in the demo mid-year cycle.
 * 3. Their supervisor writes and submits the manager review.
 * 4. HR starts calibration, changes the final rating with a reason and releases results.
 * 5. The operator reads the final rating and the anonymous peer feedback, and acknowledges.
 * 6. The operator enrols in a self-enrol course and completes it.
 * 7. The operator answers the demo pulse survey; HR opens the results.
 * 8. The operator recognises a colleague.
 * Also opens every talent screen and fails on any browser error.
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

const shot = async (p, e) => {
  await p.screenshot({ path: process.env.SHOT ?? '/tmp/talent-fail.png', fullPage: true }).catch(() => {});
  throw e;
};
const dialogOf = (p) => p.locator('dialog[open]');
const CYCLE = 'Mid-year';

/** Fill every question of a review form and pick a rating, then submit. */
async function writeReview(p, rating, label) {
  const boxes = p.locator('form textarea[name^="q_"]');
  const n = await boxes.count();
  if (!n) throw new Error('no review questions on the page');
  for (let i = 0; i < n; i++) await boxes.nth(i).fill(`${label} answer ${i + 1} (demo e2e)`);
  await p.selectOption('form select[name=rating]', String(rating));
  await p.click(`button:has-text("Submit ${label}")`);
}

(async () => {
  const b = await chromium.launch();

  // 1. Goal and check-in.
  const arjun = await signIn(b, 'operator1@demo.crew.local');
  await arjun.goto(BASE + '/goals');
  await arjun.locator('text=Get certified on the new CNC cell').first().waitFor({ timeout: 10000 }).catch((e) => shot(arjun, e));
  await arjun.click('button:has-text("New goal")');
  const gd = dialogOf(arjun);
  await gd.locator('input[name=title]').fill('Run quick changeovers on line 2');
  await gd.locator('input[name=title]').waitFor();
  await arjun.waitForLoadState('networkidle');
  await gd.locator('button:has-text("Add key result")').click();
  await gd.locator('input[aria-label="Key result 1"]').fill('Changeovers under 10 minutes');
  await gd.locator('label:has-text("Target") input').fill('10');
  const parent = await gd.locator('select[name=parentGoalId] option', { hasText: 'Cut night-shift handover defects' }).getAttribute('value');
  await gd.locator('select[name=parentGoalId]').selectOption(parent);
  await arjun.click('button:has-text("Add goal")');
  await arjun.waitForURL(/\/goals\/[0-9a-f-]{36}$/, { timeout: 10000 }).catch((e) => shot(arjun, e));
  await arjun.getByRole('textbox', { name: 'Changeovers under 10 minutes', exact: true }).fill('4');
  await arjun.locator('textarea').last().fill('Two changeovers this week came in under ten minutes');
  await arjun.click('button:has-text("Save check-in")');
  await arjun.locator('text=Two changeovers this week').waitFor({ timeout: 10000 }).catch((e) => shot(arjun, e));
  await arjun.locator('text=40%').first().waitFor();
  ok('operator added an aligned goal and checked in at 40%');

  // 2. Self review.
  await arjun.goto(BASE + '/reviews');
  await arjun.click('a:has-text("Write self review")');
  await arjun.waitForURL(/\/reviews\/[0-9a-f-]{36}$/);
  const reviewUrl = arjun.url();
  await writeReview(arjun, 4, 'self review');
  await arjun.locator('text=/Submitted .*/').first().waitFor({ timeout: 10000 }).catch((e) => shot(arjun, e));
  ok('operator submitted their self review');

  // 3. Manager review.
  const sup = await signIn(b, 'supervisor@demo.crew.local');
  await sup.goto(BASE + '/reviews?view=team');
  await sup.locator('tr', { hasText: 'Arjun Kulkarni' }).locator('a:has-text("Write review")').click();
  await sup.waitForURL(reviewUrl, { timeout: 10000 }).catch((e) => shot(sup, e));
  await sup.locator('text=self review answer 1 (demo e2e)').waitFor();
  await sup.locator('text=Ganesh').first().waitFor(); // the manager sees who gave peer feedback
  await writeReview(sup, 3, 'manager review');
  await sup.locator('text=/Submitted .* by Sunita Patil/').waitFor({ timeout: 10000 }).catch((e) => shot(sup, e));
  ok('supervisor saw the self review and submitted the manager review');

  // An employee cannot see the manager's part before release.
  await arjun.goto(reviewUrl);
  if (await arjun.locator('text=manager review answer 1').count()) throw new Error('manager review visible to the employee before release');
  ok('the manager review stays hidden from the employee until release');

  // 4. HR calibrates and releases.
  // The HR admin must not have two-step verification on yet, so CI runs this flow before the recruitment flow.
  const hr = await signIn(b, 'hr.admin@demo.crew.local');
  await hr.goto(BASE + '/reviews/cycles');
  await hr.click(`a:has-text("${CYCLE}")`);
  await hr.waitForURL(/\/reviews\/cycles\/[0-9a-f-]{36}$/);
  const cycleUrl = hr.url();
  await hr.click('button:has-text("Start calibration")');
  await hr.locator('button:has-text("Release results")').waitFor({ timeout: 10000 }).catch((e) => shot(hr, e));
  await hr.goto(reviewUrl);
  await hr.locator('text=Final rating').first().waitFor();
  await hr.getByLabel('New final rating').selectOption('4');
  await hr.getByLabel('Reason (kept in the history)').fill('Line 2 changeovers improved across the whole period');
  await hr.click('button:has-text("Change final rating")');
  await hr.locator('text=/changed 3 → 4: Line 2 changeovers/').waitFor({ timeout: 10000 }).catch((e) => shot(hr, e));
  await hr.goto(cycleUrl);
  await hr.click('button:has-text("Release results")');
  await hr.locator('text=Released').first().waitFor({ timeout: 10000 }).catch((e) => shot(hr, e));
  ok('HR calibrated the final rating with a reason and released results');

  // 5. The employee reads results and acknowledges.
  await arjun.goto(BASE + '/reviews');
  await arjun.click('a:has-text("Read your results")');
  await arjun.waitForURL(reviewUrl);
  await arjun.locator('text=manager review answer 1 (demo e2e)').waitFor({ timeout: 10000 }).catch((e) => shot(arjun, e));
  await arjun.locator('text=Shared without names, in alphabetical order.').waitFor();
  for (const name of ['Neha Deshmukh', 'Rekha', 'Ganesh']) {
    if (await arjun.locator('main').getByText(name).count()) throw new Error(`peer feedback shows a reviewer name (${name}) to the employee`);
  }
  await arjun.getByLabel('Comment').fill('Thanks, agreed on the changeover focus');
  await arjun.click('button:has-text("Acknowledge review")');
  await arjun.locator('text=/Acknowledged .*Thanks, agreed/').waitFor({ timeout: 10000 }).catch((e) => shot(arjun, e));
  ok('operator read the final rating and anonymous peer feedback, and acknowledged');

  // 6. Learning: self-enrol and complete.
  await arjun.goto(BASE + '/learning?view=catalogue');
  await arjun.locator('li', { hasText: 'Lean basics' }).locator('button:has-text("Enrol")').click();
  await arjun.locator('li', { hasText: 'Lean basics' }).locator('text=In your learning').waitFor({ timeout: 10000 }).catch((e) => shot(arjun, e));
  await arjun.goto(BASE + '/learning');
  const lean = arjun.locator('tr', { hasText: 'Lean basics' });
  await lean.locator('button:has-text("Mark complete")').click();
  await lean.locator('text=/Completed \\d{4}-\\d{2}-\\d{2}/').waitFor({ timeout: 10000 }).catch((e) => shot(arjun, e));
  ok('operator enrolled in a course and completed it');

  // 7. Survey.
  await arjun.goto(BASE + '/surveys');
  await arjun.locator('tr', { hasText: 'Plant pulse' }).locator('a:has-text("Answer")').click();
  await arjun.waitForURL(/\/surveys\/[0-9a-f-]{36}$/);
  const surveyUrl = arjun.url();
  const groups = arjun.locator('[role=radiogroup]');
  const g = await groups.count();
  for (let i = 0; i < g; i++) {
    const opts = groups.nth(i).locator('label');
    await opts.nth((await opts.count()) - 2).click();
  }
  const text = arjun.locator('form textarea');
  if (await text.count()) await text.first().fill('More cross-training between lines, please');
  await arjun.click('button:has-text("Send answers")');
  await arjun.waitForURL(/\/surveys$/, { timeout: 10000 }).catch((e) => shot(arjun, e));
  if (await arjun.locator('tr', { hasText: 'Plant pulse' }).locator('a:has-text("Answer")').count()) throw new Error('survey still offered after answering');
  ok('operator answered the anonymous pulse survey');

  await hr.goto(BASE + '/surveys/manage');
  await hr.click('a:has-text("Plant pulse")');
  await hr.locator('text=More cross-training between lines, please').waitFor({ timeout: 10000 }).catch((e) => shot(hr, e));
  await hr.locator('text=/eNPS/').first().waitFor();
  await hr.locator('text=By department').waitFor();
  ok('HR opened the survey results with eNPS, comments and the anonymity-safe breakdown');

  // 7b. Personal pages opened directly by someone they are not for explain themselves instead of "page not found".
  await hr.goto(surveyUrl); // HR was not invited to the pulse, and runs surveys: the results page opens instead
  await hr.waitForURL(/\/surveys\/manage\/[0-9a-f-]{36}$/, { timeout: 10000 }).catch((e) => shot(hr, e));
  await hr.locator('text=By department').waitFor();
  await sup.goto(surveyUrl.replace(/[0-9a-f-]{36}$/, '00000000-0000-4000-8000-000000000000'));
  await sup.getByTestId('survey-not-invited').getByText('This survey is not open to you').waitFor({ timeout: 10000 }).catch((e) => shot(sup, e));
  const API = (process.env.CREW_API_URL ?? 'http://localhost:4000') + '/api/v1';
  let token;
  for (let attempt = 0; !token; attempt++) {
    const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'hr.admin@demo.crew.local', password: PASSWORD }) });
    if (r.status === 429 && attempt < 5) { await new Promise((res) => setTimeout(res, 15000)); continue; }
    const j = await r.json();
    if (j.status !== 'ok') throw new Error(`API sign-in for HR: ${r.status} ${JSON.stringify(j)}`);
    token = j.accessToken;
  }
  const review = await fetch(`${API}/reviews/${reviewUrl.split('/').pop()}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  const peerRequest = review.peer?.requests?.[0];
  if (!peerRequest) throw new Error('HR sees no peer feedback requests on the review');
  await hr.goto(BASE + `/reviews/feedback/${peerRequest.id}`); // asked of a colleague, not of HR
  await hr.getByTestId('feedback-not-yours').getByText('This feedback request was sent to someone else').waitFor({ timeout: 10000 }).catch((e) => shot(hr, e));
  ok('a survey or feedback request opened directly by someone else shows results (HR) or a clear explanation, not "page not found"');

  // 8. Recognition.
  await arjun.goto(BASE + '/recognition');
  await arjun.getByLabel('Find a colleague').fill('Neha');
  await arjun.getByLabel('Find a colleague').press('Enter');
  await arjun.click('ul button:has-text("Neha Deshmukh")');
  await arjun.locator('select[name=valueId]').selectOption({ label: 'Teamwork' });
  await arjun.locator('textarea[name=message]').fill('Covered my changeover at short notice on Tuesday night');
  await arjun.click('button:has-text("Post recognition")');
  await arjun.locator('text=Covered my changeover at short notice').waitFor({ timeout: 10000 }).catch((e) => shot(arjun, e));
  ok('operator recognised a colleague for a company value');

  for (const path of ['/goals?view=team', '/reviews?view=feedback', '/learning?view=team', '/learning/catalogue', '/surveys/manage', '/recognition', '/reviews/cycles']) {
    await hr.goto(BASE + path);
    await hr.waitForLoadState('networkidle');
  }
  for (const path of ['/goals?view=team', '/reviews?view=team', '/learning?view=team']) {
    await sup.goto(BASE + path);
    await sup.waitForLoadState('networkidle');
  }
  ok('every talent screen renders');

  await b.close();
  if (errs.length) {
    console.error(errs.join('\n'));
    process.exit(1);
  }
  console.log('talent flow: OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
