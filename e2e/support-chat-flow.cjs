/**
 * SampCrew Support chat end to end: the demo company's Super Workspace and the Console Admin team, in the real Web
 * Portal and Console.
 *
 *   pnpm build && pnpm db:reset        # demo workspace (CREW_SEED_DEMO=true)
 *   start the API, the Web Portal (:3000) and the Console (:3001)
 *   node e2e/support-chat-flow.cjs     # E2E_SHOTS=<dir> also saves screenshots
 *
 * 1. The owner (Super Workspace) opens SampCrew Support from the menu and starts a conversation.
 * 2. A Console Admin (a fresh Support role admin, enrolled in MFA here) sees it in the Support inbox with the menu
 *    badge, the Super Workspace's name and level, opens it and replies. The owner's message turns Read.
 * 3. The owner gets the reply without reloading, with "Console Admin" and the admin's name on it, and the notification.
 * 4. An employee (Employee Workspace) has no SampCrew Support in the menu and is refused on the page.
 * 5. The owner messages the employee in Chat: the employee sees "Super Workspace" and the company next to the name;
 *    the people picker shows level, workspace and email.
 * 6. The phone-width layout of the support page and the inbox.
 * Fails on any browser error.
 */
const path = require('node:path');
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));
const { hashPassword } = require(path.join(__dirname, '../apps/api/dist/platform/auth/crypto.js'));

const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const SHOTS = process.env.E2E_SHOTS;

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/EventSource|net::ERR_ABORTED/.test(m.text()) && errs.push(`${who} ${m.text()}`));
};
const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });

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

async function consoleSignIn(b, email, password, viewport = { width: 1440, height: 900 }) {
  const p = await (await b.newContext({ viewport, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  watch(p, email);
  await p.goto(`${CONSOLE}/login`);
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', password);
  await p.click('button[type=submit]');
  await p.waitForURL(/\/enrol$/);
  await p.click('text=Show QR code');
  const secret = (await p.locator('code').first().textContent()).trim();
  await p.fill('input[name=code]', authenticator.generate(secret));
  await p.click('text=Turn on and continue');
  await p.waitForURL(`${CONSOLE}/`);
  return p;
}

async function run(b, adminEmail, adminPassword, stamp) {
  let current;
  try {
    // 1. The Super Workspace starts a conversation with SampCrew Support from the menu.
    const owner = current = await signIn(b, 'owner@demo.crew.local');
    await owner.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^SampCrew Support/ }).click();
    await owner.waitForURL(/\/support/);
    const subject = `Attendance report shows zero (${stamp})`;
    const question = 'Please help me with employee attendance. The Monday report shows zero.';
    // With no conversations yet the page opens the new-conversation form by itself.
    let d = owner.locator('dialog[open]');
    if (!(await d.waitFor({ timeout: 4000 }).then(() => true, () => false))) await owner.getByRole('button', { name: 'New support conversation' }).click();
    await d.getByLabel('Subject').fill(subject);
    await d.getByLabel('Topic').selectOption('technical');
    await d.getByLabel('Your message').fill(question);
    await shot(owner, '01-super-new-support-conversation');
    await d.getByRole('button', { name: 'Send to Console Admin' }).click();
    await owner.waitForURL(/\/support\/[0-9a-f-]{36}$/);
    const supportUrl = owner.url();
    const mine = owner.getByTestId('message').filter({ hasText: question });
    await mine.getByTestId('message-sender').getByText('Super Workspace').waitFor();
    await mine.getByTestId('message-delivery').getByText(/Sent|Delivered/).waitFor();
    ok('Super Workspace opened SampCrew Support from the menu and sent a message');

    // 2. The Console Admin team sees it, with who wrote it, and replies.
    const admin = current = await consoleSignIn(b, adminEmail, adminPassword);
    const nav = admin.getByRole('navigation', { name: 'Console' });
    await nav.getByRole('link', { name: /Support inbox/ }).getByTestId('nav-badge').waitFor();
    await nav.getByRole('link', { name: /Support inbox/ }).click();
    await admin.waitForURL(/\/support$/);
    const row = admin.getByTestId('support-row').filter({ hasText: subject });
    await row.waitFor();
    if (!(await row.getByTestId('support-row-workspace').textContent())?.trim()) throw new Error('inbox row has no Super Workspace name');
    await row.getByTestId('support-row-unread').waitFor();
    await shot(admin, '04-console-support-inbox');
    await row.click();
    await admin.waitForURL(/\/support\/[0-9a-f-]{36}/);
    const theirs = admin.getByTestId('message').filter({ hasText: question });
    await theirs.getByTestId('message-sender').getByText('Aarav Mehta').waitFor();
    await theirs.getByTestId('message-sender').getByText('Super Workspace').waitFor();
    await admin.getByTestId('workspace-info').getByText('Aarav Mehta', { exact: true }).waitFor();
    ok('Console Admin sees the conversation in the inbox with the Super Workspace identity and the menu badge');

    // The owner's message turns Read once the admin opens it (without reloading).
    await mine.getByTestId('message-delivery').getByText('Read').waitFor({ timeout: 15000 });
    ok("the Super Workspace's message turned Read when the Console opened it");

    const answer = 'We have reviewed your concern: the Monday report is fixed. Please check again.';
    await admin.getByRole('textbox', { name: 'Reply' }).fill(answer);
    await admin.getByRole('button', { name: 'Send reply' }).click();
    const reply = admin.getByTestId('message').filter({ hasText: answer });
    await reply.getByTestId('message-sender').getByText('Console Admin').waitFor();
    await reply.getByTestId('message-delivery').getByText(/Sent|Delivered|Read/).waitFor();

    // 3. The owner sees the reply live, with the admin's name and level.
    current = owner;
    const got = owner.getByTestId('message').filter({ hasText: answer });
    await got.waitFor({ timeout: 15000 });
    await got.getByTestId('message-sender').getByText('Console Admin').waitFor();
    await got.getByTestId('message-sender').getByText('Sana Support').waitFor();
    await shot(owner, '02-super-support-conversation');
    await reply.getByTestId('message-delivery').getByText('Read').waitFor({ timeout: 15000 });
    await shot(admin, '05-console-support-conversation');
    ok('the reply arrived without reloading, signed Console Admin with the admin name; the admin sees Read');

    // The notification links to the conversation.
    await owner.goto(BASE + '/notifications');
    await owner.getByText(/\(Console Admin\) replied/).first().waitFor();
    ok('the Super Workspace was notified of the reply');

    // Resolve from the Console; the owner sees the note; the inbox filters it under Resolved.
    current = admin;
    await admin.getByRole('button', { name: 'Resolve' }).click();
    await admin.getByTestId('system-message').filter({ hasText: 'marked this conversation resolved' }).waitFor();
    await admin.goto(`${CONSOLE}/support?state=resolved`);
    await admin.getByTestId('support-row').filter({ hasText: subject }).waitFor();
    await admin.goto(`${CONSOLE}/support?q=${encodeURIComponent('Monday report')}`);
    await admin.getByTestId('support-row').filter({ hasText: subject }).waitFor();
    ok('Console resolved it; Resolved filter and message search find it');
    current = owner;
    await owner.goto(supportUrl);
    await owner.getByTestId('system-message').filter({ hasText: 'marked this conversation resolved' }).waitFor();

    // 4. An employee cannot reach SampCrew Support.
    const emp = current = await signIn(b, 'operator2@demo.crew.local');
    if (await emp.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^SampCrew Support/ }).count()) throw new Error('Employee Workspace sees SampCrew Support in the menu');
    await emp.goto(supportUrl);
    await emp.getByTestId('support-not-super').waitFor();
    if (await emp.getByText(question).count()) throw new Error('Employee Workspace can read the support conversation');
    await shot(emp, '06-employee-refused');
    ok('Employee Workspace has no SampCrew Support and cannot open the conversation');

    // 5. The owner messages the employee in Chat; the employee sees who wrote.
    current = owner;
    await owner.goto(BASE + '/communication/chat');
    await owner.getByTestId('support-entry').waitFor();
    await owner.getByRole('button', { name: 'New conversation' }).first().click();
    d = owner.locator('dialog[open]');
    await d.getByLabel('Find people').fill('operator2@demo');
    const person = d.getByTestId('people-picker').getByRole('button').filter({ hasText: 'Neha Deshmukh' });
    await person.getByText('Employee Workspace').waitFor();
    await person.getByTestId('person-identity').getByText('operator2@demo.crew.local', { exact: false }).waitFor();
    await shot(owner, '07-new-conversation-recipient-identity');
    await person.click();
    await owner.waitForURL(/\/communication\/chat\/[0-9a-f-]{36}$/);
    const hello = `Hello, I wanted to discuss your attendance record (${stamp}).`;
    await owner.getByPlaceholder(/Write a message/).fill(hello);
    await owner.getByRole('button', { name: 'Send' }).click();
    await owner.getByTestId('message').filter({ hasText: hello }).waitFor();
    current = emp;
    await emp.goto(BASE + '/communication/chat');
    const conv = emp.getByTestId('conversation-item').filter({ hasText: 'Aarav Mehta' });
    await conv.getByTestId('conversation-identity').getByText('Super Workspace', { exact: false }).waitFor();
    await conv.click();
    const msg = emp.getByTestId('message').filter({ hasText: hello });
    await msg.getByTestId('message-sender').getByText('Super Workspace').waitFor();
    await msg.getByTestId('message-sender').getByText('Aarav Mehta').waitFor();
    await shot(emp, '08-employee-sees-sender-identity');
    ok('the employee sees the sender name, Super Workspace level and company on the message and in the list');

    // 6. Phone width.
    const phone = current = await signIn(b, 'owner@demo.crew.local', { width: 390, height: 844 });
    await phone.goto(supportUrl);
    await phone.getByTestId('support-thread').waitFor();
    await shot(phone, '03-super-support-phone');
    const adminPhone = current = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1, storageState: await admin.context().storageState() })).newPage();
    watch(adminPhone, 'admin phone');
    await adminPhone.goto(`${CONSOLE}/support`);
    await adminPhone.getByTestId('support-inbox').waitFor();
    await shot(adminPhone, '09-console-inbox-phone');
    ok('support page and inbox work at phone width');
  } catch (e) {
    if (current) await current.screenshot({ path: '/tmp/support-chat-failure.png', fullPage: true }).catch(() => {});
    throw e;
  }
}

(async () => {
  const stamp = Date.now();
  const b = await chromium.launch();
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const users = mongo.db().collection('users');
  const ownerBefore = await users.findOne({ email: 'owner@demo.crew.local' });
  if (!ownerBefore) throw new Error('demo owner missing: run pnpm db:reset with CREW_SEED_DEMO=true');
  await users.updateOne({ _id: ownerBefore._id }, { $set: { mfa_enabled: false, mfa_secret_enc: null } });
  // A fresh Console Admin on the Support role (the role meant for answering customers).
  const adminEmail = `support.${stamp}@sampledge.test`;
  const adminPassword = `E2e-Support-${stamp}!`;
  const now = new Date();
  await mongo.db().collection('platform_admins').insertOne({
    _id: require('node:crypto').randomUUID(), email: adminEmail, full_name: 'Sana Support', password_hash: await hashPassword(adminPassword), role: 'support',
    status: 'active', mfa_enabled: false, must_change_password: false, failed_login_count: 0, created_at: now, updated_at: now,
  });
  try {
    await run(b, adminEmail, adminPassword, stamp);
  } finally {
    await users.updateOne({ _id: ownerBefore._id }, { $set: { mfa_enabled: ownerBefore.mfa_enabled ?? false, mfa_secret_enc: ownerBefore.mfa_secret_enc ?? null } });
    await mongo.db().collection('platform_admins').updateOne({ email: adminEmail }, { $set: { status: 'disabled' } });
    await mongo.close();
    await b.close();
  }
  if (errs.length) throw new Error('browser errors:\n' + errs.join('\n'));
  console.log('support chat flow: all checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
