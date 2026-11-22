/**
 * Document management, verification and approval, end to end in a real browser against the demo workspace.
 *
 *   pnpm db:reset
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/document-flow.cjs
 *
 * 1. Super Workspace (the owner) opens Centralized Document Management and requests an Aadhaar Card from Neha.
 * 2. Neha (Employee Workspace) sees it under My document requests and in My tasks, and uploads a PDF.
 * 3. Super Workspace previews it and asks for a correction (a comment is required).
 * 4. Neha uploads version 2; Super Workspace rejects it (a reason is required) and Neha sees the reason highlighted.
 * 5. Neha uploads version 3; Super Workspace approves it with a comment, which Neha sees. All versions are kept.
 * 6. Super Workspace switches downloads off for company-wide HR in Document Access Management; HR Workspace then sees
 *    the document without a Download link, and the direct file link is refused. The switch is put back at the end.
 * Fails on any browser error. SHOTS=<dir> saves a screenshot of each screen.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));
const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  // The refused direct file link in step 5 is expected to log a failed request.
  p.on('console', (m) => m.type() === 'error' && !/status of (403|404)/.test(m.text()) && errs.push(`${who} ${m.text()}`));
};
const SHOTS = process.env.SHOTS;
const save = async (p, name) => {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' });
};
const fail = async (p, e) => {
  await p.screenshot({ path: process.env.SHOT ?? '/tmp/document-flow-fail.png', fullPage: true }).catch(() => {});
  throw e;
};
const see = (p, text, timeout = 15000) => p.getByText(text).first().waitFor({ timeout }).catch((e) => fail(p, e));

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const p = await ctx.newPage();
  watch(p, email);
  // Sign-in is rate limited (10 a minute). After the other flows in CI, wait for the window instead of failing.
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

const pdf = (name, note) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doc-')), name);
  fs.writeFileSync(file, `%PDF-1.4\n% ${note}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
  return file;
};

async function upload(p, file) {
  await p.getByTestId('request-file').setInputFiles(file);
  await p.getByRole('button', { name: 'Submit for verification' }).click();
  await see(p, 'Submitted. It is now waiting for verification.');
}

async function setDownload(owner, on) {
  await owner.goto(BASE + '/settings/document-access');
  await see(owner, 'Document Access Management');
  const box = owner.getByTestId('access-download');
  if ((await box.isChecked()) !== on) await box.click();
  await owner.getByTestId('access-save').click();
  await see(owner, 'Saved. The change applies straight away');
}

(async () => {
  const mongo = await MongoClient.connect(MONGODB_URL);
  const neha = await mongo.db().collection('employees').findOne({ first_name: 'Neha', last_name: 'Deshmukh' });
  if (!neha) throw new Error('Run pnpm db:reset first: Neha is missing from the demo workspace');
  const b = await chromium.launch();
  try {
    // 1. Super Workspace asks Neha for her Aadhaar Card.
    const owner = await signIn(b, 'owner@demo.crew.local');
    await owner.goto(BASE + '/documents');
    await see(owner, 'Centralized Document Management');
    await see(owner, 'Waiting for your verification');
    await save(owner, '01-super-overview');
    await owner.getByRole('button', { name: 'Request document' }).click();
    const dialog = owner.getByRole('dialog');
    await dialog.getByPlaceholder('Search by name or code').fill('Neha');
    await dialog.getByLabel(/Neha Deshmukh/).check();
    await dialog.getByLabel('Document type').selectOption('aadhaar');
    await dialog.getByLabel('Reason').fill('Identity proof for statutory records');
    await dialog.getByLabel('Instructions').fill('Both sides in one PDF');
    await save(owner, '02-request-form');
    await dialog.getByRole('button', { name: 'Send request' }).click();
    await owner.waitForURL(/\/documents\/requests\/[0-9a-f-]{36}$/, { timeout: 15000 }).catch((e) => fail(owner, e));
    const requestUrl = owner.url();
    await see(owner, 'Requested by');
    await see(owner, 'Super Workspace');
    ok('Super Workspace requested an Aadhaar Card from Neha');

    // 2. Neha sees it in Documents and My tasks, and uploads it.
    const emp = await signIn(b, 'operator2@demo.crew.local');
    await emp.goto(BASE + '/tasks?tab=hr');
    await see(emp, 'Aadhaar Card');
    await emp.goto(BASE + '/documents');
    await see(emp, 'My document requests');
    await save(emp, '03-employee-requests');
    await emp.getByRole('link', { name: 'Aadhaar Card' }).first().click();
    await emp.waitForURL(/\/documents\/requests\//);
    await see(emp, 'Upload the document');
    await save(emp, '04-employee-upload');
    await upload(emp, pdf('aadhaar.pdf', 'first scan'));
    ok('Neha found the request in Documents and My tasks and uploaded the file');

    // 3. Super Workspace previews it and sends it back for a correction.
    await owner.goto(BASE + '/documents?tab=verify');
    await see(owner, 'Pending verification');
    await owner.getByRole('link', { name: 'Aadhaar Card' }).first().click();
    await owner.waitForURL(/\/documents\/requests\//);
    await see(owner, 'Under verification');
    await owner.getByRole('button', { name: 'Show preview' }).click();
    await owner.locator('iframe[title^="Preview of"]').waitFor({ timeout: 10000 }).catch((e) => fail(owner, e));
    await save(owner, '05-verify');
    await owner.getByRole('button', { name: 'Request correction' }).click();
    const confirm = owner.getByRole('dialog');
    if (!(await confirm.getByRole('button', { name: 'Send back' }).isDisabled())) throw new Error('A correction needs a comment');
    await confirm.getByLabel(/What must be corrected/).fill('The back side is missing. Upload both sides in one PDF.');
    await confirm.getByRole('button', { name: 'Send back' }).click();
    await see(owner, 'Sent back for correction');
    ok('Super Workspace previewed the file and asked for a correction with a comment');

    // 4. Neha uploads version 2; Super Workspace rejects it, which needs a reason, and Neha sees the reason highlighted.
    await emp.goto(requestUrl);
    await see(emp, 'The back side is missing');
    await see(emp, 'Upload a new version');
    await upload(emp, pdf('aadhaar-both-sides.pdf', 'both sides, blurred'));
    await owner.goto(requestUrl);
    await see(owner, 'Version 2 of 2');
    await owner.getByRole('button', { name: 'Reject' }).first().click();
    const rejectDialog = owner.getByRole('dialog');
    if (!(await rejectDialog.getByRole('button', { name: 'Reject' }).isDisabled())) throw new Error('A rejection needs a reason');
    await rejectDialog.getByTestId('decision-comment').fill('The scan is blurred and the number cannot be read. Please scan it again.');
    await save(owner, '06-reject-with-reason');
    await rejectDialog.getByRole('button', { name: 'Reject' }).click();
    await see(owner, 'Rejected. They have been told the reason');
    await emp.goto(requestUrl);
    await see(emp, 'Rejected by Aarav Mehta: reason');
    await see(emp, 'The scan is blurred and the number cannot be read');
    await save(emp, '07-employee-sees-reason');
    await emp.goto(BASE + '/documents?tab=rejected');
    await see(emp, 'Reason:');
    await see(emp, 'The scan is blurred');
    await save(emp, '08-employee-rejected-list');
    ok('Super Workspace rejected version 2 with a reason (required), and Neha sees the reason on the request and in her list');

    // 5. Neha uploads version 3; Super Workspace approves it with a comment, which Neha sees.
    await emp.goto(requestUrl);
    await upload(emp, pdf('aadhaar-rescan.pdf', 'clear rescan'));
    await owner.goto(requestUrl);
    await see(owner, 'Version 3 of 3');
    await owner.getByRole('button', { name: 'Approve' }).first().click();
    const approveDialog = owner.getByRole('dialog');
    await approveDialog.getByTestId('decision-comment').fill('Clear scan, thank you. Verified against the employee record.');
    await save(owner, '09-approve-with-comment');
    await approveDialog.getByRole('button', { name: 'Approve' }).click();
    await see(owner, 'Approved. The document is now in the profile');
    await see(owner, 'Completed');
    await save(owner, '10-approved-request');
    await owner.getByRole('link', { name: 'Document page' }).click();
    await owner.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
    const docId = owner.url().split('/').pop();
    await see(owner, 'Versions');
    await see(owner, 'Comment on approval from Aarav Mehta');
    await save(owner, '11-document');
    await emp.goto(requestUrl);
    await see(emp, 'Approved. Comment from Aarav Mehta');
    await see(emp, 'Clear scan, thank you');
    await save(emp, '12-employee-sees-approval-comment');
    await emp.goto(BASE + '/documents?tab=approved');
    await see(emp, 'Comment:');
    ok('Neha uploaded version 3 and Super Workspace approved it with a comment she can read; all versions and the history are kept');

    // 6. Super Workspace switches downloads off for company-wide HR; HR loses the Download link and the direct link.
    await setDownload(owner, false);
    await save(owner, '13-document-access');
    const hr = await signIn(b, 'hr.admin@demo.crew.local');
    await hr.goto(`${BASE}/employees/${neha._id}?tab=documents`);
    await see(hr, 'Aadhaar Card');
    const row = hr.getByRole('row', { name: /Aadhaar Card/ }).first();
    await row.getByRole('link', { name: 'Preview' }).waitFor({ timeout: 10000 }).catch((e) => fail(hr, e));
    if (await row.getByRole('link', { name: 'Download' }).count()) throw new Error('HR still sees Download after Super Workspace switched it off');
    const direct = await hr.request.get(`${BASE}/files/${docId}`);
    if (direct.status() !== 404) throw new Error(`the direct file link answered ${direct.status()} instead of 404`);
    await save(hr, '14-hr-profile-no-download');
    await hr.goto(BASE + '/documents');
    await see(hr, 'Documents');
    await save(hr, '15-hr-documents');
    ok('with downloads off, HR Workspace sees no Download link and the direct file link is refused');
    await setDownload(owner, true);
    const again = await hr.request.get(`${BASE}/files/${docId}`);
    if (again.status() !== 200) throw new Error(`after switching downloads back on the file answered ${again.status()}`);
    ok('switching downloads back on gives HR Workspace the file again');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    ok('document flow passed');
  } finally {
    await b.close();
    await mongo.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
