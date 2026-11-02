/**
 * Staffing bids, end to end in the Web Portal, against the demo workspace:
 *   pnpm db:reset            # fresh demo workspace (finance@ must not have MFA enrolled yet, so run before e2e:payroll)
 *   API on :4000, Web Portal on :3000, then: pnpm e2e:bids
 *
 * 1. The recruiter adds a client, then makes a Quick Bid: one role, people and pay. The bill rate, margin and
 *    contract value are worked out live from the default template, and the bid is saved and submitted.
 * 2. The proposal PDF opens from the bid; the recruiter cannot send it before Finance approves.
 * 3. Finance opens the bid, sees the margin in the approval summary and approves it on the bid page.
 * 4. The recruiter schedules the proposal email for tomorrow, cancels it, then sends it now: the bid is Sent,
 *    version 1 is in the history with its PDF.
 * 5. The client opens their private link from the email (no sign-in), sees roles, rates and totals but no costs,
 *    signs with their typed name and accepts. The cc recipient's link then says it has been answered. The bid is
 *    Won with the signer on it and a signed copy of the PDF; the list shows a 100% win rate, after a reload.
 *    (The email is read from the mail queue in the database, so DATABASE_ADMIN_URL must be set.)
 * 6. The recruiter keeps a rate card for the client, starts an Advanced Bid from it (typing a role fills its rates),
 *    bills one role below the card and sees it flagged, adds a one-off recruitment fee, and the saved bid shows
 *    the fee in the contract value and the warning, after a reload.
 */
const path = require('node:path');
const { chromium } = require('playwright');
const { Client } = require(require.resolve('pg', { paths: [path.join(__dirname, '../apps/api')] }));

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
let current;
/** Set SHOTS to a folder to save screenshots of the key screens on the way. */
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());

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

const watch = (page) => {
  page.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
};

(async () => {
  const b = await chromium.launch();
  const recruiterCtx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const rec = await recruiterCtx.newPage();
  watch(rec);
  current = rec;
  try {
    await signIn(rec, 'recruiter@demo.crew.local');

    // 1. A client, then a Quick Bid.
    await rec.goto(BASE + '/staffing/clients');
    await rec.getByRole('button', { name: 'New client' }).click();
    const cd = rec.getByRole('dialog');
    await cd.getByLabel(/^Client name/).fill('Northwind Logistics');
    await cd.getByLabel('Legal name').fill('Northwind Logistics Private Limited');
    await cd.getByLabel('Contact person').fill('Meera Iyer');
    await cd.getByLabel('Contact email').fill('meera.iyer@northwind.example');
    await cd.getByRole('button', { name: 'Add client' }).click();
    await rec.getByRole('cell', { name: /Northwind Logistics/ }).first().waitFor();
    ok('recruiter added a client');

    await rec.goto(BASE + '/staffing/bids');
    await rec.getByRole('link', { name: 'Quick Bid' }).click();
    await rec.waitForURL(/\/staffing\/bids\/new\?mode=quick/);
    expect(await rec.getByRole('radio', { name: 'Quick Bid' }).getAttribute('aria-checked') === 'true', 'Quick Bid mode not selected');
    await rec.getByLabel(/^Client( \*)?$/).selectOption({ label: 'Northwind Logistics' });
    await rec.getByLabel(/^Role( \*)?$/).fill('Warehouse associate');
    await rec.getByLabel(/^People( \*)?$/).fill('10');
    await rec.getByLabel('Location').fill('Pune');
    await rec.getByLabel(/^Monthly pay per person/).fill('25000');
    const summary = rec.getByRole('complementary', { name: 'Bid summary' });
    // 25000 x 1.18 = 29500 loaded; / 0.82 = 35975.61, rounded up to 35976 per person; x10 x12 months.
    await summary.getByText('INR 3,59,760').waitFor();
    await summary.getByText('INR 43,17,120').waitFor();
    await summary.getByText(/^18\.\d\d% \(target 18(\.00)?%\)$/).waitFor();
    expect(await summary.getByRole('heading').innerText() === '10 Warehouse associates for Northwind Logistics', 'title was not filled in from the role and client');
    ok('quick bid priced live from the default template');
    await summary.getByRole('button', { name: 'Save and submit for approval' }).click();
    await rec.waitForURL(/\/staffing\/bids\/[0-9a-f-]{36}$/);
    const bidUrl = rec.url();
    const bidId = bidUrl.split('/').pop();
    await rec.getByText('Waiting for approval').first().waitFor();
    await rec.getByText('BID-').first().waitFor();
    expect(await rec.getByRole('button', { name: 'Send proposal' }).count() === 0, 'send offered before approval');
    ok('bid saved and submitted to Finance');

    // 2. The PDF.
    await rec.locator('iframe[title="Proposal preview"]').waitFor();
    const pdf = await rec.request.get(`${BASE}/staffing-pdf/${bidId}`);
    expect(pdf.ok(), `PDF returned ${pdf.status()}`);
    expect(pdf.headers()['content-type'] === 'application/pdf', 'PDF content type');
    const bytes = await pdf.body();
    expect(bytes.subarray(0, 5).toString() === '%PDF-', 'not a PDF');
    ok(`proposal PDF available (${bytes.length} bytes)`);

    // 3. Finance approves from the bid page.
    const finCtx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const fin = await finCtx.newPage();
    watch(fin);
    current = fin;
    await signIn(fin, 'finance@demo.crew.local');
    await fin.goto(bidUrl);
    const approval = fin.getByLabel('Your approval');
    await approval.waitFor();
    expect(/margin 18\.\d\d% \(target 18(\.00)?%\)/.test(await approval.innerText()), 'approval summary has no margin');
    // Finance sees internal costs that the client never does.
    await fin.getByRole('columnheader', { name: 'Loaded cost' }).waitFor();
    await approval.getByRole('textbox', { name: 'Comment' }).fill('Margin is on target.');
    await approval.getByRole('button', { name: 'Approve bid' }).click();
    await fin.getByText('Bid approved').waitFor();
    await fin.getByText('Margin is on target.').first().waitFor();
    ok('finance approved the bid on the bid page');
    await finCtx.close();
    current = rec;

    // 4. Schedule, cancel, send now.
    await rec.reload();
    await rec.getByRole('button', { name: 'Send proposal' }).click();
    let sd = rec.getByRole('dialog');
    expect(await sd.getByLabel(/^To( \*)?$/).inputValue() === 'meera.iyer@northwind.example', 'recipient not filled from the client');
    expect((await sd.getByLabel(/^Message/).inputValue()).startsWith('Dear Meera,'), 'message not addressed to the contact');
    await sd.getByLabel('Schedule for later').check();
    const t = new Date(Date.now() + 24 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    await sd.getByLabel('Send at').fill(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T09:30`);
    await sd.getByRole('button', { name: 'Schedule email' }).click();
    await rec.getByText(/^Email scheduled for/).waitFor();
    await rec.getByText(/^Scheduled for /).waitFor();
    ok('proposal email scheduled');
    await rec.getByRole('button', { name: 'Cancel email' }).click();
    await rec.getByText('Scheduled email cancelled').waitFor();
    await rec.getByText('Cancelled', { exact: true }).waitFor();
    await rec.getByText('Approved', { exact: true }).first().waitFor();
    ok('scheduled email cancelled; the bid is back to approved');

    await rec.getByRole('button', { name: 'Send proposal' }).click();
    sd = rec.getByRole('dialog');
    await sd.getByLabel('Cc').fill('procurement@northwind.example');
    await sd.getByRole('button', { name: 'Send now' }).click();
    await rec.getByText('Proposal sent to meera.iyer@northwind.example and 1 more').waitFor();
    await rec.getByText('Sent', { exact: true }).first().waitFor();
    await rec.getByRole('link', { name: 'PDF of version 1' }).waitFor();
    const sent = await rec.request.get(`${BASE}${await rec.getByRole('link', { name: 'PDF of version 1' }).getAttribute('href')}`);
    expect(sent.ok() && (await sent.body()).subarray(0, 5).toString() === '%PDF-', 'sent version PDF missing');
    ok('proposal sent now; version 1 and its PDF are in the history');

    // 5. The client accepts online. The link is read from the email in the mail queue (as the client would open it
    //    from their inbox); the browser that opens it has no CREW session.
    const link = async (to) => {
      const db = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
      await db.connect();
      try {
        const r = await db.query(`select text_body from email_messages where to_email = $1 and template = 'bid.proposal' and status <> 'cancelled' order by created_at desc limit 1`, [to]);
        const m = r.rows[0]?.text_body.match(/https?:\/\/\S+\/proposal\/[A-Za-z0-9_-]{32}/);
        expect(m, `no acceptance link in the email to ${to}`);
        return m[0].replace(/^https?:\/\/[^/]+/, BASE);
      } finally {
        await db.end();
      }
    };
    const clientCtx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const cl = await clientCtx.newPage();
    watch(cl);
    current = cl;
    await cl.goto(await link('meera.iyer@northwind.example'));
    await cl.getByRole('heading', { name: '10 Warehouse associates for Northwind Logistics' }).waitFor();
    const rates = await cl.getByRole('table', { name: 'Team and rates' }).innerText();
    expect(/Warehouse associate/.test(rates) && /\b10\b/.test(rates), 'roles missing on the client page');
    expect(!/margin|loaded cost|on-cost/i.test(await cl.locator('main').innerText()), 'client page shows internal costs');
    const clientPdf = await cl.request.get(`${cl.url()}/pdf`);
    expect(clientPdf.ok() && (await clientPdf.body()).subarray(0, 5).toString() === "%PDF-", "proposal PDF missing behind the link");
    ok('the client opens the private link without signing in: roles, rates and totals, no costs');

    await cl.getByLabel(/^Your full name/).fill('Meera Iyer');
    await cl.getByLabel(/^Work email/).fill('meera.iyer@northwind.example');
    await cl.getByLabel(/^Job title/).fill('Head of Operations');
    await cl.getByLabel(/^Signature/).fill('M Iyer');
    await cl.getByLabel(/I am authorised to accept/).check();
    await shot(cl, 'design4-client-proposal');
    await cl.getByRole('button', { name: 'Accept and sign' }).click();
    await cl.getByText('Type your full name exactly as above to sign').waitFor();
    await cl.getByLabel(/^Signature/).fill('Meera Iyer');
    await cl.getByRole('button', { name: 'Accept and sign' }).click();
    await cl.getByText('Proposal accepted').waitFor();
    await cl.reload();
    await cl.getByText(/Accepted by Meera Iyer, Head of Operations/).waitFor();
    await shot(cl, 'design4-client-accepted');
    const signedByLink = await cl.request.get(`${cl.url()}/pdf`);
    expect(/signed\.pdf/.test(signedByLink.headers()['content-disposition'] ?? ''), 'the link does not serve the signed copy');
    ok('a wrong signature is refused; the client signs and accepts; after a reload the page says so');

    // The cc recipient's own link now shows the proposal as answered.
    await cl.goto(await link('procurement@northwind.example'));
    await cl.getByText('This proposal has already been answered').waitFor();
    expect(await cl.getByRole('button', { name: 'Accept and sign' }).count() === 0, 'answered proposal still offers to sign');
    ok('the cc recipient sees it has already been answered');

    current = rec;
    await rec.reload();
    const decision = rec.getByRole('region', { name: 'Client decision' }).or(rec.locator('[aria-label="Client decision"]'));
    await decision.getByText('Accepted online by the client').waitFor();
    await shot(rec, 'design4-bid-accepted');
    expect(/Meera Iyer, Head of Operations/.test(await decision.innerText()), 'signer missing on the bid');
    await rec.getByText('Won', { exact: true }).first().waitFor();
    await rec.getByText(/meera\.iyer@northwind\.example: accepted/).waitFor();
    const signed = await rec.request.get(`${BASE}${await decision.getByRole('link', { name: 'Signed copy' }).getAttribute('href')}`);
    expect(signed.ok() && (await signed.body()).subarray(0, 5).toString() === '%PDF-', 'signed copy missing');
    ok('the bid is won, shows who accepted and when, and the signed copy downloads');

    await rec.goto(BASE + '/staffing/bids');
    await rec.reload();
    const row = rec.getByRole('row', { name: /10 Warehouse associates for Northwind Logistics/ });
    await row.getByText('Won').waitFor();
    await rec.getByText('100%').waitFor();
    ok('the list shows it won after a reload with a 100% win rate');

    // 6. A rate card, then an Advanced Bid that uses it with a one-off fee.
    await rec.goto(BASE + '/staffing/rate-cards');
    await rec.getByRole('button', { name: 'New rate card' }).click();
    const rd = rec.getByRole('dialog');
    await rd.getByLabel(/^Name/).fill('Northwind 2027');
    await rd.getByLabel(/^For client/).selectOption({ label: 'Northwind Logistics' });
    await rd.getByLabel('Role 1', { exact: true }).fill('Forklift operator');
    await rd.getByLabel('Pay for role 1').fill('28000');
    await rd.getByLabel('Bill rate for role 1').fill('42000');
    await rd.getByRole('button', { name: 'Add role' }).click();
    await rd.getByLabel('Role 2', { exact: true }).fill('Warehouse associate');
    await rd.getByLabel('Pay for role 2').fill('25000');
    await rd.getByLabel('Bill rate for role 2').fill('38000');
    await rd.getByRole('button', { name: 'Save rate card' }).click();
    await rec.getByText('Northwind 2027 saved').waitFor();
    const cardRows = rec.getByRole('table', { name: 'Rates in Northwind 2027' }).locator('tbody tr');
    expect(await cardRows.count() === 2, 'rate card should list two roles');
    ok('recruiter keeps a rate card for Northwind Logistics with two roles');

    await rec.goto(BASE + '/staffing/bids/new?mode=advanced');
    await rec.getByLabel(/^Client( \*)?$/).selectOption({ label: 'Northwind Logistics' });
    await rec.getByLabel(/^Rate card/).selectOption({ label: 'Northwind 2027 (Northwind Logistics)' });
    const r1 = rec.getByRole('group', { name: 'Role 1' });
    await r1.getByLabel(/^Role( \*)?$/).fill('Forklift operator');
    expect(await r1.getByLabel(/^Monthly pay per person/).inputValue() === '28000', 'typing a card role should fill its pay');
    expect(await r1.getByLabel(/^Bill rate per person/).inputValue() === '42000', 'typing a card role should fill its bill rate');
    await r1.getByLabel(/^People( \*)?$/).fill('4');
    await rec.getByRole('button', { name: 'Add role' }).click();
    const r2 = rec.getByRole('group', { name: 'Role 2' });
    await r2.getByLabel(/^Role( \*)?$/).fill('Warehouse associate');
    await r2.getByLabel(/^Bill rate per person/).fill('36000');
    await r2.getByLabel(/^People( \*)?$/).fill('6');
    await r2.getByText(/Below the rate card \(INR 38,000\.00 per person\)/).waitFor();
    expect(await r1.getByText(/Below the rate card/).count() === 0, 'a role at the card rate should not be flagged');
    await rec.getByRole('button', { name: 'Add fee' }).click();
    const fee = rec.getByRole('group', { name: 'Fee 1' });
    await fee.getByLabel('Fee', { exact: true }).fill('Recruitment drive');
    await fee.getByLabel('Amount').fill('120000');
    await fee.getByLabel(/^Our cost/).fill('45000');
    await fee.getByLabel('Invoiced').selectOption('on_signing');
    const sum2 = rec.getByRole('complementary', { name: 'Bid summary' });
    // 4 x 42000 + 6 x 36000 = 3,84,000 a month; x 12 months + 1,20,000 = 47,28,000.
    await sum2.getByText('INR 3,84,000').waitFor();
    await sum2.getByText('INR 1,20,000').waitFor();
    await sum2.getByText('INR 47,28,000').waitFor();
    await sum2.getByText('1 role is billed below the rate card.').waitFor();
    await sum2.getByRole('button', { name: 'Save draft' }).click();
    await rec.waitForURL(/\/staffing\/bids\/[0-9a-f-]{36}$/);
    await rec.reload();
    await rec.getByText(/1 role is billed below the rate card “Northwind 2027”/).waitFor();
    const fees = await rec.locator('[aria-label="One-off fees"]').innerText();
    expect(/Recruitment drive/.test(fees) && /On signing/.test(fees) && /1,20,000/.test(fees), `fee missing on the bid: ${fees}`);
    await rec.getByText('INR 47,28,000').first().waitFor();
    await shot(rec, 'design6-bid-rate-card');
    ok('advanced bid from the rate card: filled rates, a role below the card flagged, a one-off fee in the contract value');

    const real = errs.filter((e) => !/favicon|DevTools/.test(e));
    expect(!real.length, `browser errors:\n${real.join('\n')}`);
    console.log('bids flow passed');
  } catch (e) {
    console.error(e);
    if (current) await current.screenshot({ path: 'bids-flow-failure.png', fullPage: true }).catch(() => {});
    console.error(errs.join('\n'));
    process.exitCode = 1;
  } finally {
    await b.close();
  }
})();
