/**
 * Installation-wide integrations set up from the Super Admin Console, end to end through a real browser, with no
 * change to the server's environment. The flow runs its own stand-ins: a Claude Messages API stub on 4040 and an SMTP
 * server on 4041 (no real model or mail provider is called).
 *
 *   pnpm db:reset            # fresh demo workspace and bootstrap console admin (neither may have MFA yet)
 *   API on :4000 (started without AI or SMTP settings), Web Portal on :3000, Console on :3001, then:
 *   pnpm e2e:platform-integrations
 *
 * 1. The console admin enrols MFA and opens Integrations: Claude AI and Email are "Not set up".
 * 2. Claude AI: a wrong key fails the connection test with a plain reason; the right key passes; AI is switched on
 *    and saved. After a reload the key is shown only as its last characters.
 * 3. Email: the SMTP test signs in and delivers a real test email; email is switched on and saved.
 * 4. Virus scanning: a scanner that is not running fails the test, and nothing is saved.
 * 5. Web Portal: the owner's Settings > Integrations shows Claude AI and Email as on, provided by SAMPLEDGE, and
 *    Settings > AI says AI is connected. An invitation the owner sends is delivered through the SMTP settings saved
 *    in the Console.
 */
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const { SMTPServer } = require(require.resolve('smtp-server', { paths: [path.join(__dirname, '../apps/api')] }));

const CONSOLE = process.env.CONSOLE_URL ?? 'http://localhost:3001';
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !PASSWORD) throw new Error('Set CREW_BOOTSTRAP_ADMIN_EMAIL, CREW_BOOTSTRAP_ADMIN_PASSWORD and CREW_DEMO_PASSWORD (source .env)');
const AI_PORT = 4040;
const SMTP_PORT = 4041;
const GOOD_KEY = 'sk-ant-e2e-stub-key-7788';

const ok = (m) => console.log(`ok - ${m}`);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());
const errs = [];
const watch = (page) => {
  page.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
};

// TEST STUB, not an AI model: answers "OK" for GOOD_KEY and 401 for anything else.
const aiCalls = [];
const ai = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const key = req.headers['x-api-key'] ?? (req.headers.authorization ?? '').replace(/^Bearer /, '');
    aiCalls.push(key);
    res.setHeader('content-type', 'application/json');
    if (key !== GOOD_KEY) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    }
    const body = JSON.parse(raw || '{}');
    res.end(JSON.stringify({ id: 'msg_e2e', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 10, output_tokens: 1 } }));
  });
});

const mails = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, session, cb) {
    let body = '';
    stream.on('data', (c) => (body += c.toString()));
    stream.on('end', () => {
      mails.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), body });
      cb();
    });
  },
});

async function waitFor(fn, msg, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(msg);
}

async function card(page, key) {
  const c = page.getByTestId(`integration-${key}`);
  await c.waitFor();
  if ((await c.locator('button[aria-expanded]').getAttribute('aria-expanded')) !== 'true') await c.locator('button[aria-expanded]').click();
  return c;
}

async function switchOn(c, key) {
  const sw = c.getByTestId(`${key}-enabled`);
  if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
}

(async () => {
  await new Promise((r) => ai.listen(AI_PORT, '127.0.0.1', r));
  await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));
  const b = await chromium.launch();
  const admin = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const owner = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [admin, owner]) watch(p);
  let current = admin;
  try {
    // 1. Console sign-in with mandatory MFA, then Integrations.
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
    await admin.getByRole('link', { name: 'Integrations' }).click();
    await admin.waitForURL(/\/integrations$/);
    await admin.getByRole('heading', { name: 'Integrations' }).waitFor();
    for (const key of ['ai', 'email', 'push', 'scanning', 'mobile_sso']) await admin.getByTestId(`integration-${key}`).waitFor();
    await admin.getByTestId('integration-ai').getByText('Not set up', { exact: true }).waitFor();
    await admin.getByTestId('integration-email').getByText('Not set up', { exact: true }).waitFor();
    await shot(admin, 'console-integrations');
    ok('console admin opens Integrations; Claude AI and Email are not set up');

    // 2. Claude AI: wrong key, right key, switch on, save.
    let c = await card(admin, 'ai');
    await c.getByText('How to set it up').waitFor();
    await c.getByTestId('ai-apiKey').fill('sk-ant-wrong-key-0000');
    await c.getByTestId('ai-baseUrl').fill(`http://127.0.0.1:${AI_PORT}`);
    await c.getByRole('button', { name: 'Test connection' }).click();
    await c.getByText('Connection failed').waitFor({ timeout: 20000 });
    expect(/API key was refused/.test(await c.getByTestId('ai-test-result').textContent()), 'a wrong key should say it was refused');
    await c.getByTestId('ai-apiKey').fill(GOOD_KEY);
    await c.getByRole('button', { name: 'Test connection' }).click();
    await c.getByText('Connection works').waitFor({ timeout: 20000 });
    expect(/Claude answered using claude-opus-5-5/.test(await c.getByTestId('ai-test-result').textContent()), 'the right key should pass');
    await shot(admin, 'console-integrations-ai-test');
    await switchOn(c, 'ai');
    await c.getByRole('button', { name: 'Save' }).click();
    await c.getByText('Saved. CREW uses these settings from now on.').waitFor({ timeout: 15000 });
    await admin.reload();
    c = admin.getByTestId('integration-ai');
    await c.getByText('Set in Console', { exact: true }).waitFor();
    await c.getByText('On', { exact: true }).waitFor();
    c = await card(admin, 'ai');
    const placeholder = await c.getByTestId('ai-apiKey').getAttribute('placeholder');
    expect(placeholder === 'Saved ••••7788', `the key should only show its last characters, got ${placeholder}`);
    expect(!(await admin.content()).includes(GOOD_KEY), 'the full key must never reach the browser');
    ok('Claude AI: a wrong key fails with a plain reason, the right key passes, and it is saved and switched on');

    // 3. Email over SMTP, with a real test message.
    c = await card(admin, 'email');
    await c.getByTestId('email-host').fill('127.0.0.1');
    await c.getByTestId('email-security').selectOption('none');
    await c.getByTestId('email-port').fill(String(SMTP_PORT));
    await c.getByTestId('email-from').fill('CREW <no-reply@sampledge.test>');
    await c.getByTestId('email-sendTo').fill('ops@sampledge.test');
    await c.getByRole('button', { name: 'Test connection' }).click();
    await c.getByText('Connection works').waitFor({ timeout: 20000 });
    await waitFor(() => mails.some((m) => m.to === 'ops@sampledge.test' && m.body.includes('CREW test email')), 'the test email did not arrive');
    await switchOn(c, 'email');
    await c.getByRole('button', { name: 'Save' }).click();
    await c.getByText('Saved. CREW uses these settings from now on.').waitFor({ timeout: 15000 });
    await shot(admin, 'console-integrations-email');
    ok('Email: the SMTP test delivered a real message, and email is saved and switched on');

    // 4. A scanner that is not running fails the test.
    c = await card(admin, 'scanning');
    await c.getByTestId('scanning-url').fill('tcp://127.0.0.1:4049');
    await c.getByRole('button', { name: 'Test connection' }).click();
    await c.getByText('Connection failed').waitFor({ timeout: 20000 });
    await admin.reload();
    await admin.getByTestId('integration-scanning').getByText('Not set up', { exact: true }).waitFor();
    ok('Virus scanning: an unreachable scanner fails the test and nothing is saved');

    // 5. The Web Portal sees the services as on, and email really goes out with the Console settings.
    current = owner;
    for (let attempt = 1; ; attempt++) {
      await owner.goto(WEB + '/login');
      await owner.fill('input[name=email]', 'owner@demo.crew.local');
      await owner.fill('input[name=password]', PASSWORD);
      await owner.click('button[type=submit]');
      const r = await Promise.race([
        owner.waitForURL((u) => u.pathname === '/', { timeout: 15000 }).then(() => 'in'),
        owner.locator('text=Too many requests').waitFor({ timeout: 15000 }).then(() => 'limited'),
      ]);
      if (r === 'in') break;
      if (attempt >= 4) throw new Error('sign-in stayed rate limited');
      await owner.waitForTimeout(20000);
    }
    await owner.goto(WEB + '/settings/security');
    await owner.click('text=Set up two-step verification');
    const s2 = (await owner.locator('code').first().textContent()).trim();
    await owner.fill('input[name=code]', authenticator.generate(s2));
    await owner.click('text=Turn on');
    await owner.waitForSelector('text=/two-step verification is on/i', { timeout: 8000 });
    await owner.goto(WEB + '/settings/integrations');
    await owner.getByRole('heading', { name: 'Provided by SAMPLEDGE' }).waitFor();
    await owner.getByTestId('platform-ai').getByText('On', { exact: true }).waitFor();
    await owner.getByTestId('platform-email').getByText('On', { exact: true }).waitFor();
    await owner.getByTestId('platform-scanning').getByText('Off', { exact: true }).waitFor();
    await shot(owner, 'web-integrations-platform');
    await owner.goto(WEB + '/settings/ai');
    await owner.getByText('Connected for every workspace by SAMPLEDGE.').waitFor();
    const invitee = `console.smtp.${Date.now()}@demo.crew.local`;
    await owner.goto(WEB + '/people');
    await owner.click('text=Invite people');
    await owner.fill('input[name=fullName]', 'Console Smtp');
    await owner.fill('dialog input[name=email]', invitee);
    await owner.check('input[name=roles][value=recruiter]');
    await owner.click('text=Send invitation');
    await waitFor(() => mails.some((m) => m.to === invitee && m.body.includes('accept-invite?token=')), 'the invitation email was not delivered through the Console SMTP settings', 30000);
    ok('Web Portal shows Claude AI and Email as provided by SAMPLEDGE, and an invitation is delivered through the Console SMTP settings');

    expect(aiCalls.filter((k) => k === GOOD_KEY).length >= 1, 'the AI stub should have been called with the saved key');
    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    ok('no browser errors');
  } catch (e) {
    await current.screenshot({ path: 'platform-integrations-failure.png', fullPage: true }).catch(() => undefined);
    console.error(e);
    process.exitCode = 1;
  } finally {
    await b.close();
    ai.close();
    smtp.close();
  }
})();
