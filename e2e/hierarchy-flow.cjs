/**
 * HR Workspaces and the delegation chain, end to end in a real browser against the demo workspace.
 *
 *   pnpm db:reset
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/hierarchy-flow.cjs
 *
 * 1. The owner (Super Workspace) sees everyone in the central group, creates an HR Workspace with two modules and
 *    names the supervisor as its admin. A module the company does not hold is locked in the picker.
 * 2. The owner moves two people from the central group into it, then gives one of them only Leave.
 * 3. The history tab lists the creation and the module change.
 * 4. The supervisor signs in: HR Workspaces shows only theirs, its modules are read-only, and they can choose the
 *    modules of its people but cannot move people or create HR Workspaces.
 * 5. The owner archives it: its people go back to the central group and the supervisor's access ends, so the flows
 *    after this one see the demo workspace as it was.
 * Fails on any browser error. SHOTS=<dir> saves a screenshot of each screen.
 */
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
  p.on('console', (m) => m.type() === 'error' && errs.push(`${who} ${m.text()}`));
};
const SHOTS = process.env.SHOTS;
const save = async (p, name) => {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' });
};
const fail = async (p, e) => {
  await p.screenshot({ path: process.env.SHOT ?? '/tmp/hierarchy-fail.png', fullPage: true }).catch(() => {});
  throw e;
};
const see = (p, text, timeout = 15000) => p.getByText(text).first().waitFor({ timeout }).catch((e) => fail(p, e));

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
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

const stamp = Date.now().toString(36).slice(-5).toUpperCase();
const NAME = `Pune Branch ${stamp}`;

(async () => {
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const db = mongo.db();
  const b = await chromium.launch();
  try {
    // 1. The owner creates an HR Workspace.
    const owner = await signIn(b, 'owner@demo.crew.local');
    await owner.goto(BASE + '/hr-workspaces');
    await see(owner, 'Super Workspace');
    await see(owner, 'How access flows');
    const centralBefore = await db.collection('employees').countDocuments({ hr_workspace_id: null, status: { $ne: 'exited' } });
    await save(owner, '01-hr-workspaces-empty');
    await owner.getByRole('button', { name: 'New HR Workspace' }).first().click();
    const dialog = owner.getByRole('dialog');
    await dialog.getByLabel('Name').fill(NAME);
    await dialog.getByLabel('Short code').fill(`P${stamp}`);
    await dialog.getByLabel('Kind').selectOption('branch');
    await dialog.getByLabel('Leave management').check();
    await dialog.getByLabel('Web and mobile attendance').check();
    // Single sign-on is not in the demo plan: locked, so it cannot be ticked.
    if (!(await dialog.getByLabel('Single sign-on (OpenID Connect) and user provisioning (SCIM)').isDisabled().catch(() => true))) throw new Error('A module the company does not hold could be given');
    await dialog.getByLabel('Find a person').fill('supervisor');
    await dialog.locator('label', { hasText: /supervisor/i }).first().click();
    await save(owner, '02-new-hr-workspace');
    await dialog.getByRole('button', { name: 'Create HR Workspace' }).click();
    await owner.waitForURL(/\/hr-workspaces\/[0-9a-f-]{36}/, { timeout: 15000 }).catch((e) => fail(owner, e));
    await see(owner, 'Modules for this HR Workspace');
    const ws = await db.collection('hr_workspaces').findOne({ name: NAME });
    if (!ws || ws.features.join() !== 'attendance_basic,leave') throw new Error(`HR Workspace not stored as chosen: ${JSON.stringify(ws?.features)}`);
    await save(owner, '03-hr-workspace-modules');
    ok('owner creates an HR Workspace with a subset of the company modules and names its admin');

    // 2. People move in from the central group, and one gets only Leave.
    await owner.getByRole('tab', { name: 'People' }).click();
    await see(owner, 'People in this HR Workspace');
    await owner.getByRole('button', { name: 'Add people' }).click();
    const add = owner.getByRole('dialog');
    const boxes = add.locator('input[type=checkbox]');
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await add.getByLabel('Reason').fill('Joined the Pune branch');
    await add.getByRole('button', { name: /^Add/ }).click();
    await add.waitFor({ state: 'hidden', timeout: 15000 }).catch((e) => fail(owner, e));
    const moved = await db.collection('employees').find({ hr_workspace_id: ws._id }).toArray();
    if (moved.length !== 2) throw new Error(`expected 2 people moved, got ${moved.length}`);
    await owner.reload();
    const withLogin = owner.getByRole('button', { name: 'Modules', exact: true }).first();
    await withLogin.waitFor({ timeout: 15000 }).catch((e) => fail(owner, e));
    await withLogin.click();
    const mods = owner.getByRole('dialog');
    await mods.getByLabel('Web and mobile attendance').uncheck();
    await mods.getByRole('button', { name: 'Save' }).click();
    await mods.waitFor({ state: 'hidden', timeout: 15000 }).catch((e) => fail(owner, e));
    await see(owner, '1 held back');
    await save(owner, '04-hr-workspace-people');
    ok('owner moves people in and gives one of them only part of the HR Workspace modules');

    // 3. History.
    await owner.getByRole('tab', { name: 'History' }).click();
    await see(owner, 'Change history');
    await see(owner, 'Created');
    await see(owner, 'Joined the Pune branch');
    await save(owner, '05-hr-workspace-history');
    ok('history lists the versions and the moves');

    // 4. The HR Workspace admin.
    const sup = await signIn(b, 'supervisor@demo.crew.local');
    await sup.goto(BASE + '/hr-workspaces');
    await see(sup, 'HR Workspaces you run');
    await see(sup, NAME);
    if (await sup.getByRole('button', { name: 'New HR Workspace' }).count()) throw new Error('An HR Workspace admin can create HR Workspaces');
    await sup.getByText(NAME).first().click();
    await see(sup, 'Modules for this HR Workspace');
    if (await sup.getByRole('button', { name: 'Save modules' }).count()) throw new Error('An HR Workspace admin can change its modules');
    await sup.getByRole('tab', { name: 'People' }).click();
    await see(sup, 'People in this HR Workspace');
    if (await sup.getByRole('button', { name: 'Add people' }).count()) throw new Error('An HR Workspace admin can move people in');
    await save(sup, '06-hr-admin-view');
    ok('the HR Workspace admin sees only theirs, cannot change it or move people');

    // 5. Archive, which also puts the demo data back.
    await owner.goto(BASE + `/hr-workspaces/${ws._id}`);
    await owner.getByRole('button', { name: 'Archive' }).click();
    const arch = owner.getByRole('dialog');
    await arch.getByLabel('Reason').fill('End of the browser test');
    await arch.getByRole('button', { name: 'Archive' }).click();
    await owner.waitForURL((u) => u.pathname === '/hr-workspaces', { timeout: 15000 }).catch((e) => fail(owner, e));
    const centralAfter = await db.collection('employees').countDocuments({ hr_workspace_id: null, status: { $ne: 'exited' } });
    if (centralAfter !== centralBefore) throw new Error(`central group had ${centralBefore}, now ${centralAfter}`);
    const role = await db.collection('roles').findOne({ tenant_id: ws.tenant_id, key: 'hr_workspace_admin' });
    if (await db.collection('role_assignments').countDocuments({ role_id: role._id })) throw new Error('the admin kept the HR Workspace Admin role');
    ok('archiving moves its people back to the central group and ends its admins’ access');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('hierarchy flow passed');
  } finally {
    await b.close();
    await mongo.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
