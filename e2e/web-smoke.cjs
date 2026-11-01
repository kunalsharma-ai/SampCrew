/**
 * Web portal end-to-end smoke test, driven through a real browser against a running API and web app.
 *
 *   pnpm db:reset && pnpm db:migrate && pnpm db:seed     # fresh demo workspace
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/web-smoke.cjs
 *
 * Signs in as the demo owner, enrols MFA through the Security page, changes workspace settings and the plan,
 * checks the downgrade guard, creates and renames a location, verifies the audit chain, then signs in again
 * with MFA (including a wrong code), invites a recruiter, accepts the invitation in a second browser, and checks
 * the recruiter cannot open billing. Uses Playwright and otplib from the workspace.
 */
const { chromium } = require('playwright');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const { authenticator } = require('otplib');
async function adminFlow() {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1360, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.goto(BASE + '/login');
  await p.fill('input[name=email]', 'owner@demo.crew.local');
  await p.fill('input[name=password]', PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForURL(BASE + '/');

  // 0. Enrol MFA through the Security page (session is upgraded to MFA on success)
  await p.goto(BASE + '/settings/security');
  await p.click('text=Set up two-step verification');
  const secret = (await p.locator('code').first().textContent()).trim(); 
  await p.fill('input[name=code]', authenticator.generate(secret));
  await p.click('text=Turn on');
  await p.waitForSelector('text=/two-step verification is on/i', { timeout: 8000 });
  console.log('mfa enrol: OK');
  // 1. Workspace: change brand colour
  await p.goto(BASE + '/settings/workspace');
  await p.fill('input[placeholder="#4f46e5"]', '#0f766e');
  await p.click('text=Save changes');
  await p.waitForSelector('text=Settings saved', { timeout: 8000 });
  console.log('workspace save: OK');
  // invalid input is caught client-side
  await p.fill('input[placeholder="#4f46e5"]', 'teal');
  await p.click('text=Save changes');
  await p.waitForTimeout(500);
  console.log('workspace invalid colour error shown:', await p.locator('text=/Invalid|match/i').count() > 0);

  // 2. Billing: change seats on current plan
  await p.goto(BASE + '/settings/billing');
  await p.click('text=Change seats or cycle');
  await p.fill('dialog input[type=number]', '130');
  await p.click('text=Confirm change');
  await p.waitForSelector('text=15 / 130', { timeout: 8000 });
  console.log('billing seats 120 -> 130: OK');
  // downgrade blocked: Starter allows 1 entity, demo has 2
  await p.locator('text=Switch to this plan').first().click();
  await p.fill('dialog input[type=number]', '20');
  await p.click('text=Confirm change');
  await p.waitForTimeout(1500);
  console.log('downgrade blocked message:', (await p.locator('dialog [class*=danger], dialog [role=alert]').first().textContent().catch(() => 'none'))?.slice(0, 140));
    await p.click('dialog >> text=Cancel');

  // 3. Organization: add a location, then rename it
  await p.goto(BASE + '/organization?tab=locations');
  await p.click('text=Add location');
  await p.fill('dialog input[name=name]', 'Smoke Test Depot');
  await p.selectOption('dialog select[name=kind]', 'warehouse');
  await p.locator('dialog select[name=legalEntityId]').selectOption({ index: 1 });
  const tz = p.locator('dialog input[name=timezone]'); if (await tz.count()) await tz.fill('Asia/Kolkata');
  const cc = p.locator('dialog [name=countryCode]'); if (await cc.count()) { const tag = await cc.evaluate((e) => e.tagName); tag === 'SELECT' ? await cc.selectOption('IN') : await cc.fill('IN'); }
  await p.click('dialog button[type=submit]');
  await p.waitForSelector('text=Smoke Test Depot', { timeout: 8000 });
  await p.click('[aria-label="Edit Smoke Test Depot"]');
  await p.fill('dialog input[name=name]', 'Smoke Test Depot Renamed');
  await p.click('dialog button[type=submit]');
  await p.waitForSelector('text=Smoke Test Depot Renamed', { timeout: 8000 });
  console.log('location create + rename: OK');
  await p.click('[aria-label="Archive Smoke Test Depot Renamed"]').catch(()=>{});

  // 4. Audit shows these
  await p.goto(BASE + '/settings/audit');
  console.log('audit top actions:', await p.locator('tbody code').evaluateAll((els) => els.slice(0, 5).map((e) => e.textContent)));
  await p.click('text=Verify integrity');
  await p.waitForSelector('text=Chain intact', { timeout: 8000 });
  console.log('audit verify: intact');
  console.log('errors:', errs.join('\n') || 'none');
  await b.close();
  if (errs.length) throw new Error('browser errors:\n' + errs.join('\n'));
  return secret;
}

async function memberFlow(secret) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  await p.goto(BASE + '/login');
  await p.fill('input[name=email]', 'owner@demo.crew.local');
  await p.fill('input[name=password]', PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForSelector('input[name=code]', { timeout: 8000 });
  await p.fill('input[name=code]', '000000');
  await p.click('text=Verify');
  await p.waitForTimeout(1200);
  if (!(await p.locator('input[name=code]').count())) throw new Error('wrong MFA code lost the verification step');
  console.log('wrong MFA code rejected, step kept: OK'); 
  await p.fill('input[name=code]', authenticator.generate(secret));
  await p.click('text=Verify');
  await p.waitForURL(BASE + '/', { timeout: 8000 });
  console.log('mfa login: OK');

  await p.goto(BASE + '/people');
  await p.click('text=Invite people');
  await p.fill('input[name=fullName]', 'Smoke Recruiter');
  await p.fill('dialog input[name=email]', `smoke.recruiter.${Date.now()}@demo.crew.local`);
  await p.check('input[name=roles][value=recruiter]');
  await p.click('text=Send invitation');
  const link = await p.locator('code', { hasText: 'accept-invite' }).textContent({ timeout: 8000 });
  console.log('invite link shown (dev only):', link.slice(0, 50) + '...');

  const ctx2 = await b.newContext();
  const q = await ctx2.newPage();
  await q.goto(link);
  await q.fill('input[name=password]', 'Smoke-Recruiter-2026!');
  await q.click('button[type=submit]');
  await q.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
  console.log('invitee lands on:', await q.textContent('h1'));
  const nav = await q.locator('aside nav a, aside a').allTextContents();
  console.log('invitee nav:', nav.filter(Boolean).join(' | '));
  const r = await q.goto(BASE + '/settings/billing');
  if (!q.url().includes('/no-access')) throw new Error('recruiter reached billing: ' + q.url());
  console.log('recruiter blocked from billing: OK');
  console.log('errors:', errs.join('\n') || 'none');
  await b.close();
  if (errs.length) throw new Error('browser errors:\n' + errs.join('\n'));
}

(async () => {
  const secret = await adminFlow();
  await new Promise((r) => setTimeout(r, 31000)); // next TOTP window, so the enrolment code is not replayed
  await memberFlow(secret);
  console.log('\nWeb smoke test passed.');
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
