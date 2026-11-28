/**
 * The attendance redesign end to end in a real browser, against a fresh demo workspace (it adds two HR Workspaces and
 * changes attendance permissions, so CI runs it in its own step after `pnpm db:reset`).
 *
 *   pnpm db:reset
 *   node apps/api/dist/main.js & pnpm --filter @crew/web start &
 *   node e2e/attendance-overview-flow.cjs        (SHOTS=<dir> saves a screenshot of each screen)
 *
 * 1. Setup through the API as the owner: HR Workspace "Assembly Line" run by the supervisor with both operators, and
 *    "Quality Cell" run by the UK account executive with the QA lead.
 * 2. Super Workspace: own attendance first, then the dashboard, HR Workspace and Employee Workspace sections, filters,
 *    the date-wise view and an Excel download.
 * 3. HR Workspace (the supervisor): own attendance and their employees only; no Super Workspace, no other HR Workspace,
 *    not even by changing the URL.
 * 4. The Super Workspace lets Assembly Line see Quality Cell from Attendance permissions; the supervisor now sees it,
 *    still never the Super Workspace. Switched off again, it is gone.
 * 5. Employee Workspace (an operator): own attendance only; the lists redirect home and the URL trick gives 404.
 * 6. Cleans up: both HR Workspaces archived and the permissions removed.
 * Fails on any browser error.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
require('./delete-password.cjs');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));
const { unzipSync, strFromU8 } = require(require.resolve('fflate', { paths: [path.join(__dirname, '../apps/api')] }));

const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const API = `${process.env.CREW_API_URL ?? 'http://localhost:4000'}/api/v1`;
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/status of 404/.test(m.text()) && errs.push(`${who} ${m.text()}`));
};
const SHOTS = process.env.SHOTS;
const save = async (p, name) => {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' });
};
const fail = async (p, e) => {
  await p.screenshot({ path: process.env.SHOT ?? '/tmp/attendance-overview-fail.png', fullPage: true }).catch(() => {});
  throw e;
};
const see = (p, text, timeout = 20000) => p.getByText(text).first().waitFor({ timeout }).catch((e) => fail(p, e));
const absent = async (p, text) => {
  if (await p.getByText(text).count()) await fail(p, new Error(`"${text}" should not be on ${p.url()}`));
};

async function signIn(b, email, viewport = { width: 1360, height: 900 }) {
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

async function apiAs(email) {
  const r = await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) })).json();
  if (r.status !== 'ok') throw new Error(`${email} API sign-in needs ${r.status}`);
  return async (method, url, body) => {
    const res = await fetch(`${API}${url}`, { method, headers: { authorization: `Bearer ${r.accessToken}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

/** Rows of one sheet of a downloaded workbook (inline strings and numbers, as the API writes them). */
function sheetRows(file, n) {
  const files = unzipSync(new Uint8Array(fs.readFileSync(file)));
  const xml = strFromU8(files[`xl/worksheets/sheet${n}.xml`]);
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((m) => [...m[1].matchAll(/<c\b[^>]*>(?:<is><t[^>]*>([\s\S]*?)<\/t><\/is>|<v>([\s\S]*?)<\/v>)<\/c>/g)].map((c) => c[1] ?? c[2]));
}

/** Opens the Export dialog from this button and downloads the Excel file (the dialog's defaults). */
async function download(p, button) {
  await button.click();
  const dialog = p.getByTestId('attendance-export-dialog');
  await dialog.waitFor();
  const [d] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), dialog.getByTestId('export-download').click()]);
  const file = path.join(os.tmpdir(), `att-${Date.now()}-${d.suggestedFilename()}`);
  await d.saveAs(file);
  if (fs.readFileSync(file).subarray(0, 2).toString() !== 'PK') throw new Error(`${d.suggestedFilename()} is not an Excel file`);
  return { file, name: d.suggestedFilename() };
}

(async () => {
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const db = mongo.db();
  const b = await chromium.launch();
  const stamp = Date.now().toString(36).slice(-4).toUpperCase();
  const created = [];
  let owner;
  try {
    // 1. Setup through the API.
    const asOwner = await apiAs('owner@demo.crew.local');
    const membership = async (email) => {
      const u = await db.collection('users').findOne({ email });
      return (await db.collection('memberships').findOne({ user_id: u._id }))._id;
    };
    const employee = async (email) => (await db.collection('employees').findOne({ work_email: email }))._id;
    const mk = async (name, code, admin) => {
      const w = await asOwner('POST', '/hr-workspaces', { name, code, kind: 'department', features: ['attendance_basic', 'leave'], adminMembershipIds: [await membership(admin)] });
      created.push(w.id);
      return w.id;
    };
    const assembly = await mk(`Assembly Line ${stamp}`, `AL${stamp}`, 'supervisor@demo.crew.local');
    const quality = await mk(`Quality Cell ${stamp}`, `QC${stamp}`, 'uk.sales@demo.crew.local');
    await asOwner('POST', `/hr-workspaces/${assembly}/members`, { employeeIds: [await employee('operator1@demo.crew.local'), await employee('operator2@demo.crew.local')], reason: 'Attendance e2e' });
    await asOwner('POST', `/hr-workspaces/${quality}/members`, { employeeIds: [await employee('qa.lead@demo.crew.local')], reason: 'Attendance e2e' });
    const ownerEmployee = await employee('owner@demo.crew.local');
    ok('owner sets up two HR Workspaces with their admins and people');

    // 2. Super Workspace.
    owner = await signIn(b, 'owner@demo.crew.local');
    await owner.goto(BASE + '/attendance');
    await see(owner, 'My attendance');
    await see(owner, 'Attendance dashboard');
    await see(owner, 'HR Workspace Attendance');
    await see(owner, 'Employee Workspace Attendance');
    const first = await owner.locator('[data-testid=my-attendance]').boundingBox();
    const dash = await owner.locator('[data-testid=attendance-dashboard]').boundingBox();
    if (!first || !dash || first.y > dash.y) throw new Error('personal attendance is not at the top');
    await save(owner, '01-super-attendance-overview');
    ok('Super Workspace sees their own attendance first, then the dashboard and both sections');

    await owner.locator('[data-testid=section-hr-workspaces]').click();
    await owner.waitForURL(/\/attendance\/hr-workspaces/);
    await see(owner, 'Central group');
    await see(owner, `Assembly Line ${stamp}`);
    await see(owner, `Quality Cell ${stamp}`);
    await save(owner, '02-super-hr-workspace-attendance');
    await owner.getByRole('link', { name: `Assembly Line ${stamp}` }).click();
    await owner.waitForURL(new RegExp(`/attendance/hr-workspaces/${assembly}`));
    await see(owner, 'HR Workspace people');
    await see(owner, 'Sunita Patil');
    await see(owner, 'Arjun Kulkarni');
    await save(owner, '03-super-one-hr-workspace');
    const one = await download(owner, owner.getByRole('button', { name: 'Export this HR Workspace' }));
    const people = sheetRows(one.file, 2);
    const names = people.slice(1).map((r) => r[2]).sort();
    if (names.join() !== ['Arjun Kulkarni', 'Neha Deshmukh', 'Sunita Patil'].join()) throw new Error(`HR Workspace export holds ${names}`);
    ok('Super Workspace opens one HR Workspace and exports exactly its people to Excel');

    await owner.goto(BASE + '/attendance/employees');
    await see(owner, 'Employee-wise attendance');
    const rows = await owner.getByRole('table', { name: 'Employee-wise attendance' }).locator('tbody tr').count();
    if (rows < 10) throw new Error(`expected the whole company, got ${rows} rows`);
    await save(owner, '04-super-employee-attendance');
    await owner.locator('[data-testid=attendance-filters] select[name=hrWorkspaceId]').selectOption(quality);
    await owner.locator('[data-testid=attendance-filters] select[name=status]').selectOption('absent');
    await owner.getByRole('button', { name: 'Apply' }).click();
    await owner.waitForURL(/hrWorkspaceId=/);
    await see(owner, 'Farhan Qureshi');
    await absent(owner, 'Arjun Kulkarni');
    await owner.getByRole('link', { name: 'Date-wise' }).click();
    await owner.waitForURL(/view=records/);
    await see(owner, 'Date-wise attendance');
    await save(owner, '05-super-date-wise');
    const all = await download(owner, owner.getByRole('button', { name: 'Export', exact: true }));
    if (!/attendance-quality-cell/.test(all.name)) throw new Error(`unexpected file name ${all.name}`);
    const recs = sheetRows(all.file, 3);
    if (recs[0].slice(0, 11).join('|') !== 'Workspace Name|Workspace Type|Employee Name|Employee ID|Department|Designation|Location|Date|Day|Attendance Status|Detail') throw new Error(`Date-wise columns: ${recs[0]}`);
    if (recs.slice(1).some((r) => !['Farhan Qureshi', 'Oliver Bennett'].includes(r[2]) || r[9] !== 'Absent') || !recs.some((r) => r[2] === 'Farhan Qureshi')) throw new Error('filtered export holds other people or statuses');
    ok('Super Workspace filters by HR Workspace and status, switches to date-wise and exports the same rows');

    // 3. HR Workspace (the supervisor): their employees only.
    const sup = await signIn(b, 'supervisor@demo.crew.local');
    await sup.goto(BASE + '/attendance');
    await see(sup, 'My attendance');
    await see(sup, 'Employee Workspace Attendance');
    await absent(sup, 'HR Workspace Attendance');
    await save(sup, '06-hr-attendance-overview');
    await sup.goto(BASE + '/attendance/employees');
    await see(sup, 'Arjun Kulkarni');
    await absent(sup, 'Aarav Mehta');
    await absent(sup, 'Farhan Qureshi');
    await save(sup, '07-hr-employee-attendance');
    await sup.goto(`${BASE}/attendance?employeeId=${ownerEmployee}`);
    await see(sup, 'Page not found');
    await sup.goto(`${BASE}/attendance/hr-workspaces/${quality}`);
    await see(sup, 'Page not found');
    ok('HR Workspace sees its own employees only, and changing the URL does not show the Super Workspace or another HR Workspace');

    // 4. The Super Workspace opens Quality Cell to Assembly Line.
    await owner.goto(BASE + '/settings/attendance-access');
    await see(owner, 'Attendance permissions');
    const card = owner.locator(`[data-testid=access-${assembly}]`);
    await card.getByTestId(`${assembly}-attendance.view_other_hr`).click();
    await card.getByText('Only the ones I pick').click();
    await card.getByLabel(`Quality Cell ${stamp}`).check();
    await save(owner, '08-super-attendance-permissions');
    await card.getByTestId(`save-${assembly}`).click();
    await card.getByText('Saved.').waitFor({ timeout: 15000 }).catch((e) => fail(owner, e));
    const stored = await db.collection('level_permissions').findOne({ subject_id: assembly });
    if (!stored?.permissions['attendance.view_other_hr'] || stored.scope_hr_workspace_ids.join() !== quality) throw new Error(`permission not stored: ${JSON.stringify(stored)}`);
    ok('Super Workspace lets Assembly Line see Quality Cell attendance');

    await sup.goto(BASE + '/attendance');
    await see(sup, 'HR Workspace Attendance');
    await sup.goto(BASE + '/attendance/hr-workspaces');
    await see(sup, `Quality Cell ${stamp}`);
    await absent(sup, 'Central group');
    await save(sup, '09-hr-sees-other-hr-workspace');
    await sup.goto(BASE + '/attendance/employees');
    await see(sup, 'Farhan Qureshi');
    await absent(sup, 'Aarav Mehta');
    ok('the supervisor now sees Quality Cell too, and still never the Super Workspace');

    await owner.reload();
    await owner.locator(`[data-testid=access-${assembly}]`).getByTestId(`${assembly}-attendance.view_other_hr`).click();
    await owner.locator(`[data-testid=access-${assembly}]`).getByTestId(`save-${assembly}`).click();
    await owner.locator(`[data-testid=access-${assembly}]`).getByText('Saved.').waitFor({ timeout: 15000 }).catch((e) => fail(owner, e));
    await sup.goto(BASE + '/attendance/hr-workspaces');
    await sup.waitForURL((u) => u.pathname === '/attendance', { timeout: 15000 }).catch((e) => fail(sup, e));
    ok('switched off, the HR Workspace section is gone again');

    // 5. Employee Workspace.
    const op = await signIn(b, 'operator1@demo.crew.local');
    await op.goto(BASE + '/attendance');
    await see(op, 'My attendance');
    await absent(op, 'Attendance dashboard');
    await absent(op, 'Employee Workspace Attendance');
    if (await op.locator('nav[aria-label="Main"] a[href="/attendance/team"]').count()) throw new Error('Employee Workspace sees Team attendance');
    await save(op, '10-employee-attendance');
    await op.goto(BASE + '/attendance/employees');
    await op.waitForURL((u) => u.pathname === '/attendance', { timeout: 15000 }).catch((e) => fail(op, e));
    await op.goto(`${BASE}/attendance?employeeId=${await employee('operator2@demo.crew.local')}`);
    await see(op, 'Page not found');
    await op.goto(BASE + '/attendance?period=week');
    await see(op, 'Attendance history');
    const mine = await download(op, op.getByRole('button', { name: 'Export my attendance' }));
    const own = sheetRows(mine.file, 2);
    if (own.length !== 2 || own[1][2] !== 'Arjun Kulkarni') throw new Error(`own export holds ${own.map((r) => r[2])}`);
    ok('Employee Workspace sees and exports only its own attendance');

    // Phone width: the overview stays readable.
    const phone = await signIn(b, 'owner@demo.crew.local', { width: 390, height: 844 });
    await phone.goto(BASE + '/attendance');
    await see(phone, 'My attendance');
    await see(phone, 'Attendance trend');
    await phone.waitForLoadState('networkidle');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 4) throw new Error(`the overview is ${overflow}px wider than a phone`);
    await save(phone, '11-phone-overview');
    ok('the overview fits a phone screen');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
  } finally {
    // 6. Clean up, so later flows see the demo workspace as it was.
    if (created.length) {
      await db.collection('level_permissions').deleteMany({ subject_id: { $in: created } });
      try {
        const asOwner = await apiAs('owner@demo.crew.local');
        for (const id of created) await asOwner('POST', `/hr-workspaces/${id}/status`, { status: 'archived', reason: 'Attendance e2e finished' }).catch(() => undefined);
      } catch {
        /* best effort */
      }
    }
    await b.close();
    await mongo.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
