/**
 * Help & Support end to end, in the real Web Portal and Console, on the demo company.
 *
 *   pnpm build && pnpm db:reset        # demo workspace (CREW_SEED_DEMO=true)
 *   start the API, the Web Portal (:3000) and the Console (:3001)
 *   node e2e/help-centre-flow.cjs      # E2E_SHOTS=<dir> also saves screenshots
 *
 * 1. An Employee Workspace member opens Help & Support from the menu: Employee content only, searches, opens a guide,
 *    ticks a step (saved) and votes helpful.
 * 2. They raise a query (category, subject, description, page, an attachment, contact details from the account) and
 *    get a ticket ID.
 * 3. The HR Workspace gets it in the Queries inbox, assigns it to themselves, adds an internal note and replies
 *    (Awaiting User Response).
 * 4. The employee sees the reply (not the note), replies back (In Progress); HR resolves it; the employee rates it,
 *    reopens it and closes it.
 * 5. The Super Workspace sees Super Workspace content and raises a billing query, which goes to SampCrew Support.
 * 6. A Console Admin sees it in Help queries (with the menu badge), assigns it, replies; the Super Workspace sees the
 *    reply signed SampCrew Support.
 * 7. The Console's Help content: a new FAQ for Employee Workspace is published (the employee finds it), then
 *    unpublished (the employee no longer can).
 * 8. Phone width: the help home and a query.
 * Fails on any browser error.
 */
const path = require('node:path');
const { chromium } = require('playwright');
require('./delete-password.cjs');
const { authenticator } = require('otplib');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));
const { hashPassword } = require(path.join(__dirname, '../apps/api/dist/platform/auth/crypto.js'));

const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const SHOTS = process.env.E2E_SHOTS;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

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

async function consoleSignIn(b, email, password) {
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
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
    // 1. Employee Workspace: Help & Support from the menu, own level's content only.
    const emp = current = await signIn(b, 'operator2@demo.crew.local');
    await emp.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Help & Support/ }).click();
    await emp.waitForURL(/\/help$/);
    const home = emp.getByTestId('help-home');
    await home.waitFor();
    assert((await home.getAttribute('data-level')) === 'employee', 'employee help home is not the Employee Workspace level');
    await emp.getByTestId('help-hero').getByText('Employee Workspace').waitFor();
    for (const id of ['quick-guides', 'quick-faqs', 'quick-tutorials', 'quick-raise']) await emp.getByTestId(id).waitFor();
    assert((await emp.getByTestId('quick-inbox').count()) === 0, 'an Employee Workspace sees the queries inbox');
    assert((await emp.getByTestId('help-quickstart').count()) === 1, 'the employee should see one quick start (their own)');
    assert((await emp.getByTestId('help-category').count()) >= 6, 'too few help categories for the employee');
    await emp.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Help & Support/ }).first().waitFor();
    await shot(emp, '01-employee-help-home');
    await shot(emp, '01b-employee-help-home-full', true);
    // Super Workspace content is not reachable.
    await emp.goto(`${BASE}/help/articles/quickstart-super`);
    await emp.getByText(/not found|could not be found|doesn.t exist/i).first().waitFor();
    ok('Employee Workspace opens Help & Support from the menu and sees only its own level');

    // Search and an article with steps.
    await emp.goto(`${BASE}/help`);
    await emp.getByTestId('help-search').getByLabel('Search help').fill('apply leave');
    await emp.getByTestId('help-search').getByRole('button', { name: 'Search' }).click();
    await emp.waitForURL(/\/help\/search\?q=apply/);
    await emp.getByTestId('help-search-results').getByTestId('help-article-title').filter({ hasText: 'Apply for leave' }).first().click();
    await emp.waitForURL(/\/help\/articles\/how-to-apply-leave$/);
    await emp.getByTestId('help-steps').waitFor();
    const step = emp.getByTestId('help-step').first();
    // Progress is saved per person: on a rerun the step may already be done, so start from not done.
    if ((await step.getAttribute('data-done')) === 'true') {
      await step.getByTestId('help-step-toggle').click();
      await emp.getByTestId('help-progress').getByText(/^\s*0 of \d+ done/).waitFor();
    }
    await step.getByTestId('help-step-toggle').click();
    await emp.getByTestId('help-progress').getByText(/1 of \d+ done/).waitFor();
    await emp.getByTestId('help-helpful-yes').click();
    await emp.getByTestId('help-feedback-thanks').waitFor();
    await emp.waitForTimeout(600);
    await emp.reload();
    await emp.getByTestId('help-step').first().and(emp.locator('[data-done=true]')).waitFor();
    await shot(emp, '02-employee-help-article-steps');
    ok('search finds the guide; a ticked step and the helpful vote are saved');

    // 2. Raise a Query from the article.
    await emp.getByTestId('help-raise-link').first().click();
    await emp.waitForURL(/\/help\/queries\/new/);
    await emp.getByTestId('raise-query').waitFor();
    await emp.getByTestId('contact-name').getByText('Neha Deshmukh').waitFor();
    await emp.getByTestId('contact-email').getByText('operator2@demo.crew.local').waitFor();
    // Validation first.
    await emp.getByTestId('query-submit').click();
    await emp.getByText('Choose a category, or Other').waitFor();
    await emp.getByTestId('query-category-leave').click();
    const subject = `Leave balance looks wrong (${stamp})`;
    await emp.getByTestId('query-subject-input').fill(subject);
    await emp.getByTestId('query-description-input').fill('My casual leave balance shows 0 days although I have not taken any leave this year.');
    assert((await emp.getByTestId('query-page-input').inputValue()) === '/leave', 'the page was not filled in from the article');
    await emp.getByTestId('query-file-input').setInputFiles({ name: 'balance.png', mimeType: 'image/png', buffer: PNG });
    await emp.getByTestId('query-attached').filter({ hasText: 'balance.png' }).waitFor();
    await shot(emp, '03-employee-raise-query');
    await emp.getByTestId('query-submit').click();
    const conf = emp.getByTestId('query-confirmation');
    await conf.waitFor();
    const ticket = (await conf.getByTestId('query-ticket-id').textContent()).trim();
    assert(/^HQ-\d{5}$/.test(ticket), `unexpected ticket ID ${ticket}`);
    await shot(emp, '04-employee-query-confirmation');
    await conf.getByTestId('query-open').click();
    await emp.waitForURL(/\/help\/queries\/[0-9a-f-]{36}$/);
    const empQueryUrl = emp.url();
    const queryId = empQueryUrl.split('/').pop();
    assert((await emp.getByTestId('query-detail').getAttribute('data-status')) === 'open', 'a new query is not Open');
    await emp.getByTestId('query-file').filter({ hasText: 'balance.png' }).waitFor();
    ok(`raised ${ticket} with an attachment and contact details from the account`);

    // 3. The HR Workspace answers it.
    const hr = current = await signIn(b, 'hr.admin@demo.crew.local');
    await hr.goto(`${BASE}/help`);
    await hr.getByTestId('quick-inbox').click();
    await hr.waitForURL(/\/help\/inbox$/);
    const row = hr.getByTestId('query-row').filter({ hasText: ticket });
    await row.waitFor();
    await row.getByText('Neha Deshmukh').waitFor();
    await shot(hr, '05-hr-queries-inbox');
    await row.click();
    await hr.waitForURL(new RegExp(`/help/inbox/${queryId}$`));
    await hr.getByTestId('query-description').getByText('casual leave balance').waitFor();
    // The attachment downloads through the portal.
    const fileHref = await hr.getByTestId('query-file').first().getAttribute('href');
    const file = await hr.request.get(BASE + fileHref);
    assert(file.ok() && (await file.body()).length === PNG.length, 'the HR Workspace could not download the attachment');
    await hr.getByTestId('query-assignee-select').selectOption({ label: 'Priya Nair' });
    await hr.getByText('Assignment saved.').waitFor();
    await hr.getByTestId('query-internal').check();
    await hr.getByTestId('query-reply-input').fill('Checking the casual leave allocation for Assembly.');
    await hr.getByTestId('query-reply-send').click();
    await hr.getByTestId('query-note').filter({ hasText: 'Checking the casual leave' }).waitFor();
    const answer = 'Your casual leave allocation was missing. It is credited now: please check your balance.';
    await hr.getByTestId('query-reply-input').fill(answer);
    await hr.getByTestId('query-reply-send').click();
    await hr.getByTestId('query-message').filter({ hasText: answer }).waitFor();
    await hr.locator('[data-testid=query-detail][data-status=awaiting_user]').waitFor();
    await shot(hr, '06-hr-answer-query');
    ok('HR Workspace sees it in the inbox, opens the attachment, assigns it, adds a note and replies (Awaiting User Response)');

    // 4. The employee sees the reply (not the note) and replies back.
    current = emp;
    await emp.goto(`${BASE}/help/queries`);
    await emp.getByTestId('query-row').filter({ hasText: ticket }).getByTestId('query-unread').waitFor();
    await emp.goto(empQueryUrl);
    await emp.getByTestId('query-message').filter({ hasText: answer }).waitFor();
    assert((await emp.getByText('Checking the casual leave').count()) === 0, 'the employee can read the internal note');
    await emp.getByTestId('query-reply-input').fill('Thanks, I can see 8 days now.');
    await emp.getByTestId('query-reply-send').click();
    await emp.locator('[data-testid=query-detail][data-status=in_progress]').waitFor();
    await shot(emp, '07-employee-query-conversation');
    await emp.goto(BASE + '/notifications');
    await emp.getByText(new RegExp(`${ticket}`)).first().waitFor();
    ok('the employee is notified, reads the reply (not the internal note) and replies back (In Progress)');

    current = hr;
    await hr.reload();
    await hr.getByTestId('query-status-select').selectOption('resolved');
    await hr.locator('[data-testid=query-detail][data-status=resolved]').waitFor();
    current = emp;
    await emp.goto(empQueryUrl);
    await emp.getByTestId('query-star-5').click();
    await emp.getByTestId('query-rate-send').click();
    await emp.getByText('Thanks for your rating.').waitFor();
    await emp.getByTestId('query-reopen').click();
    // Reopened, and back with the person it is assigned to.
    await emp.locator('[data-testid=query-detail][data-status=in_progress]').waitFor();
    await emp.getByTestId('query-close').click();
    await emp.locator('[data-testid=query-detail][data-status=closed]').waitFor();
    ok('HR resolves it; the employee rates it, reopens it and closes it');

    // 5. The Super Workspace: its own content, and a billing query that goes to SampCrew Support.
    const owner = current = await signIn(b, 'owner@demo.crew.local');
    await owner.goto(`${BASE}/help`);
    assert((await owner.getByTestId('help-home').getAttribute('data-level')) === 'super', 'owner help home is not Super Workspace');
    assert((await owner.getByTestId('help-quickstart').count()) === 3, 'the Super Workspace should see three quick starts');
    await owner.getByTestId('quick-inbox').waitFor();
    await shot(owner, '08-super-help-home');
    await owner.goto(`${BASE}/help/queries/new`);
    await owner.getByTestId('query-category-billing').click();
    await owner.getByText('This category goes straight to the SampCrew Support team.').waitFor();
    const billing = `Invoice shows the wrong GST number (${stamp})`;
    await owner.getByTestId('query-subject-input').fill(billing);
    await owner.getByTestId('query-description-input').fill('Our October invoice has an old GSTIN. Please correct it and resend.');
    await owner.getByTestId('query-submit').click();
    await owner.getByTestId('query-confirmation').getByText(/SampCrew Support/).waitFor();
    const billingTicket = (await owner.getByTestId('query-ticket-id').textContent()).trim();
    await owner.getByTestId('query-open').click();
    await owner.waitForURL(/\/help\/queries\/[0-9a-f-]{36}$/);
    const ownerQueryUrl = owner.url();
    ok(`Super Workspace sees its own content and raised ${billingTicket}, sent to SampCrew Support`);

    // 6. The Console Admin team answers.
    const admin = current = await consoleSignIn(b, adminEmail, adminPassword);
    const nav = admin.getByRole('navigation', { name: 'Console' });
    await nav.getByRole('link', { name: /Help queries/ }).getByTestId('nav-badge').waitFor();
    await nav.getByRole('link', { name: /^Help & Support/ }).click();
    await admin.waitForURL(/\/help$/);
    assert((await admin.getByTestId('help-home').getAttribute('data-level')) === 'console', 'the Console help is not the Console Admin level');
    await shot(admin, '09-console-help-home');
    await nav.getByRole('link', { name: /Help queries/ }).click();
    await admin.waitForURL(/\/help-queries$/);
    const crow = admin.getByTestId('query-row').filter({ hasText: billingTicket });
    await crow.waitFor();
    assert((await admin.getByTestId('query-row').filter({ hasText: ticket }).count()) === 0, 'an HR Workspace query reached the Console');
    await shot(admin, '10-console-help-queries');
    await crow.click();
    await admin.waitForURL(/\/help-queries\/[0-9a-f-]{36}$/);
    await admin.getByTestId('query-assignee-select').selectOption({ label: 'Rahul Console' });
    await admin.getByText('Assignment saved.').waitFor();
    const fix = 'We corrected the GSTIN and sent the new invoice to your billing email.';
    await admin.getByTestId('query-reply-input').fill(fix);
    await admin.getByTestId('query-reply-send').click();
    await admin.getByTestId('query-message').filter({ hasText: fix }).waitFor();
    await shot(admin, '11-console-answer-query');
    current = owner;
    await owner.goto(ownerQueryUrl);
    const reply = owner.getByTestId('query-message').filter({ hasText: fix });
    await reply.getByText('SampCrew Support').first().waitFor();
    ok('the Console Admin sees it with the badge, assigns it and replies; the Super Workspace sees SampCrew Support');

    // 7. The Console's help content: publish a new FAQ for Employee Workspace, then unpublish it.
    current = admin;
    await nav.getByRole('link', { name: /Help content/ }).click();
    await admin.waitForURL(/\/help-content/);
    await admin.getByTestId('manage-article-row').first().waitFor();
    await shot(admin, '12-console-help-content');
    await admin.getByTestId('new-article').click();
    await admin.waitForURL(/\/help-content\/articles\/new$/);
    const faqTitle = `Where do I find the canteen menu ${stamp}`;
    await admin.getByTestId('article-title').fill(faqTitle);
    await admin.getByTestId('article-kind').selectOption('faq');
    const leaveCat = await admin.getByTestId('article-category').locator('option', { hasText: /^Leave/ }).first().getAttribute('value');
    await admin.getByTestId('article-category').selectOption(leaveCat);
    await admin.getByTestId('article-summary').fill('The weekly canteen menu is on the noticeboard and in Announcements.');
    await admin.getByTestId('article-body').fill('Open **Announcements** for the weekly menu.\n\n- Menus are posted every Monday\n- Ask HR for special diets');
    await admin.getByTestId('article-keywords').fill(`canteen${stamp}, lunch`);
    await shot(admin, '13-console-article-editor');
    await admin.getByTestId('article-publish').click();
    await admin.waitForURL(/\/help-content\?tab=articles/);
    await admin.getByTestId('manage-article-row').filter({ hasText: faqTitle }).waitFor();
    current = emp;
    await emp.goto(`${BASE}/help/search?q=canteen${stamp}`);
    await emp.getByTestId('help-search-results').getByText(faqTitle).waitFor();
    current = admin;
    await admin.getByTestId('manage-article-row').filter({ hasText: faqTitle }).getByTestId('toggle-publish').click();
    await admin.getByText('Unpublished: saved as a draft.').waitFor();
    current = emp;
    await emp.goto(`${BASE}/help/search?q=canteen${stamp}`);
    await emp.getByTestId('help-search-total').getByText('0 articles').waitFor();
    ok('a FAQ published in the Console appears for the Employee Workspace and disappears when unpublished');

    // 8. Phone width.
    const phone = current = await signIn(b, 'operator2@demo.crew.local', { width: 390, height: 844 });
    await phone.goto(`${BASE}/help`);
    await phone.getByTestId('help-home').waitFor();
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `the help home scrolls sideways on a phone (${overflow}px)`);
    await shot(phone, '14-employee-help-phone');
    await phone.goto(empQueryUrl);
    await phone.getByTestId('query-detail').waitFor();
    await shot(phone, '15-employee-query-phone');
    ok('help home and query work at phone width with no sideways scrolling');
  } catch (e) {
    if (current) await current.screenshot({ path: '/tmp/help-centre-failure.png', fullPage: true }).catch(() => {});
    throw e;
  }
}

(async () => {
  const stamp = Date.now();
  const b = await chromium.launch();
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const users = mongo.db().collection('users');
  const people = ['owner@demo.crew.local', 'hr.admin@demo.crew.local', 'operator2@demo.crew.local'];
  const before = await users.find({ email: { $in: people } }).toArray();
  if (before.length !== people.length) throw new Error('demo people missing: run pnpm db:reset with CREW_SEED_DEMO=true');
  await users.updateMany({ email: { $in: people } }, { $set: { mfa_enabled: false, mfa_secret_enc: null } });
  // A fresh Console Admin with the Super admin role: answers queries and manages the content.
  const adminEmail = `help.${stamp}@sampledge.test`;
  const adminPassword = `E2e-Help-${stamp}!`;
  const now = new Date();
  await mongo.db().collection('platform_admins').insertOne({
    _id: require('node:crypto').randomUUID(), email: adminEmail, full_name: 'Rahul Console', password_hash: await hashPassword(adminPassword), role: 'super_admin',
    status: 'active', mfa_enabled: false, must_change_password: false, failed_login_count: 0, created_at: now, updated_at: now,
  });
  try {
    await run(b, adminEmail, adminPassword, stamp);
  } finally {
    for (const u of before) await users.updateOne({ _id: u._id }, { $set: { mfa_enabled: u.mfa_enabled ?? false, mfa_secret_enc: u.mfa_secret_enc ?? null } });
    await mongo.db().collection('platform_admins').updateOne({ email: adminEmail }, { $set: { status: 'disabled' } });
    await mongo.close();
    await b.close();
  }
  if (errs.length) throw new Error('browser errors:\n' + errs.join('\n'));
  console.log('help centre flow: all checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
