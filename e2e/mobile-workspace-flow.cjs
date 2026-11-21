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
 * 3. She acknowledges the policy, photographs the document and uploads it with a remark (and a PDF for a PDF-only task); HR verifies it and the
 *    task is completed.
 * 4. She scores every question, writes her answers, saves a draft and submits; the appraisal moves to her manager.
 * 5. She asks to change her mobile number; it waits for HR, HR approves it and her profile shows the new number.
 * 6. She changes her address, bank account and skills; HR approves each and the account number shows masked.
 * 7. Her manager evaluates the appraisal on the phone; HR sets an approved percentage, finalises and shares it; she
 *    sees the result.
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
    await api(hr, 'POST', '/tasks', { category: 'hr', kind: 'document', title: `Upload your signed offer letter ${run}`, priority: 'normal', dueOn: soon(4), employeeIds: [neha.id], document: { formats: ['pdf'], maxMb: 2 } });
    const form = await api(hr, 'POST', '/appraisals/forms/from-template', { key: 'frequent_research' });
    const flat = (l) => l.flatMap((d) => [d, ...flat(d.children ?? [])]);
    const dept = flat(await api(hr, 'GET', '/org/departments')).find((d) => d.name.toLowerCase().includes('assembly'));
    const cycle = await api(hr, 'POST', '/appraisals/cycles', { name: `Mobile appraisal ${run}`, formId: form.id, periodStart: '2026-01-01', periodEnd: '2026-12-31', selfDue: soon(10), managerDue: soon(20), hrDue: soon(30), departmentIds: [dept.id] });
    await api(hr, 'POST', `/appraisals/cycles/${cycle.id}/launch`);
    ok('HR assigns three tasks and launches an appraisal cycle');

    // 2. Home.
    await signIn(p, 'operator2@demo.crew.local');
    await p.getByTestId('home-workspace').waitFor();
    assert(/open task/.test(await p.getByTestId('home-tasks').innerText()), 'home lists open tasks');
    assert((await p.getByTestId('home-appraisal').count()) >= 1, 'home shows the self-appraisal waiting');
    ok('Home shows open tasks and the self-appraisal waiting');

    // 3. Tasks.
    await p.getByTestId('home-tasks').click();
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

    // A PDF-only task: no photo buttons, the file picker only takes the formats the task accepts.
    await p.goBack();
    await p.getByTestId('tasks-list').getByText(`Upload your signed offer letter ${run}`).click();
    await p.getByTestId('task-document').waitFor();
    assert((await p.getByTestId('doc-library').count()) === 0, 'a PDF-only task offers no photo picker');
    let fc = p.waitForEvent('filechooser');
    await p.getByTestId('doc-file').click();
    await (await fc).setFiles({ name: 'offer.png', mimeType: 'image/png', buffer: PNG });
    await p.getByTestId('task-message').getByText(/accepts PDF files/).waitFor();
    fc = p.waitForEvent('filechooser');
    await p.getByTestId('doc-file').click();
    await (await fc).setFiles({ name: 'offer-letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% signed offer letter for the mobile flow\n') });
    await p.getByTestId('doc-picked').getByText('Ready to send: offer-letter.pdf').waitFor();
    await p.getByTestId('doc-upload').click();
    await p.getByText('Uploaded. HR will verify it and you will be notified.').waitFor();
    const pdfTask = (await api(hr, 'GET', '/tasks?scope=assigned&category=hr&status=all')).find((t) => t.title === `Upload your signed offer letter ${run}`);
    assert(pdfTask.status === 'pending_review' && pdfTask.document?.fileName === 'offer-letter.pdf', `PDF uploaded (${pdfTask.status}, ${pdfTask.document?.fileName})`);
    ok('uploads a PDF from the phone\'s files for a PDF-only task (a picture is refused first)');

    // 4. Appraisal.
    await p.goto(APP + '/appraisal');
    await p.getByTestId('appraisal-current').waitFor();
    await p.getByTestId('appraisal-list').getByText(`Mobile appraisal ${run}`).click();
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
    const mobile = `98220${String(Date.now()).slice(-5)}`;
    await p.getByLabel('Mobile number').fill(`+91 ${mobile}`);
    await p.getByTestId('send-personal').click();
    await p.getByText('Sent to HR. Your profile changes once HR approves it.').waitFor();
    await p.getByText('Waiting for HR').first().waitFor();
    const pending = (await api(hr, 'GET', '/profile/updates')).find((u) => u.employee.name.startsWith('Neha') && u.section === 'personal');
    await api(hr, 'POST', `/profile/updates/${pending.id}/decide`, { decision: 'approve' });
    await p.reload();
    await p.getByTestId('profile-personal').getByText(new RegExp(mobile.slice(-5))).waitFor();
    ok('asks to change the mobile number; HR approves and the profile shows it');

    // 6. Address, bank account (typed twice, shown masked) and skills, each approved by HR.
    const city = `Pune ${run}`;
    await p.getByTestId('edit-address').click();
    await p.getByLabel('Address line 1').fill('14 Lake View Road');
    await p.getByLabel('City').fill(city);
    await p.getByLabel('State').fill('Maharashtra');
    await p.getByLabel('Postal code').fill('411001');
    await p.getByLabel('Country').fill('India');
    await p.getByTestId('send-address').click();
    await p.getByText('Sent to HR. Your profile changes once HR approves it.').waitFor();
    const account = `5010${String(Date.now()).slice(-8)}`;
    await p.getByTestId('edit-bank').click();
    await p.getByLabel('Bank name').fill('HDFC Bank');
    await p.getByLabel('Account number', { exact: true }).fill(account);
    await p.getByLabel('Account number again').fill(`${account.slice(0, -1)}0`);
    await p.getByLabel('IFSC').fill('HDFC0000123');
    await p.getByTestId('send-bank').click();
    await p.getByText('The two account numbers do not match. Type them again.').waitFor();
    await p.getByLabel('Account number again').fill(account);
    await p.getByTestId('send-bank').click();
    await p.getByText('Sent to HR. Your profile changes once HR approves it.').waitFor();
    await p.getByTestId('edit-skills').click();
    await p.getByLabel('Skills').fill('Line balancing, Kaizen, Line balancing');
    await p.getByLabel('Languages').fill('Marathi, Hindi, English');
    await p.getByTestId('send-skills').click();
    await p.getByText('Sent to HR. Your profile changes once HR approves it.').waitFor();
    const updates = (await api(hr, 'GET', '/profile/updates')).filter((u) => u.employee.name.startsWith('Neha') && u.status === 'pending');
    for (const section of ['address', 'bank', 'skills']) {
      const u = updates.find((x) => x.section === section);
      assert(u, `the ${section} update waits for HR`);
      await api(hr, 'POST', `/profile/updates/${u.id}/decide`, { decision: 'approve' });
    }
    await p.reload();
    await p.getByTestId('profile-address').getByText(new RegExp(city)).waitFor();
    const bankText = await p.getByTestId('profile-bank').innerText();
    assert(bankText.includes(account.slice(-4)) && !bankText.includes(account), 'the new account shows masked');
    await p.getByTestId('profile-skills').getByText('Line balancing, Kaizen').waitFor();
    ok('changes address, bank account (typed twice, shown masked) and skills; HR approves each');

    // 7. Her manager evaluates on the phone, HR finalises and shares it on the phone, and she sees the result.
    // SHOTS_DIR=<folder> also saves screenshots of the review screens (for PRs and docs).
    const snap = (q, name, full = false) => (process.env.SHOTS_DIR ? q.screenshot({ path: `${process.env.SHOTS_DIR}/${name}.png`, fullPage: full }) : null);
    const phone = async (email) => {
      const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: process.env.SHOTS_DIR ? 2 : 1 });
      const q = await c.newPage();
      q.on('pageerror', (e) => errs.push(`${email} PAGEERROR ${e.message}`));
      await signIn(q, email);
      return q;
    };
    const mgr = await phone('supervisor@demo.crew.local');
    await mgr.goto(APP + '/appraisal');
    const teamCard = mgr.getByTestId('appraisal-team');
    await teamCard.waitFor();
    await snap(mgr, 'phone-manager-appraisals');
    await teamCard.getByText(new RegExp(`Mobile appraisal ${run}`)).first().click();
    await mgr.getByTestId('appraisal-actions').waitFor();
    await mgr.getByText(/Employee: 4/).first().waitFor();
    const mRadios = mgr.getByRole('radio', { name: '3', exact: true });
    const mn = await mRadios.count();
    assert(mn >= 5, `manager score choices shown (${mn})`);
    for (let i = 0; i < mn; i++) await mRadios.nth(i).click();
    for (const box of await mgr.locator('textarea').all()) if (!(await box.inputValue())) await box.fill('Reliable on line 2; next year, lead the changeover training.');
    await mgr.getByText('Every required question is answered.').waitFor();
    await snap(mgr, 'phone-manager-evaluation');
    await mgr.getByTestId('appraisal-submit').click();
    await mgr.getByText('Evaluation submitted. HR has been told.').waitFor();
    ok('her manager scores each question next to her own scores and submits the evaluation on the phone');

    const hrp = await phone('hr.admin@demo.crew.local');
    await hrp.goto(APP + '/appraisal');
    const hrCard = hrp.getByTestId('appraisal-hr');
    await hrCard.waitFor();
    await snap(hrp, 'phone-hr-appraisals');
    await hrCard.getByText('Neha Deshmukh').first().click();
    await hrp.getByTestId('appraisal-final-percent').waitFor();
    await hrp.getByText(/Manager: 3/).first().waitFor();
    await hrp.getByLabel('Approved %').fill('72');
    await hrp.getByTestId('appraisal-save').click();
    await hrp.getByText('Say why the approved percentage differs from the calculated one.').waitFor();
    await hrp.getByLabel('Reason for the change').fill('Calibrated with the Assembly line results');
    await hrp.getByTestId('appraisal-final-percent').scrollIntoViewIfNeeded();
    await snap(hrp, 'phone-hr-final-percent', false);
    for (const box of await hrp.locator('textarea').all()) if (!(await box.inputValue())) await box.fill('Agreed with the manager.');
    await hrp.getByTestId('appraisal-submit').click();
    await hrp.getByText('Finalised. Share the result when you are ready.').waitFor();
    await hrp.getByTestId('appraisal-share').click();
    await hrp.getByText('Result shared. The employee has been told.').waitFor();
    await snap(hrp, 'phone-hr-shared', false);
    ok('HR records an approved 72% with a reason, finalises and shares the result on the phone');

    await p.goto(APP + '/appraisal');
    await p.getByTestId('appraisal-list').getByText(`Mobile appraisal ${run}`).click();
    await p.getByTestId('appraisal-result').waitFor();
    assert((await p.getByTestId('appraisal-final').innerText()).includes('72%'), 'she sees the approved 72%');
    ok('she sees her shared result, 72%');

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
