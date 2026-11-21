/**
 * Learning & Development end-to-end flow in a real browser, against a fresh demo workspace: the "Workplace Safety
 * Training 2026" journey from the L&D spec.
 *
 *   pnpm db:reset            # fresh demo workspace (the owner must not have MFA enrolled yet)
 *   node apps/api/dist/main.js & pnpm --filter @crew/web start &
 *   node e2e/learning-flow.cjs          # SHOTS=<folder> also saves screenshots
 *
 * 0. Setup through the API: an HR Workspace "Pune Plant HR" run by the QA lead, looking after two operators.
 * 1. The Super Workspace sees that HR Workspaces may only view learning, and lets Pune Plant HR grade and report.
 * 2. The Super Workspace builds the module in the wizard: a welcome text, an uploaded video that must be watched to the
 *    end, a PDF handbook, a quiz (multiple choice and true/false) and an assignment, with a certificate; publishes it
 *    and assigns it to all employees with a due date.
 * 3. An operator finds it in My learning, watches the video to the end, reads the handbook, passes the quiz and submits
 *    the assignment.
 * 4. Pune Plant HR asks for a resubmission; the operator resubmits; HR approves with a score. HR cannot create modules
 *    and its report only shows its own people.
 * 5. The operator's module is completed with a certificate; the Super Workspace dashboard and Excel export show it.
 * 6. The Super Workspace publishes a change as version 2; the operator's record stays on version 1.
 * Fails on any browser error.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.CREW_API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
const SHOTS = process.env.SHOTS;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const SUPER = 'owner@demo.crew.local';
const HR = 'qa.lead@demo.crew.local';
const LEARNER = 'operator1@demo.crew.local';
const TITLE = 'Workplace Safety Training 2026';
const VIDEO = path.join(__dirname, 'fixtures', 'safety-intro.webm');

const ok = (m) => console.log(`ok - ${m}`);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource: the server responded with a status of 40[49]/.test(m.text()) && errs.push(`${who} ${m.text()}`));
};

async function apiToken(email) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    if (res.status === 429 && attempt < 5) { await new Promise((r) => setTimeout(r, 20000)); continue; }
    const j = await res.json();
    if (j.status !== 'ok') throw new Error(`${email} needs ${j.status ?? res.status} to sign in through the API; run on a fresh database`);
    return j.accessToken;
  }
}
async function api(token, method, p, body) {
  const res = await fetch(`${API}/api/v1${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function signIn(b, email, viewport = { width: 1440, height: 960 }) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: SHOTS ? 2 : 1, acceptDownloads: true });
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

async function shot(p, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await p.waitForLoadState('networkidle').catch(() => {});
  // Long pages are shot at the visible part (the app shell is fixed, so full-page shots of tall pages break it).
  const tall = await p.evaluate(() => document.documentElement.scrollHeight > 1700);
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: !tall });
}

/** A one-page PDF, so the handbook is a real document the browser can show. */
function pdfBytes() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 24 Tf 72 760 Td (Workplace safety handbook) Tj 0 -40 Td /F1 14 Tf (Exits, alarms and first aid.) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const block = (p, kind) => p.locator(`[data-testid="block-editor"][data-kind="${kind}"]`).last();

(async () => {
  const b = await chromium.launch();
  try {
    // 0. Setup: an HR Workspace for the plant, run by the QA lead, looking after two operators.
    const owner = await apiToken(SUPER);
    const qa = await api(await apiToken(HR), 'GET', '/me');
    const learnerMe = await api(await apiToken(LEARNER), 'GET', '/me');
    const neha = await api(await apiToken('operator2@demo.crew.local'), 'GET', '/me');
    const hrMembership = qa.body.membershipId ?? qa.body.membership?.id;
    const arjunId = learnerMe.body.employeeId ?? learnerMe.body.employee?.id;
    const nehaId = neha.body.employeeId ?? neha.body.employee?.id;
    expect(hrMembership && arjunId && nehaId, `could not read the demo people: ${JSON.stringify({ hrMembership, arjunId, nehaId })}`);
    const ws = await api(owner, 'POST', '/hr-workspaces', { name: 'Pune Plant HR', kind: 'branch', features: ['learning', 'leave'], adminMembershipIds: [hrMembership] });
    expect(ws.status === 201, `HR Workspace: ${ws.status} ${JSON.stringify(ws.body)}`);
    const moved = await api(owner, 'POST', `/hr-workspaces/${ws.body.id}/members`, { employeeIds: [arjunId, nehaId], reason: 'Pune plant' });
    expect(moved.status === 201, `members: ${moved.status} ${JSON.stringify(moved.body)}`);
    ok('Pune Plant HR looks after two operators, run by the QA lead');

    // 1. Super Workspace: HR Workspaces may only view until switched on.
    const sup = await signIn(b, SUPER);
    await sup.goto(BASE + '/learning/manage/settings');
    const row = sup.getByTestId('permissions-Pune Plant HR');
    await row.waitFor();
    for (const cap of ['create', 'edit', 'publish', 'assign', 'quiz', 'assignment', 'grade', 'reports', 'export']) {
      expect((await row.getByTestId(`cap-${ws.body.id}-${cap}`).getAttribute('aria-checked')) === 'false', `${cap} should be off by default`);
    }
    expect((await row.getByTestId(`cap-${ws.body.id}-view`).getAttribute('aria-checked')) === 'true', 'view is on by default');
    for (const cap of ['grade', 'reports']) {
      await row.getByTestId(`cap-${ws.body.id}-${cap}`).click();
      await sup.waitForFunction(([sel]) => document.querySelector(sel)?.getAttribute('aria-checked') === 'true', [`[data-testid="cap-${ws.body.id}-${cap}"]`], { timeout: 10000 });
    }
    await shot(sup, '06-permissions');
    ok('HR Workspaces start with view only; the Super Workspace let Pune Plant HR grade and see reports');

    // 2. Build the module in the wizard.
    await sup.goto(BASE + '/learning/manage/new');
    await sup.getByTestId('module-title').fill(TITLE);
    await sup.getByLabel('Short description').fill('Fire exits, alarms, first aid and reporting hazards');
    await sup.getByTestId('module-category').selectOption('Workplace Safety');
    await sup.getByLabel('Topic').fill('Fire safety');
    await sup.getByTestId('module-skills').fill('Safety Awareness');
    await sup.getByTestId('module-skills').press('Enter');
    await sup.getByLabel('Estimated length (minutes)').fill('45');
    await sup.getByTestId('module-creator').fill('Aarav Mehta');
    await sup.getByLabel('Creator designation').fill('Learning & Development Manager');
    await sup.getByTestId('wizard-next').click();

    await sup.getByTestId('add-text').click();
    await block(sup, 'text').locator('[data-testid^="title-"]').fill('Welcome');
    await block(sup, 'text').locator('[contenteditable]').fill('Why safety matters at our plant. Read this, then watch the video.');

    await sup.getByTestId('add-video').click();
    await block(sup, 'video').getByRole('radio', { name: 'Upload a file' }).click();
    await block(sup, 'video').locator('input[type=file]').setInputFiles(VIDEO);
    await block(sup, 'video').getByText('File uploaded').waitFor({ timeout: 20000 });
    await block(sup, 'video').locator('[data-testid^="title-"]').fill('Fire exits and alarms');

    await sup.getByTestId('add-document').click();
    await block(sup, 'document').getByRole('radio', { name: 'Upload a file' }).click();
    await block(sup, 'document').locator('input[type=file]').setInputFiles({ name: 'safety-handbook.pdf', mimeType: 'application/pdf', buffer: pdfBytes() });
    await block(sup, 'document').getByText('File uploaded').waitFor({ timeout: 20000 });
    await block(sup, 'document').locator('[data-testid^="title-"]').fill('Safety handbook');

    await sup.getByTestId('add-quiz').click();
    const quiz = block(sup, 'quiz');
    await quiz.locator('[data-testid^="title-"]').fill('Safety check');
    const q1 = quiz.getByTestId('question-editor').nth(0);
    await q1.getByTestId('question-text').fill('A fire alarm rings. How do you leave the building?');
    await q1.getByLabel('Option 1', { exact: true }).fill('Use the stairs');
    await q1.getByLabel('Option 2', { exact: true }).fill('Use the lift');
    await q1.getByLabel('Option 1 is correct').check();
    await quiz.getByTestId('add-question').click();
    const q2 = quiz.getByTestId('question-editor').nth(1);
    await q2.getByLabel('Question type').selectOption('true_false');
    await q2.getByTestId('question-text').fill('You may block a fire exit for a few minutes.');
    await q2.getByLabel('False is correct').check();

    await sup.getByTestId('add-assignment').click();
    const asg = block(sup, 'assignment');
    await asg.locator('[data-testid^="title-"]').fill('Report a hazard');
    await asg.locator('[data-testid^="instructions-"]').fill('Find one safety hazard at your workstation and describe how you fixed it.');
    await quiz.scrollIntoViewIfNeeded();
    await shot(sup, '04-module-builder');
    await sup.getByTestId('wizard-settings').click();
    expect((await sup.getByTestId('module-certificate').getAttribute('aria-checked')) === 'true', 'certificates are on by default');
    await sup.getByTestId('save-module').click();
    await sup.waitForURL(/\/learning\/manage\/modules\/[0-9a-f-]{36}/, { timeout: 20000 });
    const moduleId = sup.url().match(/modules\/([0-9a-f-]{36})/)[1];
    ok('the Super Workspace built a five-step module with a video, a PDF, a quiz and an assignment');

    await sup.getByTestId('publish-module').click();
    await sup.getByTestId('confirm-publish').click();
    await sup.getByText('Published. New learners get this version.').waitFor({ timeout: 15000 });
    await sup.goto(`${BASE}/learning/manage/modules/${moduleId}?tab=assign`);
    await sup.getByTestId('audience-all').check();
    const due = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
    await sup.getByRole('textbox', { name: 'Due date' }).fill(due);
    await sup.getByTestId('assign-module').click();
    await sup.getByText(/^Assigned to \d+ people/).waitFor({ timeout: 15000 });
    await shot(sup, '05-module-assign');
    ok('published as version 1 and assigned to all employees with a due date');

    // 3. The operator learns.
    const arjun = await signIn(b, LEARNER);
    await arjun.goto(BASE + '/learning');
    const card = arjun.getByTestId('my-learning-item').filter({ hasText: TITLE });
    await card.waitFor();
    expect((await card.innerText()).includes('Aarav Mehta · Learning & Development Manager · Super Workspace'), 'the card names the creator with their level');
    await shot(arjun, '01-my-learning');
    await card.getByTestId('open-learning').click();
    await arjun.getByTestId('mark-complete').click(); // Welcome (text)
    const video = arjun.locator('video');
    await video.waitFor();
    await arjun.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 1; }, null, { timeout: 15000 });
    // Skipping ahead does not count: the player pulls it back while the video must be watched.
    await video.evaluate((v) => { v.currentTime = 5; });
    await arjun.waitForTimeout(300);
    expect((await video.evaluate((v) => v.currentTime)) < 2, 'seeking past what was watched is held back');
    await video.evaluate((v) => { v.muted = true; return v.play(); });
    await arjun.locator('[aria-current="step"]', { hasText: 'Fire exits and alarms' }).getByLabel('Done', { exact: true }).waitFor({ timeout: 30000 });
    await shot(arjun, '02-player-video');
    ok('the operator watched the video to the end and it counted');

    await arjun.getByTestId('next-step').click();
    await arjun.locator('iframe[title="Safety handbook"]').waitFor();
    await arjun.getByTestId('mark-complete').click();
    await arjun.getByTestId('start-quiz').click();
    await arjun.getByLabel('Use the stairs').check();
    await arjun.getByLabel('False', { exact: true }).check();
    await arjun.getByTestId('submit-quiz').click();
    await arjun.getByText('You scored 100%: passed').waitFor({ timeout: 15000 });
    await shot(arjun, '03-player-quiz-result');
    ok('the operator passed the quiz, marked on the server');

    await arjun.getByTestId('next-step').click();
    await arjun.getByLabel('Written response').fill('A loose cable under my desk: I tied it with a clip.');
    await arjun.getByTestId('submit-assignment').click();
    await arjun.getByTestId('my-submission').getByText('Waiting for review').waitFor({ timeout: 15000 });
    ok('the operator submitted the assignment');

    // 4. Pune Plant HR reviews within its powers and its own people.
    const hr = await signIn(b, HR);
    await hr.goto(BASE + '/learning/manage');
    expect(!(await hr.getByTestId('nav-new-module').count()), 'Pune Plant HR may not create modules');
    await hr.goto(BASE + '/learning/manage/reviews');
    const sub = hr.getByTestId('submission-card').filter({ hasText: 'Arjun Kulkarni' });
    await sub.getByTestId('review-feedback').fill('Add what you did so it does not happen again.');
    await sub.getByTestId('review-resubmit').click();
    await hr.getByText('Resubmission requested. The learner is told.').waitFor({ timeout: 15000 });

    await arjun.reload();
    await arjun.getByText('Submit again').waitFor({ timeout: 15000 });
    await arjun.getByLabel('Written response').fill('Tied the cable and asked facilities to add a cable tray.');
    await arjun.getByTestId('submit-assignment').click();
    await arjun.getByTestId('my-submission').nth(1).getByText('Waiting for review').waitFor({ timeout: 15000 });

    await hr.reload();
    const again = hr.getByTestId('submission-card').filter({ hasText: 'Arjun Kulkarni' });
    await again.getByTestId('review-score').fill('80');
    await again.getByTestId('review-feedback').fill('Good fix.');
    await shot(hr, '07-reviews');
    await again.getByTestId('review-approve').click();
    await hr.getByText('Approved. The learner is told.').waitFor({ timeout: 15000 });
    await hr.goto(BASE + '/learning/manage/reports');
    const rows = hr.getByTestId('report-row');
    await rows.first().waitFor();
    const reportText = await hr.locator('main').innerText();
    expect(!/Aarav Mehta|Priya Nair|Farhan Qureshi/.test(reportText), 'the HR Workspace report shows only its own people');
    const people = new Set((await rows.allInnerTexts()).map((t) => t.split('\n')[0].trim()));
    expect([...people].sort().join() === 'Arjun Kulkarni,Neha Deshmukh', `Pune Plant HR sees its two operators only, saw ${[...people]}`);
    ok('Pune Plant HR asked for a resubmission, approved it with a score, and reports only on its own people');

    // 5. Completion, certificate, dashboard and export.
    await arjun.goto(BASE + '/learning?tab=completed');
    await arjun.getByTestId('my-learning-item').filter({ hasText: TITLE }).getByRole('link', { name: 'Certificate' }).click();
    const cert = arjun.getByTestId('certificate');
    await cert.waitFor();
    const certText = await cert.innerText();
    expect(certText.includes('Arjun Kulkarni') && /SC-\d{4}-[A-Z0-9]{8}/.test(certText) && certText.includes('Score'), `certificate: ${certText}`);
    await shot(arjun, '10-certificate');
    ok('the module is completed with a numbered certificate');

    await sup.goto(BASE + '/learning/manage');
    await sup.getByTestId('learning-dashboard').waitFor();
    await sup.getByTestId('by-hr-workspace').getByText('Pune Plant HR').waitFor();
    await shot(sup, '08-dashboard');
    await sup.goto(BASE + '/learning/manage/library');
    await shot(sup, '11-library');
    await sup.goto(`${BASE}/learning/manage/reports?moduleId=${moduleId}&status=completed`);
    await sup.getByTestId('report-row').filter({ hasText: 'Arjun Kulkarni' }).waitFor();
    await shot(sup, '09-reports');
    const [download] = await Promise.all([sup.waitForEvent('download'), sup.getByTestId('export-learning').click()]);
    expect(/learning-report-.*\.xlsx$/.test(download.suggestedFilename()), `export file ${download.suggestedFilename()}`);
    const file = await download.path();
    expect(fs.readFileSync(file).subarray(0, 2).toString() === 'PK', 'the export is an Excel file');
    ok('the Super Workspace dashboard and Excel export include the completion');

    // 6. A new version leaves finished records alone.
    await sup.goto(`${BASE}/learning/manage/modules/${moduleId}`);
    await sup.getByLabel('Full description').fill('Updated for the 2026 fire drill.');
    await sup.getByTestId('save-module').click();
    await sup.getByText('Module saved.').waitFor({ timeout: 15000 });
    await sup.getByText('Unpublished changes').first().waitFor();
    await sup.getByTestId('publish-module').click();
    await sup.getByLabel('What changed').fill('Fire drill update');
    await sup.getByTestId('confirm-publish').click();
    await sup.getByText('Published. New learners get this version.').waitFor({ timeout: 15000 });
    await sup.goto(`${BASE}/learning/manage/learners/${arjunId}`);
    const hist = await sup.locator('main').innerText();
    expect(hist.includes(TITLE) && hist.includes('Version 1') && hist.includes('Completed'), 'the finished record stays on version 1');
    ok('version 2 published; the completed record keeps version 1');

    // The phone layout of My learning.
    if (SHOTS) {
      const phone = await signIn(b, 'operator2@demo.crew.local', { width: 390, height: 844 });
      await phone.goto(BASE + '/learning');
      await phone.getByTestId('my-learning-item').first().waitFor();
      await shot(phone, '12-my-learning-phone');
    }

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    ok('no browser errors');
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
