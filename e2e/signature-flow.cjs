/**
 * Email signatures for Outlook, in a real browser, with the Windows sync simulated against the real API.
 *
 *   pnpm db:reset            # demo workspace
 *   API on :4000, Web Portal on :3000, then: pnpm e2e:signature
 *
 * 1. HR sets the company signature details, uploads the logo and checks the company preview.
 * 2. An employee sees the 20 designs with their own details, picks one, customises it and sees the live preview.
 * 3. They save it and download the setup file for their computer.
 * 4. The setup file's token is used exactly as the Windows sync uses it: install, report, check again (unchanged),
 *    then a change in SampCrew reaches the computer at its next check.
 * 5. The employee sees the computer as up to date, then disconnects it, and the computer is refused.
 * 6. HR sees the employee's design and computer in the company overview.
 * Fails on any browser error.
 */
const fs = require('node:fs');
const { chromium } = require('playwright');
const zlib = require('node:zlib');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD');

const ok = (m) => console.log(`ok - ${m}`);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource.*40[134]/.test(m.text()) && errs.push(`${who} ${m.text()}`));
};

/** A real 300x100 PNG in one colour, so the logo has proportions Outlook must keep. */
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function signIn(page, email) {
  // Sign-in is rate limited per address (10 a minute); earlier flows in the same run can use that up.
  for (let attempt = 1; ; attempt++) {
    await page.goto(BASE + '/login');
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

const agent = (token) => ({
  sync: (body) => fetch(`${API}/api/v1/signature-agent/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  report: (body) => fetch(`${API}/api/v1/signature-agent/report`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  image: (path) => fetch(`${API}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } }),
});

(async () => {
  const b = await chromium.launch();
  const stamp = Date.now() % 100000;
  let current;
  try {
    // 1. HR: company details and logo.
    const hrCtx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const hr = await hrCtx.newPage();
    current = hr;
    watch(hr, 'hr');
    await signIn(hr, 'hr.admin@demo.crew.local');
    await hr.goto(BASE + '/settings/signature/company');
    await hr.getByRole('heading', { name: 'Company email signature' }).waitFor();
    await hr.getByLabel('Company name').fill(`Northwind Demo ${stamp}`);
    await hr.getByLabel('Website').fill('https://northwind.example');
    await hr.getByLabel('Disclaimer').fill('Confidential: for the named recipient only.');
    await hr.getByLabel('LinkedIn').fill('https://www.linkedin.com/company/northwind-demo');
    await hr.getByRole('button', { name: 'Save company settings' }).click();
    await hr.getByText('Company signature settings saved.').waitFor();
    const company = hr.getByRole('img', { name: 'Company signature preview' });
    expect((await company.innerText()).includes(`Northwind Demo ${stamp}`), 'company preview shows the company name');
    await hr.getByLabel('Choose signature logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png(300, 100, [31, 58, 147]) });
    await hr.getByText('Logo saved.').waitFor();
    await hr.getByRole('img', { name: 'Company signature logo' }).waitFor();
    await company.locator('img').first().waitFor();
    ok('HR saves company details and a logo, and the company preview uses them');

    // 2. Employee: 20 designs with their own details, pick and customise.
    const empCtx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const emp = await empCtx.newPage();
    current = emp;
    watch(emp, 'employee');
    await signIn(emp, 'operator1@demo.crew.local');
    await emp.goto(BASE + '/settings/signature');
    await emp.getByRole('heading', { name: 'Email signature' }).waitFor();
    const designs = emp.getByRole('radiogroup', { name: 'Signature designs' }).getByRole('radio');
    expect((await designs.count()) === 20, `20 designs are offered, got ${await designs.count()}`);
    expect((await emp.getByRole('img', { name: 'Bold name preview' }).innerText()).includes('Arjun Kulkarni'), 'designs are shown with the person\'s own name');
    await emp.getByTestId('design-banner').click();
    expect((await emp.getByTestId('design-banner').getAttribute('aria-checked')) === 'true', 'banner design is selected');
    await emp.getByText('Not saved').waitFor();
    const tagline = `Quality first, every shift ${stamp}`;
    await emp.getByLabel('Tagline').fill(tagline);
    await emp.getByLabel('Pronouns').fill('he/him');
    await emp.getByLabel('Main colour', { exact: true }).fill('#0E7C66');
    await emp.getByLabel('Font').selectOption('Calibri');
    const preview = emp.getByRole('img', { name: 'Your signature' });
    await emp.waitForFunction((t) => document.querySelector('[aria-label="Your signature"]')?.textContent?.includes(t), tagline);
    const html = await preview.innerHTML();
    expect(/Calibri/.test(html) && /#0E7C66/i.test(html), 'preview uses the chosen font and colour');
    expect((await preview.innerText()).includes(`Northwind Demo ${stamp}`), 'preview uses the company name HR set');
    expect((await preview.innerText()).includes('he/him'), 'preview shows the pronouns');
    await preview.locator('img[src^="/signature-logo"]').waitFor();
    // A bad link is caught before saving and the preview keeps the last good version.
    await emp.getByLabel('X', { exact: true }).fill('not a link');
    await emp.getByText('Start the address with https://').waitFor();
    expect((await preview.innerText()).includes(tagline), 'preview survives a half-typed link');
    await emp.getByLabel('X', { exact: true }).fill('https://x.com/arjun');
    await emp.getByText('Start the address with https://').waitFor({ state: 'detached' });
    await emp.getByText('Only when I click "Sync SampCrew signature" on my desktop').click();
    ok('employee picks one of 20 designs, customises it and sees the live preview');

    // 3. Save and download the setup file.
    await emp.getByRole('button', { name: 'Save signature' }).click();
    await emp.getByText('Your signature is saved.').waitFor();
    await emp.getByText('Saved', { exact: true }).waitFor();
    await emp.getByLabel('Name this computer').fill('Office laptop');
    const [download] = await Promise.all([emp.waitForEvent('download'), emp.getByRole('button', { name: 'Download setup file' }).click()]);
    expect(download.suggestedFilename() === 'SampCrew-Outlook-Signature-Setup.cmd', `setup file name, got ${download.suggestedFilename()}`);
    const installer = fs.readFileSync(await download.path(), 'utf8');
    expect(installer.startsWith('@echo off\r\n') && installer.includes('##PS-BEGIN SampCrew signature sync'), 'setup file is the Windows batch + PowerShell installer');
    expect(!/\n(?<!\r\n)/.test(installer.replace(/\r\n/g, '')), 'setup file uses Windows line ends');
    const token = installer.match(/\$Token = '(scsig_[A-Za-z0-9_-]+)'/)?.[1];
    expect(token, 'setup file carries the computer token');
    await emp.getByTestId('computer-row').filter({ hasText: 'Office laptop' }).getByText('Waiting for setup').waitFor();
    ok('employee saves and downloads the setup file; the computer is listed as waiting');

    // 4. The Windows sync, as the setup file runs it.
    const pc = agent(token);
    let r = await pc.sync({ trigger: 'install', computerName: 'ARJUN-LAPTOP', outlookVersions: ['15.0'], agentVersion: '1.0.0' });
    expect(r.status === 200, `install sync ${r.status}`);
    let body = await r.json();
    expect(body.status === 'update' && body.mode === 'manual' && body.name === 'SampCrew', `install gets the signature in manual mode: ${JSON.stringify({ ...body, html: undefined, text: undefined })}`);
    const logoTag = body.html.match(/<img [^>]*SampCrew_files\/logo\.png[^>]*>/)?.[0] ?? '';
    const [, w, h] = logoTag.match(/width="(\d+)" height="(\d+)"/) ?? [];
    expect(body.html.includes(tagline) && Number(w) === Number(h) * 3, `Outlook HTML has the tagline and the logo file at its 3:1 proportions: ${logoTag}`);
    expect(body.text.includes('Arjun Kulkarni') && body.text.includes('\r\n'), 'plain-text version for Outlook');
    expect(body.images.some((i) => i.name === 'logo.png'), 'logo is listed for download');
    const logo = await pc.image(body.images.find((i) => i.name === 'logo.png').path);
    expect(logo.status === 200 && logo.headers.get('content-type') === 'image/png', 'computer downloads the logo');
    r = await pc.report({ version: body.version, ok: true, outlookVersions: ['15.0'] });
    expect(r.status === 200, `report ${r.status}`);
    r = await pc.sync({ currentVersion: body.version, trigger: 'scheduled' });
    expect((await r.json()).status === 'unchanged', 'next check finds nothing new');
    ok('setup file installs the signature for Outlook and reports back; the next check is unchanged');

    // 5. The employee sees it up to date; a change reaches the computer; then they disconnect it.
    await emp.reload();
    const row = emp.getByTestId('computer-row').filter({ hasText: 'Office laptop' });
    await row.getByText('Up to date').waitFor();
    expect((await row.innerText()).includes('ARJUN-LAPTOP') && (await row.innerText()).includes('Outlook 15.0'), 'computer row shows the Windows name and Outlook version');
    await emp.getByLabel('Tagline').fill(`${tagline} (updated)`);
    await emp.getByRole('button', { name: 'Save signature' }).click();
    await emp.getByText('Your signature is saved.').waitFor();
    await row.getByText('Update pending').waitFor();
    r = await pc.sync({ currentVersion: body.version, trigger: 'manual' });
    const next = await r.json();
    expect(next.status === 'update' && next.html.includes(`${tagline} (updated)`), 'a change in SampCrew reaches the computer at its next sync');
    await pc.report({ version: next.version, ok: true });
    await emp.getByRole('button', { name: 'Sync my computers' }).click();
    await emp.getByText('Click "Sync SampCrew signature" on your desktop to update Outlook now.').waitFor();
    r = await pc.sync({ currentVersion: next.version, trigger: 'scheduled' });
    expect((await r.json()).status === 'update', '"Sync my computers" makes the computer install it again');
    await pc.report({ version: next.version, ok: true });
    ok('changes and "Sync my computers" reach the computer');

    // 6. HR overview.
    await hr.goto(BASE + '/settings/signature/company');
    const person = hr.getByRole('table', { name: 'People and their signatures' }).getByRole('row').filter({ hasText: 'Arjun Kulkarni' });
    await person.waitFor();
    const text = await person.innerText();
    expect(text.includes('Banner') && text.includes('Manual') && text.includes('Office laptop (ARJUN-LAPTOP)'), `overview row: ${text}`);
    ok('HR sees the employee\'s design, sync choice and computer');

    // Disconnect: the computer is refused from then on.
    await emp.reload();
    await row.getByRole('button', { name: 'Disconnect' }).click();
    await emp.getByText('Computer disconnected.').waitFor();
    await row.waitFor({ state: 'detached' });
    r = await pc.sync({ trigger: 'scheduled' });
    expect(r.status === 401, `disconnected computer is refused, got ${r.status}`);
    ok('a disconnected computer can no longer get the signature');

    if (errs.length) throw new Error('Browser errors:\n' + errs.join('\n'));
    console.log('signature flow passed');
  } catch (e) {
    console.error(e);
    if (current) await current.screenshot({ path: '/tmp/signature-fail.png', fullPage: true }).catch(() => {});
    if (errs.length) console.error(errs.join('\n'));
    process.exitCode = 1;
  } finally {
    await b.close();
  }
})();
