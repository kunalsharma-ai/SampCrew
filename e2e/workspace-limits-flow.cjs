/**
 * Plan-based workspace limits, end to end in a real browser against the demo workspace (on Business).
 *
 *   pnpm db:reset            # fresh demo workspace and bootstrap console admin (the admin must not have MFA yet)
 *   API on :4000, Web Portal on :3000, Console on :3001, then: pnpm e2e:workspace-limits
 *
 * 1. The console admin sets Business to 1 HR Workspace and exactly as many Employee Workspaces as the demo company
 *    has logins, in Plans > Modules & limits. The company's page in the Console shows 0 / 1 and N / N at once.
 * 2. The owner (Super Workspace) sees the same Used / Maximum on HR Workspaces, creates one (1 / 1), and then the
 *    New HR Workspace button is closed with "limit reached" and an upgrade option. The API refuses a 2nd one too
 *    (402 workspace_limit_reached), so the limit cannot be bypassed from outside the screens.
 * 3. Logins & access shows Employee Workspaces N / N with Invite people closed.
 * 4. The upgrade option opens Plan & billing on the plans with more room.
 * 5. The console admin raises Business to 3 HR Workspaces and N + 5 Employee Workspaces: the owner gets the new room
 *    straight away (1 / 3), creates another HR Workspace (2 / 3), and nothing that existed was removed.
 * 6. Business gets its catalogue limits back and the HR Workspaces made here are archived.
 * Fails on any browser error. SHOTS=<dir> saves a screenshot of each screen.
 */
const path = require('node:path');
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));

const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';
const ADMIN_EMAIL = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !PASSWORD) throw new Error('Set CREW_BOOTSTRAP_ADMIN_EMAIL, CREW_BOOTSTRAP_ADMIN_PASSWORD and CREW_DEMO_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const SHOTS = process.env.SHOTS;
const shot = (p, name) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' }) : Promise.resolve());
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(`${who} ${m.text()}`));
  p.on('dialog', (d) => d.accept());
};
const context = (b) => b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });

async function signIn(page, email) {
  for (let attempt = 1; ; attempt++) {
    await page.goto(WEB + '/login');
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', PASSWORD);
    await page.click('button[type=submit]');
    const r = await Promise.race([
      page.waitForURL((u) => u.pathname === '/', { timeout: 15000 }).then(() => 'in'),
      page.locator('text=Too many requests').waitFor({ timeout: 15000 }).then(() => 'limited'),
    ]);
    if (r === 'in') return;
    if (attempt >= 4) throw new Error('sign-in stayed rate limited');
    await page.waitForTimeout(20000);
  }
}

/** Plans > Modules & limits on one plan: types the limits and saves. Returns the saved message. */
async function setLimits(admin, planKey, limits, shotName) {
  await admin.goto(`${CONSOLE}/plans`);
  await admin.getByTestId(`plan-edit-contents-${planKey}`).click();
  for (const [key, value] of Object.entries(limits)) await admin.getByTestId(`plan-limit-${key}`).fill(String(value));
  if (shotName) await shot(admin, shotName);
  await admin.getByTestId('plan-contents-save').click();
  // Removing a module or lowering a limit on a plan in use shows who it affects first; confirm with Save anyway.
  const saved = admin.getByText(/saved.*Applies now to \d+ workspace/);
  await saved.or(admin.getByTestId('plan-impact-preview')).first().waitFor({ timeout: 15000 });
  if (await admin.getByTestId('plan-impact-preview').isVisible()) await admin.getByTestId('plan-contents-save').click();
  const msg = admin.getByText(/saved.*Applies now to \d+ workspace/);
  await msg.waitFor({ timeout: 15000 });
  return msg.textContent();
}

const meter = async (page, kind) => (await page.getByTestId(`workspace-limit-${kind}-text`).first().textContent()).trim();

async function createHr(owner, name) {
  await owner.getByTestId('new-hr-workspace').click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Kind').selectOption('branch');
  await dialog.getByRole('button', { name: 'Create HR Workspace' }).click();
  await owner.waitForURL(/\/hr-workspaces\/[0-9a-f-]{36}/, { timeout: 15000 });
}

(async () => {
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const db = mongo.db();
  const ownerUser = await db.collection('users').findOne({ email: 'owner@demo.crew.local' });
  const ownerMembership = ownerUser && (await db.collection('memberships').findOne({ user_id: ownerUser._id }));
  const tenant = ownerMembership && (await db.collection('tenants').findOne({ _id: ownerMembership.tenant_id }));
  expect(tenant, 'demo workspace missing: run pnpm db:reset');
  const logins = await db.collection('memberships').countDocuments({ tenant_id: tenant._id, status: { $ne: 'suspended' } });
  const hrBefore = await db.collection('hr_workspaces').countDocuments({ tenant_id: tenant._id, archived_at: null });
  const business = await db.collection('plans').findOne({ key: 'business' });
  const original = Object.fromEntries((await db.collection('plan_features').find({ plan_id: business._id, feature_key: { $in: ['max_hr_workspaces', 'max_employee_workspaces'] } }).toArray()).map((r) => [r.feature_key, r.limit_value]));
  const stamp = Date.now().toString(36).slice(-4).toUpperCase();
  const made = [];

  const b = await chromium.launch();
  const admin = await (await context(b)).newPage();
  const owner = await (await context(b)).newPage();
  watch(admin, 'console');
  watch(owner, 'owner');
  let current = admin;
  try {
    // 1. Console: the plan holds the limits, and the company inherits them.
    await admin.goto(`${CONSOLE}/login`);
    await admin.fill('input[name=email]', ADMIN_EMAIL);
    await admin.fill('input[name=password]', ADMIN_PASSWORD);
    await admin.click('button[type=submit]');
    await admin.waitForURL(/\/enrol$/);
    await admin.click('text=Show QR code');
    const secret = (await admin.locator('code').first().textContent()).trim();
    await admin.fill('input[name=code]', authenticator.generate(secret));
    await admin.click('text=Turn on and continue');
    await admin.waitForURL(`${CONSOLE}/`);
    await setLimits(admin, 'business', { max_hr_workspaces: hrBefore + 1, max_employee_workspaces: logins }, '01-console-plan-limits');
    await shot(admin, '02-console-plan-saved');
    await admin.goto(`${CONSOLE}/tenants/${tenant._id}`);
    const card = admin.getByTestId('console-workspace-limits');
    await card.waitFor();
    expect((await admin.getByTestId('console-workspace-limit-hr').textContent()).includes(`${hrBefore} / ${hrBefore + 1}`), 'Console should show the HR Workspaces from the plan');
    expect((await admin.getByTestId('console-workspace-limit-employee').textContent()).includes(`${logins} / ${logins}`), 'Console should show the Employee Workspaces from the plan');
    await card.scrollIntoViewIfNeeded();
    await shot(admin, '03-console-company-limits');
    ok(`Console sets Business to ${hrBefore + 1} HR Workspaces and ${logins} Employee Workspaces; the company shows them at once`);

    // 2. Super Workspace: Used / Maximum, creation up to the limit, then closed.
    current = owner;
    await signIn(owner, 'owner@demo.crew.local');
    await owner.goto(WEB + '/hr-workspaces');
    expect(await meter(owner, 'hr') === `${hrBefore} / ${hrBefore + 1}`, `HR Workspaces should read ${hrBefore} / ${hrBefore + 1}`);
    expect(await meter(owner, 'employee') === `${logins} / ${logins}`, `Employee Workspaces should read ${logins} / ${logins}`);
    await shot(owner, '04-super-workspace-limits');
    const first = `Limit Branch ${stamp}`;
    await createHr(owner, first);
    made.push(first);
    await owner.goto(WEB + '/hr-workspaces');
    expect(await meter(owner, 'hr') === `${hrBefore + 1} / ${hrBefore + 1}`, 'HR Workspaces should be full after creating one');
    expect(await owner.getByTestId('new-hr-workspace').isDisabled(), 'New HR Workspace must be closed at the limit');
    await owner.getByTestId('workspace-limit-hr-reached').waitFor();
    await owner.getByTestId('workspace-limit-hr-upgrade').waitFor();
    await shot(owner, '05-hr-workspace-limit-reached');
    ok('the Super Workspace creates HR Workspaces up to the plan limit, then the button closes with an upgrade option');

    // The API refuses too: the screens are not the only guard.
    const login = await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@demo.crew.local', password: PASSWORD }) })).json();
    const res = await fetch(`${API}/hr-workspaces`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.accessToken}` }, body: JSON.stringify({ name: `Bypass ${stamp}`, kind: 'branch', features: [], adminMembershipIds: [] }) });
    const body = await res.json();
    expect(res.status === 402 && body.error.code === 'workspace_limit_reached', `API should refuse with 402 workspace_limit_reached, got ${res.status} ${JSON.stringify(body)}`);
    expect(await db.collection('hr_workspaces').countDocuments({ tenant_id: tenant._id, name: `Bypass ${stamp}` }) === 0, 'nothing may be created past the limit');
    ok(`the API refuses a creation past the limit: ${body.error.message}`);

    // 3. Employee Workspaces: logins are full, so invites and logins on Add employee are closed.
    await owner.goto(WEB + '/people');
    expect(await meter(owner, 'employee') === `${logins} / ${logins}`, 'Logins & access should show Employee Workspaces full');
    expect(await owner.getByTestId('invite-people').isDisabled(), 'Invite people must be closed at the limit');
    await owner.getByTestId('workspace-limit-employee-reached').waitFor();
    await shot(owner, '06-employee-workspace-limit-reached');
    ok('Logins & access shows Employee Workspaces full and closes Invite people');

    // 4. The upgrade option opens Plan & billing on the plans with more room.
    await owner.getByTestId('workspace-limit-employee-upgrade').click();
    await owner.waitForURL(/\/settings\/billing\?limit=max_employee_workspaces/);
    await owner.getByTestId('billing-limit-focus').waitFor();
    await owner.getByText('More room').first().waitFor();
    await shot(owner, '07-billing-upgrade-options');
    ok('the upgrade option opens Plan & billing with the roomier plans marked');

    // 5. Console raises the plan: new room at once, nothing removed.
    current = admin;
    await setLimits(admin, 'business', { max_hr_workspaces: hrBefore + 3, max_employee_workspaces: logins + 5 });
    current = owner;
    await owner.goto(WEB + '/hr-workspaces');
    expect(await meter(owner, 'hr') === `${hrBefore + 1} / ${hrBefore + 3}`, 'the raised HR Workspace limit should apply at once');
    expect(await meter(owner, 'employee') === `${logins} / ${logins + 5}`, 'the raised Employee Workspace limit should apply at once');
    expect(!(await owner.getByTestId('new-hr-workspace').isDisabled()), 'New HR Workspace opens again');
    await shot(owner, '08-limits-raised');
    const second = `Second Branch ${stamp}`;
    await createHr(owner, second);
    made.push(second);
    await owner.goto(WEB + '/hr-workspaces');
    expect(await meter(owner, 'hr') === `${hrBefore + 2} / ${hrBefore + 3}`, 'one more HR Workspace fits after the raise');
    expect(await db.collection('hr_workspaces').countDocuments({ tenant_id: tenant._id, name: first, archived_at: null }) === 1, 'the first HR Workspace is intact');
    await shot(owner, '09-created-after-raise');
    await owner.goto(WEB + '/people');
    expect(!(await owner.getByTestId('invite-people').isDisabled()), 'Invite people opens again');
    ok('after the Console raises the plan the company gets the extra room straight away; existing workspaces stay');

    // 6. Back as it was for the flows after this one.
    current = admin;
    await setLimits(admin, 'business', original);
    for (const name of made) {
      const w = await db.collection('hr_workspaces').findOne({ tenant_id: tenant._id, name });
      const r = await fetch(`${API}/hr-workspaces/${w._id}/status`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.accessToken}` }, body: JSON.stringify({ status: 'archived', reason: 'Workspace limits e2e clean-up' }) });
      expect(r.ok, `archiving ${name} failed: ${r.status} ${await r.text()}`);
    }
    ok('Business limits restored and the test HR Workspaces archived');

    if (errs.length) throw new Error(`Browser errors:\n${errs.join('\n')}`);
    console.log('workspace limits flow passed');
  } catch (e) {
    await current.screenshot({ path: process.env.SHOT ?? '/tmp/workspace-limits-fail.png', fullPage: true }).catch(() => {});
    console.error(e);
    process.exitCode = 1;
  } finally {
    await b.close();
    await mongo.close();
  }
})();
