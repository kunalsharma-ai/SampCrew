/**
 * Role-based Home and the notification center, end to end in the Web Portal against the demo workspace.
 *
 *   pnpm db:reset
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/home-flow.cjs
 *
 * 1. Employee Workspace (Neha, machine operator): Home opens on "My day" with her level in the header. She checks in,
 *    starts and ends a break and checks out from the attendance card; each step changes the card's state and the
 *    figures. Clicking a day in the attendance calendar opens its detail.
 * 2. HR assigns Neha a course: without reloading, her menu marks Learning and Notifications unread, and the Learning
 *    page shows the notice at the top; marking it read clears the marker.
 * 3. Notification settings: desktop notifications and quiet hours save and stay saved.
 * 4. Her supervisor (an Employee Workspace manager) has only their own day; HR (company HR Workspace) has "My workforce": clicking a workforce card opens team attendance filtered the
 *    same way. Neha cannot open the workforce view by URL.
 * 5. Super Workspace (the owner) sees the organization: a new HR Workspace appears in Workspace health, and its card
 *    opens the workforce view for that HR Workspace only.
 * Fails on any browser error.
 */
const { chromium } = require('playwright');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const API = `${process.env.API_URL ?? 'http://localhost:4000'}/api/v1`;
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const PUNE = { latitude: 18.5205, longitude: 73.8566, accuracy: 20 };

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const expect = (cond, m) => {
  if (!cond) throw new Error(m);
};

async function api(token, method, p, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}
async function must(token, method, p, body) {
  const r = await api(token, method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function apiLogin(email) {
  const r = await must(null, 'POST', '/auth/login', { email, password: PASSWORD });
  if (r.status !== 'ok') throw new Error(`${email} needs ${r.status}; run on a fresh database (pnpm db:reset)`);
  return r.accessToken;
}

async function signIn(b, email, extra = {}) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, ...extra });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${email} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource.*(401|403|404)/.test(m.text()) && errs.push(`${email} ${m.text()}`));
  for (let attempt = 0; ; attempt++) {
    await p.goto(BASE + '/login');
    await p.fill('input[name=email]', email);
    await p.fill('input[name=password]', PASSWORD);
    await p.click('button[type=submit]');
    const r = await Promise.race([
      p.waitForURL((u) => u.pathname === '/', { timeout: 20000 }).then(() => 'in'),
      p.locator('text=Too many requests').waitFor({ timeout: 20000 }).then(() => 'limited'),
    ]);
    if (r === 'in') return p;
    if (attempt >= 4) throw new Error(`sign-in for ${email} stayed rate limited`);
    await p.waitForTimeout(20000);
  }
}

const phase = (p) => p.getByTestId('attendance-phase').getAttribute('data-phase');
async function waitPhase(p, want) {
  await p.waitForFunction((w) => document.querySelector('[data-testid=attendance-phase]')?.getAttribute('data-phase') === w, want, { timeout: 15000 });
}

(async () => {
  const b = await chromium.launch();
  try {
    const run = Date.now().toString(36);
    const ownerT = await apiLogin('owner@demo.crew.local');

    // 1. Employee Home: check in, break, check out, calendar.
    const e = await signIn(b, 'operator2@demo.crew.local', { geolocation: PUNE, permissions: ['geolocation'] });
    await e.getByTestId('home-header').waitFor();
    expect((await e.getByTestId('home-level').innerText()).includes('Employee Workspace'), 'the header names the Employee Workspace level');
    await e.getByTestId('employee-home').waitFor();
    const hero = e.getByTestId('attendance-hero');
    await hero.waitFor();
    if ((await phase(e)) === 'not_in' || (await phase(e)) === 'done') {
      await hero.getByTestId('check-in').click();
      await waitPhase(e, 'working');
    }
    if ((await phase(e)) === 'on_break') {
      await hero.getByTestId('end-break').click();
      await waitPhase(e, 'working');
    }
    expect((await hero.getByTestId('first-in').innerText()).trim() !== '—', 'first check-in time shows');
    await hero.getByTestId('start-break').click();
    await waitPhase(e, 'on_break');
    await hero.getByTestId('end-break').click();
    await waitPhase(e, 'working');
    await hero.getByTestId('check-out').click();
    await waitPhase(e, 'done');
    expect((await hero.getByTestId('last-out').innerText()).trim() !== '—', 'check-out time shows');
    await hero.getByTestId('check-in').waitFor(); // "Check in again"
    const today = await must(await apiLogin('operator2@demo.crew.local'), 'GET', '/attendance/today');
    const notes = today.punches.map((x) => x.note);
    expect(notes.includes('Break') && notes.includes('Back from break'), `the break punches are recorded, got ${JSON.stringify(notes)}`);
    ok('employee checked in, took a break and checked out from Home; the punches are stored');

    const cell = e.locator('[data-testid^="cal-"][data-status]:not([data-status=""])').first();
    await cell.click();
    await e.getByTestId('calendar-detail').waitFor();
    ok('clicking a calendar day opens its detail');

    // 2. A new course: live menu markers and the notice on the Learning page.
    const nehaT = await apiLogin('operator2@demo.crew.local');
    const neha = (await must(nehaT, 'GET', '/me')).employee;
    const course = await must(ownerT, 'POST', '/learning/courses', { title: `Home flow safety ${run}`, format: 'online', selfEnrol: false });
    await must(ownerT, 'POST', '/learning/assignments', { courseId: course.id, employeeIds: [neha.id], dueOn: '2099-12-31' });
    await e.getByTestId('nav-unread-learning').waitFor({ timeout: 15000 });
    await e.getByTestId('nav-unread-notifications').waitFor();
    ok('the new course marks Learning and Notifications unread in the menu, live');
    await e.goto(BASE + '/learning');
    const notices = e.getByTestId('module-notices-learning');
    await notices.getByText(new RegExp(`Home flow safety ${run}`)).first().waitFor();
    await notices.getByRole('button', { name: 'Mark all read' }).click();
    await notices.waitFor({ state: 'detached' });
    await e.waitForFunction(() => !document.querySelector('[data-testid=nav-unread-learning]'), null, { timeout: 15000 });
    ok('the Learning page shows the notice; marking it read clears the menu marker');

    // 3. Desktop notifications and quiet hours.
    await e.goto(BASE + '/settings/notifications');
    await e.getByTestId('quiet-enabled').click();
    await e.getByTestId('quiet-from').fill('21:30');
    await e.getByTestId('quiet-to').fill('07:15');
    await e.getByRole('button', { name: 'Save notification settings' }).click();
    await e.getByText('Notification settings saved.').waitFor();
    const prefs = await must(nehaT, 'GET', '/notifications/preferences');
    expect(prefs.quiet.enabled && prefs.quiet.from === '21:30' && prefs.quiet.to === '07:15', `quiet hours saved, got ${JSON.stringify(prefs.quiet)}`);
    await must(nehaT, 'PUT', '/notifications/preferences', { ...prefs, quiet: { enabled: false, from: '20:00', to: '08:00' } });
    ok('quiet hours save and stay saved');

    // Neha has no workforce view, whatever the URL says.
    await e.goto(BASE + '/?view=workforce');
    await e.getByTestId('employee-home').waitFor();
    expect((await e.getByTestId('workforce-home').count()) === 0, 'an employee must not see the workforce view');
    const refused = await api(nehaT, 'GET', '/home/workforce');
    expect(refused.status === 403, `the API refuses the workforce view to an employee, got ${refused.status}`);
    ok('an employee cannot open the workforce view by URL or API');

    // 4. Supervisor: My workforce, cards open the filtered team list.
    // A manager at the Employee Workspace level has their own day only (Kunal's rule: they see only themselves).
    const sup = await signIn(b, 'supervisor@demo.crew.local');
    await sup.getByTestId('employee-home').waitFor();
    expect((await sup.getByRole('navigation', { name: 'Home views' }).count()) === 0, 'an Employee Workspace manager has no workforce tab');
    const supT = await apiLogin('supervisor@demo.crew.local');
    expect((await api(supT, 'GET', '/home/workforce')).status === 403, 'the API refuses the workforce view to an Employee Workspace manager');
    expect((await api(supT, 'GET', '/home/organization')).status === 403, 'a manager cannot open the organization view');
    ok('an Employee Workspace manager sees their own day; the workforce and organization views are refused');

    // HR Workspace (company HR): My workforce, cards open the filtered team list.
    const hr = await signIn(b, 'hr.admin@demo.crew.local');
    await hr.getByTestId('workforce-home').waitFor();
    expect((await hr.getByTestId('home-level').innerText()).includes('HR Workspace'), 'the header names the HR Workspace level');
    await hr.getByTestId('wf-present').click();
    await hr.waitForURL((u) => u.pathname === '/attendance/team' && u.searchParams.get('status') === 'present');
    await hr.goto(BASE + '/');
    await hr.getByTestId('wf-late').click();
    await hr.waitForURL((u) => u.pathname === '/attendance/team' && u.searchParams.get('filter') === 'late');
    await hr.getByTestId('team-filter-chip').waitFor();
    ok('HR Workspace sees My workforce; its cards open team attendance with the same filter');

    // 5. Super Workspace: a new HR Workspace in Workspace health, and its card opens that workspace's view.
    const ws = await must(ownerT, 'POST', '/hr-workspaces', { name: `Home flow branch ${run}`, kind: 'branch', features: ['leave', 'attendance_basic', 'learning'] });
    const owner = await signIn(b, 'owner@demo.crew.local');
    if ((await owner.getByTestId('organization-home').count()) === 0 && (await owner.url()).includes('/setup')) await owner.goto(BASE + '/');
    await owner.getByTestId('organization-home').waitFor();
    expect((await owner.getByTestId('home-level').innerText()).includes('Super Workspace'), 'the header names the Super Workspace level');
    await owner.getByTestId('org-alerts').waitFor();
    await owner.getByTestId(`ws-${ws.id}`).click();
    await owner.waitForURL((u) => u.searchParams.get('hrWorkspace') === ws.id);
    await owner.getByTestId('workforce-home').waitFor();
    await owner.getByText(`Home flow branch ${run}`).first().waitFor();
    ok('Super Workspace sees the organization; the HR Workspace card opens its own workforce view');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('home flow passed');
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  if (errs.length) console.error(errs.join('\n'));
  process.exit(1);
});
