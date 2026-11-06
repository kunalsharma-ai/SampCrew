/**
 * SampCrew IQ, end to end in the Web Portal, against the demo workspace:
 *   pnpm db:reset; API on :4000, Web Portal on :3000, then: pnpm e2e:iq
 *
 * 1. The recruiter opens SampCrew IQ from the top bar and asks for the recruitment summary: a table read from their
 *    requisitions, marked "From your records", with how it was answered and a link to the source.
 * 2. Headcount covers only what their own access covers, which for a recruiter is just themselves.
 * 3. They ask IQ to start a staffing proposal for five recruiters: IQ shows a preview, nothing is saved, and the
 *    Quick Bid opens with the role and the number of people filled in.
 * 4. They ask for a draft job description: the requisition form opens with the title and the draft filled in.
 * 5. Ctrl+J opens IQ from anywhere and Escape closes it.
 * 6. The conversation is kept: a follow-up ("What about Talent Acquisition?") continues the last subject, and past
 *    conversations can be reopened and deleted.
 */
const { chromium } = require('playwright');

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const shot = (p, name) => (process.env.SHOTS ? p.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : Promise.resolve());
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  p.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  try {
    for (let attempt = 1; ; attempt++) {
      await p.goto(BASE + '/login');
      await p.fill('input[name=email]', 'recruiter@demo.crew.local');
      await p.fill('input[name=password]', PASSWORD);
      await p.click('button[type=submit]');
      const r = await Promise.race([
        p.waitForURL((u) => u.pathname === '/', { timeout: 15000 }).then(() => 'in'),
        p.locator('text=Too many requests').waitFor({ timeout: 15000 }).then(() => 'limited'),
      ]);
      if (r === 'in') break;
      if (attempt >= 4) throw new Error('sign-in stayed rate limited');
      await p.waitForTimeout(20000);
    }
    const panel = p.getByRole('complementary', { name: 'SampCrew IQ' });
    /** Asks a question and returns its answer card, once it has arrived. */
    const ask = async (q) => {
      const n = await panel.locator('article').count();
      await panel.getByLabel('Ask SampCrew IQ').fill(q);
      await panel.getByRole('button', { name: 'Send question' }).click();
      await panel.locator('article').nth(n).waitFor();
      return panel.locator('article').nth(n);
    };

    // 1. Recruitment summary from the person's own records.
    await p.goto(BASE + '/recruitment');
    await p.getByRole('button', { name: 'SampCrew IQ' }).click();
    await panel.getByRole('list', { name: 'Suggested questions' }).getByRole('button', { name: 'Summarize recruitment performance this quarter' }).click();
    const summary = panel.locator('article').last();
    await summary.getByText('From your records').waitFor();
    expect(await summary.locator('table tbody tr').count() > 0, 'recruitment summary has no rows');
    await summary.getByText('How this was answered').waitFor();
    expect(await summary.getByRole('link', { name: /Recruitment|Requisitions/ }).count() > 0, 'no source link on the recruitment summary');
    await shot(p, 'design4-iq-summary');
    ok('recruitment summary answered from records, with how and a source');

    // 2. Figures outside recruitment cover only what their own access covers: for a recruiter, just themselves.
    const head = await ask('Headcount by department');
    await head.getByText('From your records').waitFor();
    const headTitle = await head.locator('h3').innerText();
    expect(/^(1 person across 1 department|0 people across 0 departments)$/.test(headTitle), `recruiter headcount was "${headTitle}"`);
    ok(`headcount limited to the recruiter's own access ("${headTitle}")`);

    // 2b. A follow-up continues the subject with a department.
    const follow = await ask('What about Talent Acquisition?');
    await follow.getByText(/Read as a follow-up to “Headcount by department”/).waitFor();
    expect(/^1 person in Talent Acquisition$/.test(await follow.locator('h3').innerText()), 'follow-up did not narrow to the department');
    ok('"What about Talent Acquisition?" continued the headcount question');

    // 3. A staffing proposal opens a prefilled Quick Bid; nothing is saved.
    const bid = await ask('Create a staffing proposal for five recruiters');
    const preview = bid.getByLabel('Preview');
    await preview.getByText('Recruiter', { exact: true }).waitFor();
    await shot(p, 'design4-iq-action');
    await preview.getByRole('link', { name: /Open the Quick Bid/ }).click();
    await p.waitForURL(/\/staffing\/bids\/new\?/);
    await p.locator('input[name="lines.0.roleTitle"]').waitFor();
    expect(await p.locator('input[name="lines.0.roleTitle"]').inputValue() === 'Recruiter', 'role not prefilled');
    expect(await p.locator('input[name="lines.0.headcount"]').inputValue() === '5', 'people not prefilled');
    expect(await panel.count() === 0, 'IQ panel stayed open after opening the form');
    ok('Quick Bid opened with 5 Recruiters filled in');

    // 4. A draft job description opens the requisition form.
    await p.keyboard.press('Control+j');
    await panel.waitFor();
    const job = await ask('Prepare a draft job description for a Senior HR Manager');
    await job.getByRole('link', { name: /Open the requisition form/ }).click();
    const dialog = p.locator('dialog[open]').filter({ hasText: 'New requisition' });
    await dialog.waitFor();
    expect(await dialog.locator('input[name=title]').inputValue() === 'Senior HR Manager', 'job title not prefilled');
    expect((await dialog.locator('textarea[name=description]').inputValue()).includes('is looking for a Senior HR Manager'), 'job description not prefilled');
    expect(!new URL(p.url()).searchParams.has('description'), 'prefill left in the address bar');
    await shot(p, 'design4-iq-requisition');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    ok('requisition form opened with the title and draft description');

    // 5. Keyboard.
    await p.keyboard.press('Control+j');
    await panel.waitFor();
    await p.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    ok('Ctrl+J opens IQ and Escape closes it');

    // 6. Past conversations: the questions are kept and can be reopened, and deleted.
    await p.keyboard.press('Control+j');
    await panel.waitFor();
    await panel.getByRole('button', { name: 'New conversation' }).click();
    await panel.getByRole('button', { name: 'Past conversations' }).click();
    const past = panel.locator('[aria-label="Past conversations"]').filter({ has: p.getByRole('list') });
    const convos = past.getByRole('button', { name: /^Summarize recruitment performance this quarter/ });
    await convos.first().waitFor();
    const before = await convos.count();
    await convos.first().click();
    await panel.getByText('What about Talent Acquisition?').waitFor();
    expect(await panel.locator('article').count() >= 4, 'reopened conversation is missing answers');
    await shot(p, 'design5-iq-history');
    ok('the conversation was kept and reopened with its answers');
    await panel.getByRole('button', { name: 'Past conversations' }).click();
    await convos.first().waitFor();
    const rows = await past.locator('li').count();
    p.once('dialog', (d) => d.accept());
    await past.getByRole('button', { name: /^Delete “Summarize recruitment/ }).first().click();
    await p.waitForFunction((n) => document.querySelectorAll('[aria-label="Past conversations"] li').length < n, rows);
    expect(await convos.count() === before - 1, 'conversation not deleted');
    ok('deleted the conversation');
    await p.keyboard.press('Escape');

    const real = errs.filter((e) => !/favicon|Failed to load resource/.test(e));
    expect(!real.length, `browser errors:\n${real.join('\n')}`);
    console.log('iq flow passed');
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
