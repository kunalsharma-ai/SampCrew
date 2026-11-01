/**
 * Integrations end-to-end flow in the Web Portal, against the demo workspace. This script runs its own local
 * receivers: a webhook receiver on 4021 and a SLACK TEST STUB on 4020 that stands in for hooks.slack.com (no
 * real Slack workspace is called). The API must be started with:
 *
 *   pnpm db:reset                          # fresh demo workspace (the owner must not have MFA yet)
 *   INTEGRATIONS_ALLOW_PRIVATE_URLS=true SLACK_WEBHOOK_BASE_URL=http://localhost:4020 node apps/api/dist/main.js &
 *   pnpm --filter @crew/web start &
 *   node e2e/integrations-flow.cjs
 *
 * 1. The owner enrols two-step verification and opens Integrations: three connectors are available, the rest are
 *    marked planned with nothing to connect.
 * 2. The owner creates a read-only API key (shown once). It reads employees through the API, is refused a route
 *    outside its scope, and stops working the moment it is revoked.
 * 3. The owner adds a webhook endpoint (secret shown once) and sends a test event: the receiver gets it, the
 *    signature checks out with the secret, and the delivery log shows it as delivered with its attempt.
 * 4. The owner connects a Slack channel (CREW posts a confirmation first) and sends a test message.
 * 5. The owner builds a workflow in Automation Studio that posts to Slack and sends to the webhook when someone
 *    applies for leave, tests it and activates it. The operator applies for leave: Slack gets the message with the
 *    employee's name filled in, the receiver gets both the leave.requested event and the workflow's message, and
 *    disconnecting Slack is refused while the workflow uses it.
 * Fails on any browser error.
 */
const { createHmac } = require('node:crypto');
const http = require('node:http');
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const API = (process.env.CREW_API_URL ?? 'http://localhost:4000') + '/api/v1';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(`${who} ${m.text()}`));
  p.on('dialog', (d) => d.accept());
};

/** Records every POST; answers 200 unless told otherwise. */
function receiver(port) {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ url: req.url, headers: req.headers, body });
      if (req.url.endsWith('/gone')) return res.writeHead(404).end('no_service');
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ got, server })));
}

const verify = (secret, header, body) => {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  return Boolean(m) && createHmac('sha256', secret).update(`${m[1]}.${body}`).digest('hex') === m[2] && Math.abs(Date.now() / 1000 - Number(m[1])) < 300;
};

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
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

async function enrolMfa(p) {
  await p.goto(BASE + '/settings/security');
  await p.click('text=Set up two-step verification');
  const secret = (await p.locator('code').first().textContent()).trim();
  await p.fill('input[name=code]', authenticator.generate(secret));
  await p.click('text=Turn on');
  await p.waitForSelector('text=/two-step verification is on/i', { timeout: 8000 });
}

async function api(token, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}
async function apiLogin(email) {
  const r = await api(null, 'POST', '/auth/login', { email, password: PASSWORD });
  if (r.body?.status !== 'ok') throw new Error(`${email} needs ${r.body?.status ?? r.status} to sign in through the API; run on a fresh database (pnpm db:reset)`);
  return r.body.accessToken;
}

/** Two consecutive weekdays at least two weeks ahead (clear of the demo's pending request), in this year. */
function leaveDays() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 14);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  const from = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 1);
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) throw new Error('Run this test before late December (leave must fall in the current year)');
  return [from, d.toISOString().slice(0, 10)];
}

const until = async (what, fn, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};

(async () => {
  const slack = await receiver(4020);
  const hook = await receiver(4021);
  const b = await chromium.launch();
  let current;
  const stamp = Date.now();
  try {
    const arjunTok = await apiLogin('operator1@demo.crew.local');

    // 1. Marketplace.
    const owner = current = await signIn(b, 'owner@demo.crew.local');
    await enrolMfa(owner);
    await owner.goto(BASE + '/settings/integrations');
    for (const k of ['webhooks', 'api_keys', 'slack']) await owner.getByTestId(`connector-${k}`).waitFor();
    if ((await owner.getByText('Planned', { exact: true }).count()) < 7) throw new Error('expected the planned connectors to be marked as planned');
    if (await owner.getByText('Microsoft Teams').locator('xpath=ancestor::a').count()) throw new Error('a planned connector should not be clickable');
    ok('Integrations lists webhooks, API keys and Slack as available and the other connectors as planned, with nothing to connect');

    // 2. API key.
    await owner.getByTestId('connector-api_keys').click();
    await owner.getByRole('heading', { name: 'API keys' }).waitFor();
    await owner.click('button:has-text("Create key")');
    await owner.getByLabel(/^Name/).fill(`Directory sync ${stamp}`);
    await owner.getByRole('checkbox', { name: /^employees:read/ }).check();
    await owner.getByRole('checkbox', { name: /^org:read/ }).check();
    await owner.getByRole('dialog').getByRole('button', { name: 'Create key' }).click();
    const key = (await owner.getByTestId('secret-value').textContent({ timeout: 10000 })).trim();
    if (!/^crew_[a-z0-9]{10}_/.test(key)) throw new Error(`unexpected key format: ${key.slice(0, 16)}`);
    const read = await api(key, 'GET', '/employees');
    if (read.status !== 200) throw new Error(`the key should read employees, got ${read.status}`);
    const outside = await api(key, 'GET', '/leave/requests');
    if (outside.status !== 403) throw new Error(`the key should be refused leave requests, got ${outside.status}`);
    const write = await api(key, 'POST', '/org/departments', { name: 'Sneaky', code: 'SNK' });
    if (write.status !== 403) throw new Error(`the key should be refused writes, got ${write.status}`);
    await owner.click('text=I have stored it');
    if (await owner.getByTestId('secret-value').count()) throw new Error('the key is still on screen');
    const row = owner.locator('tr', { hasText: `Directory sync ${stamp}` });
    await row.getByText(/2 calls|3 calls/).waitFor({ timeout: 10000 }).catch(async () => { await owner.reload(); await row.getByText(/calls/).waitFor(); });
    await row.getByRole('button', { name: 'Revoke' }).click();
    await row.getByText('Revoked').waitFor();
    if ((await api(key, 'GET', '/employees')).status !== 401) throw new Error('a revoked key should be refused');
    ok('the owner created a read-only API key shown once; it read employees, was refused leave and writes, and stopped working when revoked');

    // 3. Webhook endpoint.
    await owner.goto(BASE + '/settings/integrations/webhooks');
    await owner.click('button:has-text("Add endpoint")');
    await owner.getByLabel(/^Name/).fill(`Leave sync ${stamp}`);
    await owner.getByLabel(/^Address/).fill('http://127.0.0.1:4021/crew');
    await owner.getByRole('checkbox', { name: /Someone applies for leave/ }).check();
    await owner.getByRole('dialog').getByRole('button', { name: 'Add endpoint' }).click();
    const secret = (await owner.getByTestId('secret-value').textContent({ timeout: 10000 })).trim();
    if (!secret.startsWith('whsec_')) throw new Error('expected a whsec_ signing secret');
    await owner.click('text=I have stored it');
    await owner.waitForURL(/\/settings\/integrations\/webhooks\/[0-9a-f-]{36}$/);
    await owner.click('button:has-text("Send test event")');
    const test = await until('the test event to arrive', async () => hook.got.find((g) => g.headers['crew-event'] === 'webhook.test'));
    if (!verify(secret, test.headers['crew-signature'], test.body)) throw new Error('the test event signature did not verify with the secret');
    await until('the delivery to show as delivered', async () => {
      await owner.reload();
      return (await owner.locator('tr', { hasText: 'webhook.test' }).getByText('Succeeded').count()) > 0;
    });
    await owner.locator('a', { hasText: 'webhook.test' }).first().click();
    await owner.getByText('HTTP 200').waitFor();
    await owner.getByText('What was sent').waitFor();
    const endpointUrl = (await owner.locator('a', { hasText: `Leave sync ${stamp}` }).getAttribute('href'));
    ok('the owner added a webhook endpoint (secret shown once); the test event arrived signed and the delivery log shows the attempt');

    // 4. Slack.
    await owner.goto(BASE + '/settings/integrations/slack');
    await owner.getByLabel(/^Name/).fill('#people-team');
    await owner.getByLabel(/^Incoming webhook URL/).fill('https://hooks.slack.com/services/T0DEMO1/B0DEMO1/e2eToken123');
    await owner.click('text=Connect and post confirmation');
    await owner.getByText(/Slack connected/).waitFor({ timeout: 10000 });
    const confirm = slack.got.find((g) => g.url === '/services/T0DEMO1/B0DEMO1/e2eToken123');
    if (!confirm || !/CREW is now connected/.test(JSON.parse(confirm.body).text)) throw new Error('Slack did not get the confirmation message');
    await owner.click('text=Send test message');
    await owner.getByText('Test message posted').waitFor();
    if (slack.got.length !== 2) throw new Error(`expected two Slack posts so far, got ${slack.got.length}`);
    if (await owner.getByText('e2eToken123').count()) throw new Error('the full Slack webhook URL is on screen');
    ok('the owner connected a Slack channel (confirmation posted first) and sent a test message; the webhook URL is not shown back');

    // 5. Workflow that posts to Slack and sends to the webhook.
    await owner.goto(BASE + '/automation/new');
    await owner.getByRole('textbox', { name: /^Name/ }).fill(`Tell the team about leave ${stamp}`);
    await owner.getByLabel('Starts when').selectOption({ label: 'Someone applies for leave' });
    await owner.click('button:has-text("+ Post to Slack")');
    await owner.getByLabel(/^Message/).first().fill('{{employee.name}} applied for {{leave.days}} days of {{leave.type}}');
    await owner.click('button:has-text("+ Send to a webhook")');
    await owner.getByLabel(/^Message/).nth(1).fill('Leave applied');
    await owner.click('text=Save workflow');
    await owner.waitForURL(/\/automation\/[0-9a-f-]{36}$/, { timeout: 15000 });
    await owner.getByLabel('Employee name').fill('Test Person');
    await owner.getByLabel('Days requested').fill('2');
    await owner.getByLabel('Leave type').fill('Casual leave');
    await owner.click('text=Run test');
    await owner.getByText('Test passed').waitFor({ timeout: 15000 });
    await owner.getByText(/Would post to Slack \(#people-team\): "Test Person applied for 2 days of Casual leave"/).waitFor();
    if (slack.got.length !== 2) throw new Error('a test run must not post to Slack');
    await owner.click('text=Activate version 1');
    await owner.getByText(/Workflow active/).waitFor();
    const workflowUrl = owner.url();

    const types = (await api(arjunTok, 'GET', '/leave/types')).body;
    const cl = (Array.isArray(types) ? types : types.items).find((t) => /^Casual/.test(t.name));
    const [from, to] = leaveDays();
    const req = await api(arjunTok, 'POST', '/leave/requests', { leaveTypeId: cl.id, startDate: from, endDate: to, reason: `Integrations flow ${stamp}` });
    if (req.status >= 300) throw new Error(`leave request failed: ${JSON.stringify(req.body)}`);
    const posted = await until('the workflow to post to Slack', async () => slack.got.find((g) => /Arjun Kulkarni applied for 2 days of Casual leave/.test(JSON.parse(g.body).text)));
    if (!posted) throw new Error('unreachable');
    const leaveEvent = await until('the leave.requested webhook', async () => hook.got.find((g) => g.headers['crew-event'] === 'leave.requested'));
    const lb = JSON.parse(leaveEvent.body);
    if (!verify(secret, leaveEvent.headers['crew-signature'], leaveEvent.body) || lb.data.leaveRequestId !== req.body.id) throw new Error(`unexpected leave.requested webhook: ${leaveEvent.body}`);
    if (/Arjun|Kulkarni/.test(leaveEvent.body)) throw new Error('the leave.requested webhook should carry ids, not names');
    const wf = await until('the workflow webhook', async () => hook.got.find((g) => g.headers['crew-event'] === 'workflow.webhook'));
    const wb = JSON.parse(wf.body);
    if (wb.data.message !== 'Leave applied' || !wb.data.values || wb.data.workflowName !== `Tell the team about leave ${stamp}`) throw new Error(`unexpected workflow webhook: ${wf.body}`);
    await owner.goto(workflowUrl);
    await owner.click('text=All runs');
    await owner.locator('tr', { hasText: 'Arjun Kulkarni' }).first().getByText('Finished').waitFor({ timeout: 15000 });
    await owner.goto(BASE + endpointUrl);
    await owner.locator('tr', { hasText: 'leave.requested' }).getByText('Succeeded').waitFor();
    await owner.goto(BASE + '/settings/integrations/slack');
    await owner.click('button:has-text("Log")');
    await owner.getByRole('cell', { name: 'workflow', exact: true }).waitFor();
    await owner.click('text=Disconnect');
    await owner.getByText(/posts through this connection/).waitFor();
    ok('the owner built, tested and activated a workflow; the operator\'s leave posted to Slack with their name, both webhooks arrived signed, and Slack cannot be disconnected while the workflow uses it');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('ALL PASSED');
  } catch (e) {
    if (current) await current.screenshot({ path: 'integrations-failure.png', fullPage: true }).catch(() => undefined);
    console.error(e);
    if (errs.length) console.error(errs.join('\n'));
    process.exitCode = 1;
  } finally {
    await b.close();
    slack.server.close();
    hook.server.close();
  }
})();
