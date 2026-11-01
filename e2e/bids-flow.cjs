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
 * 5. The recruiter marks it won; the list shows it as won with a 100% win rate, after a reload.
 */
const { chromium } = require('playwright');

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
let current;

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

    // 5. Won.
    await rec.getByRole('button', { name: 'Mark won' }).click();
    await rec.getByRole('dialog').getByLabel('Notes').fill('Signed for 12 months.');
    await rec.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await rec.getByText('Marked as won').waitFor();
    await rec.goto(BASE + '/staffing/bids');
    await rec.reload();
    const row = rec.getByRole('row', { name: /10 Warehouse associates for Northwind Logistics/ });
    await row.getByText('Won').waitFor();
    await rec.getByText('100%').waitFor();
    ok('bid won; the list shows it after a reload with a 100% win rate');

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
