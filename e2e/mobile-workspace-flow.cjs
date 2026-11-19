/**
 * Mobile employee workspace end-to-end flow: tasks, appraisal and profile in the Expo web build of the app, at a
 * phone size, against the real API and the demo workspace. Set up as for e2e:mobile:
 *
 *   pnpm db:reset
 *   pnpm dev:api &                          # CORS_ORIGINS must include http://localhost:8081
 *   pnpm --filter @crew/mobile export:web   # with EXPO_PUBLIC_CREW_API_URL=http://localhost:4000
 *   node e2e/mobile-workspace-flow.cjs
 *
 * 1. HR gives Neha an acknowledgement task and a document task, and launches an appraisal cycle for her department.
 * 2. Neha's Home shows her open tasks and the self-appraisal waiting for her.
 * 3. She acknowledges the policy, photographs the document and uploads it with a remark; HR verifies it and the
 *    task is completed.
 * 4. She scores every question, writes her answers, saves a draft and submits; the appraisal moves to her manager.
 * 5. She asks to change her mobile number; it waits for HR, HR approves it and her profile shows the new number.
 * Fails on any browser error.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const API = (process.env.CREW_API_URL ?? 'http://localhost:4000') + '/api/v1';
const PORT = Number(process.env.MOBILE_PORT ?? 8081);
const APP = process.env.MOBILE_URL ?? `http://localhost:${PORT}`;
const DIST = path.join(__dirname, '..', 'apps', 'mobile', 'dist-web');
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const assert = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
};

function serve() {
  if (process.env.MOBILE_URL) return null;
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`Build the app first: pnpm --filter @crew/mobile export:web (missing ${DIST})`);
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.normalize(path.join(DIST, url));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(PORT, () => r(server)));
}

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
  if (r.status !== 'ok') throw new Error(`${email} needs ${r.status} to sign in through the API; run on a fresh database (pnpm db:reset)`);
  return r.accessToken;
}

async function signIn(p, email) {
  for (let attempt = 0; ; attempt++) {
    await p.goto(APP + '/login');
    await p.getByLabel('Work email').fill(email);
    await p.getByLabel('Password').fill(PASSWORD);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    const r = await Promise.race([
      p.getByText(/^Good (morning|afternoon|evening)/).waitFor({ timeout: 20000 }).then(() => 'in'),
      p.getByText('Too many attempts').waitFor({ timeout: 20000 }).then(() => 'limited'),
    ]);
    if (r === 'in') return;
    if (attempt >= 4) throw new Error(`sign-in for ${email} stayed rate limited`);
    await p.waitForTimeout(20000);
  }
}

// A 1x1 PNG, as a phone photo of the document.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const soon = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

(async () => {
  const server = await serve();
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text());
  });
  try {
    // 1. HR sets up the work.
    const hr = await apiLogin('hr.admin@demo.crew.local');
    const neha = (await api(hr, 'GET', '/tasks/assignable')).hr.find((x) => x.name.startsWith('Neha'));
    assert(neha, 'Neha can be given tasks');
    const run = Date.now().toString(36);
    await api(hr, 'POST', '/tasks', { category: 'hr', kind: 'acknowledgement', title: `Read the safety handbook ${run}`, priority: 'normal', dueOn: soon(5), employeeIds: [neha.id] });
    await api(hr, 'POST', '/tasks', { category: 'hr', kind: 'document', title: `Upload your address proof ${run}`, description: 'A photo of a utility bill is fine.', priority: 'high', dueOn: soon(3), employeeIds: [neha.id], document: { formats: ['image', 'pdf'], maxMb: 5 } });
    const form = await api(hr, 'POST', '/appraisals/forms/from-template', { key: 'frequent_research' });
    const flat = (l) => l.flatMap((d) => [d, ...flat(d.children ?? [])]);
    const dept = flat(await api(hr, 'GET', '/org/departments')).find((d) => d.name.toLowerCase().includes('assembly'));
    const cycle = await api(hr, 'POST', '/appraisals/cycles', { name: `Mobile appraisal ${run}`, formId: form.id, periodStart: '2026-01-01', periodEnd: '2026-12-31', selfDue: soon(10), managerDue: soon(20), hrDue: soon(30), departmentIds: [dept.id] });
    await api(hr, 'POST', `/appraisals/cycles/${cycle.id}/launch`);
    ok('HR assigns two tasks and launches an appraisal cycle');

    // 2. Home.
    await signIn(p, 'operator2@demo.crew.local');
    await p.getByTestId('home-workspace').waitFor();
    assert(/open task/.test(await p.getByTestId('home-tasks').innerText()), 'home lists open tasks');
    assert((await p.getByTestId('home-appraisal').count()) >= 1, 'home shows the self-appraisal waiting');
    ok('Home shows open tasks and the self-appraisal waiting');

    // 3. Tasks.
    await p.getByTestId('qa-tasks').click();
    await p.getByTestId('tasks-list').waitFor();
    await p.getByTestId('tasks-list').getByText(`Read the safety handbook ${run}`).click();
    await p.getByTestId('task-ack').click();
    await p.getByTestId('task-message').getByText('Acknowledged.').waitFor();
    await p.getByText('Completed').first().waitFor();
    ok('acknowledges a policy task');
    await p.goBack();
    await p.getByTestId('tasks-list').getByText(`Upload your address proof ${run}`).click();
    await p.getByTestId('task-document').waitFor();
    const chooser = p.waitForEvent('filechooser');
    await p.getByTestId('doc-library').click();
    await (await chooser).setFiles({ name: 'bill.png', mimeType: 'image/png', buffer: PNG });
    await p.getByTestId('doc-picked').waitFor();
    await p.getByLabel('Remarks (optional)').fill('Electricity bill, October');
    await p.getByTestId('doc-upload').click();
    await p.getByText('Uploaded. HR will verify it and you will be notified.').waitFor();
    await p.getByText('Waiting for HR').first().waitFor();
    const docTask = (await api(hr, 'GET', '/tasks?scope=assigned&category=hr&status=all')).find((t) => t.title === `Upload your address proof ${run}`);
    assert(docTask.status === 'pending_review' && docTask.employeeRemarks === 'Electricity bill, October', `uploaded with remarks (${docTask.status}, ${docTask.employeeRemarks})`);
    await api(hr, 'POST', `/tasks/${docTask.id}/verify`, { decision: 'verify' });
    await p.reload();
    await p.getByText('Verified').first().waitFor();
    ok('uploads a photo of the document with a remark; HR verifies it');

    // 4. Appraisal.
    await p.goto(APP + '/appraisal');
    await p.getByTestId('appraisal-open-current').click();
    await p.getByTestId('appraisal-actions').waitFor();
    const radios = p.getByRole('radio', { name: '4', exact: true });
    const n = await radios.count();
    assert(n >= 5, `score choices shown (${n})`);
    for (let i = 0; i < n; i++) await radios.nth(i).click();
    await p.getByTestId('appraisal-save').click();
    await p.getByText('Draft saved.').waitFor();
    for (const box of await p.locator('textarea').all()) if (!(await box.inputValue())) await box.fill('Cut changeover time on line 2 and trained two new joiners.');
    await p.getByText('Every required question is answered.').waitFor();
    await p.getByTestId('appraisal-submit').click();
    await p.getByText('Submitted. Your manager has been told.').waitFor();
    const nehaT = await apiLogin('operator2@demo.crew.local');
    const mine = (await api(nehaT, 'GET', '/appraisals/mine')).find((a) => a.cycleName === `Mobile appraisal ${run}`);
    assert(mine.stage === 'manager' || mine.stage === 'hr', `appraisal moved on (${mine.stage})`);
    ok('fills, saves and submits the self-appraisal');

    // 5. Profile update.
    await p.goto(APP + '/profile');
    await p.getByTestId('edit-personal').click();
    await p.getByLabel('Mobile number').fill('+91 98220 12345');
    await p.getByTestId('send-personal').click();
    await p.getByText('Sent to HR. Your profile changes once HR approves it.').waitFor();
    await p.getByText('Waiting for HR').first().waitFor();
    const pending = (await api(hr, 'GET', '/profile/updates')).find((u) => u.employee.name.startsWith('Neha') && u.section === 'personal');
    await api(hr, 'POST', `/profile/updates/${pending.id}/decide`, { decision: 'approve' });
    await p.reload();
    await p.getByTestId('profile-personal').getByText(/98220/).waitFor();
    ok('asks to change the mobile number; HR approves and the profile shows it');

    assert(errs.length === 0, `no browser errors:\n${errs.join('\n')}`);
    ok('no browser errors');
  } catch (e) {
    await p.screenshot({ path: process.env.SHOT ?? '/tmp/mobile-workspace-fail.png', fullPage: true }).catch(() => {});
    console.error(errs.join('\n'));
    throw e;
  } finally {
    await b.close();
    server?.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
