/**
 * Recruitment end-to-end flow in a real browser, against the demo workspace.
 *
 *   pnpm db:reset            # fresh demo workspace (HR admin must not have MFA enrolled yet)
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/recruitment-flow.cjs
 *
 * 1. A visitor (not signed in) finds the Quality Engineer job on the public career site and applies with a CV,
 *    agreeing to the privacy notice.
 * 2. The recruiter sees the application in the pipeline, moves it to Screening and downloads the CV.
 * 3. The QA lead submits their scorecard for yesterday's interview with another candidate.
 * 4. The recruiter drafts an offer for that candidate and submits it for approval.
 * 5. HR turns on two-step verification and approves the offer from the Approvals inbox.
 * 6. The recruiter sends the offer and records the candidate's acceptance.
 * 7. HR hires the candidate, which creates their employee record.
 * 8. The plant head submits a draft requisition; HR approves it. The recruiter adds a pipeline stage.
 * Also opens every recruitment screen and fails on any browser error.
 */
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(`${who} ${m.text()}`));
  p.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Demo e2e reason') : d.accept()));
};

async function signIn(b, email) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const p = await ctx.newPage();
  watch(p, email);
  await p.goto(BASE + '/login');
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForURL((u) => u.pathname === '/', { timeout: 15000 });
  return p;
}

const shot = async (p, e) => {
  await p.screenshot({ path: process.env.SHOT ?? '/tmp/recruitment-fail.png', fullPage: true }).catch(() => {});
  throw e;
};
const dialogOf = (p) => p.locator('dialog[open]');

(async () => {
  const b = await chromium.launch();
  const stamp = Date.now();
  const applicant = { first: 'Meghna', last: `Rao ${stamp % 10000}`, email: `meghna.${stamp}@candidates.demo.crew.local` };

  // 1. A visitor applies on the public career site.
  const visitorCtx = await b.newContext({ viewport: { width: 420, height: 900 } });
  const v = await visitorCtx.newPage();
  watch(v, 'visitor');
  await v.goto(BASE + '/careers/northwind-demo');
  await v.click('text=Quality Engineer (demo)');
  await v.waitForURL(/\/careers\/northwind-demo\/quality-engineer$/);
  await v.locator('text=How Northwind').waitFor();
  await v.fill('input[name=firstName]', applicant.first);
  await v.fill('input[name=lastName]', applicant.last);
  await v.fill('input[name=email]', applicant.email);
  await v.setInputFiles('input[name=cv]', { name: 'meghna-cv.pdf', mimeType: 'application/pdf', buffer: PDF });
  await v.fill('textarea[name=coverNote]', 'Six years in automotive quality, 8D and PPAP.');
  await v.check('input[name=consent]');
  await v.click('button:has-text("Submit application")');
  await v.locator('text=we have your application').waitFor({ timeout: 10000 }).catch((e) => shot(v, e));
  ok('visitor applied on the public career site with a CV and consent');
  await visitorCtx.close();

  // 2. The recruiter sees it in the pipeline and moves it on.
  const rec = await signIn(b, 'recruiter@demo.crew.local');
  await rec.goto(BASE + '/recruitment');
  await rec.click('a:has-text("Quality Engineer")');
  await rec.waitForURL(/\/recruitment\/jobs\//);
  const jobUrl = rec.url();
  const applied = rec.locator('section[aria-label="Applied"]');
  await applied.locator(`text=${applicant.first} ${applicant.last}`).waitFor({ timeout: 10000 }).catch((e) => shot(rec, e));
  await applied.locator(`select[aria-label="Move ${applicant.first} ${applicant.last}"]`).selectOption({ label: 'Screening' });
  await rec.locator('section[aria-label="Screening"]').locator(`text=${applicant.first} ${applicant.last}`).waitFor({ timeout: 10000 }).catch((e) => shot(rec, e));
  ok('recruiter found the application in Applied and moved it to Screening');
  await rec.click(`a:has-text("${applicant.first} ${applicant.last}")`);
  await rec.waitForURL(/\/recruitment\/candidates\//);
  await rec.locator('text=Candidate agreed to the privacy notice').waitFor();
  const cvHref = await rec.locator('a:has-text("meghna-cv.pdf")').getAttribute('href');
  const cv = await rec.request.get(BASE + cvHref);
  if (cv.status() !== 200 || !(await cv.body()).toString().startsWith('%PDF')) throw new Error(`CV download failed: ${cv.status()}`);
  ok('recruiter opened the candidate, saw the consent record and downloaded the CV');

  // 3. The QA lead submits a scorecard for yesterday's interview.
  const qa = await signIn(b, 'qa.lead@demo.crew.local');
  await qa.goto(BASE + '/recruitment/interviews');
  await qa.click('a:has-text("Ananya Joshi")');
  await qa.waitForURL(/\/recruitment\/interviews\//);
  const card = qa.locator('form', { hasText: 'Submit scorecard' });
  const scores = card.locator('select[name^=score-]');
  for (let i = 0; i < (await scores.count()); i++) await scores.nth(i).selectOption(i === 1 ? '3' : '4');
  await card.locator('textarea[name=note-0]').fill('Walked through a full 8D on a real defect.');
  await card.locator('select[name=recommendation]').selectOption('strong_yes');
  await card.locator('textarea[name=summary]').fill('Strong, practical quality engineer who explains clearly.');
  await card.locator('button:has-text("Submit scorecard")').click();
  await qa.locator('text=Your scorecard').first().waitFor({ timeout: 10000 }).catch((e) => shot(qa, e));
  await qa.locator('text=Strong yes').first().waitFor();
  ok('QA lead submitted an independent scorecard for the interview');

  // 4. The recruiter drafts an offer for Ananya and sends it for approval.
  await rec.goto(jobUrl);
  await rec.click('a:has-text("Ananya Joshi")');
  await rec.waitForURL(/\/recruitment\/candidates\//);
  const ananyaUrl = rec.url();
  await rec.locator('text=Average score').waitFor();
  await rec.click('button:has-text("Draft offer")');
  const offer = dialogOf(rec);
  await offer.locator('input[name=baseSalary]').fill('850000');
  await offer.locator('button:has-text("Save draft")').click();
  await rec.locator('text=Offer drafted').waitFor({ timeout: 10000 }).catch((e) => shot(rec, e));
  await rec.click('button:has-text("Submit for approval")');
  await rec.locator('text=Offer sent for approval').waitFor({ timeout: 10000 }).catch((e) => shot(rec, e));
  ok('recruiter drafted an offer within budget and submitted it for approval');

  // 5. HR turns on two-step verification (offer approval needs it) and approves.
  const hr = await signIn(b, 'hr.admin@demo.crew.local');
  await hr.goto(BASE + '/settings/security');
  await hr.click('text=Set up two-step verification');
  const secret = (await hr.locator('code').first().textContent()).trim();
  await hr.fill('input[name=code]', authenticator.generate(secret));
  await hr.click('text=Turn on');
  await hr.waitForSelector('text=/two-step verification is on/i', { timeout: 8000 });
  await hr.goto(BASE + '/approvals');
  const offerCard = hr.locator('div', { hasText: /Ananya Joshi/ }).filter({ has: hr.locator('button:has-text("Approve")') }).last();
  await offerCard.locator('button:has-text("Approve")').click();
  await hr.locator('text=/Ananya Joshi: offer for/').waitFor({ state: 'detached', timeout: 10000 }).catch((e) => shot(hr, e));
  ok('HR verified with a second factor and approved the offer');

  // 6. The recruiter sends it and records the acceptance.
  await rec.goto(ananyaUrl);
  await rec.click('button:has-text("Send to candidate")');
  await rec.locator('text=Offer emailed to the candidate').waitFor({ timeout: 10000 }).catch((e) => shot(rec, e));
  await rec.click('button:has-text("Record answer")');
  const answer = dialogOf(rec);
  await answer.locator('input[name=note]').fill('Accepted on a call with the recruiter');
  await answer.locator('button:has-text("Record")').click();
  await rec.locator('text=Accepted').first().waitFor({ timeout: 10000 }).catch((e) => shot(rec, e));
  await rec.locator('text=HR completes the hire').waitFor();
  ok('recruiter sent the offer and recorded the acceptance; the hire is left to HR');

  // 7. HR hires her.
  await hr.goto(ananyaUrl);
  await hr.click('button:has-text("Hire and create employee record")');
  await dialogOf(hr).locator('button:has-text("Hire")').click();
  await hr.waitForURL(/\/employees\/[0-9a-f-]{36}/, { timeout: 15000 }).catch((e) => shot(hr, e));
  await hr.locator('h1:has-text("Ananya Joshi")').waitFor();
  ok('HR hired the candidate and landed on her new employee record');

  // 8. The plant head submits the draft requisition and HR approves it.
  const head = await signIn(b, 'plant.head@demo.crew.local');
  await head.goto(BASE + '/recruitment?status=draft');
  await head.click('a:has-text("CNC Machine Operator")');
  await head.click('button:has-text("Submit for approval")');
  await head.locator('text=Waiting for approval').waitFor({ timeout: 10000 }).catch((e) => shot(head, e));
  await hr.goto(BASE + '/approvals');
  const reqCard = hr.locator('div', { hasText: /CNC Machine Operator/ }).filter({ has: hr.locator('button:has-text("Approve")') }).last();
  await reqCard.locator('button:has-text("Approve")').click();
  await hr.locator('text=/CNC Machine Operator: 3 hires/').waitFor({ state: 'detached', timeout: 10000 }).catch((e) => shot(hr, e));
  await head.reload();
  await head.locator('button:has-text("Open for hiring")').waitFor({ timeout: 10000 }).catch((e) => shot(head, e));
  ok('plant head submitted a requisition and HR approved it');

  await rec.goto(BASE + '/settings/recruitment');
  await rec.click('button:has-text("Add stage")');
  await dialogOf(rec).locator('input[name=name]').fill(`Site visit ${stamp % 1000}`);
  await dialogOf(rec).locator('button:has-text("Add")').click();
  await rec.locator(`td:has-text("Site visit ${stamp % 1000}")`).waitFor({ timeout: 10000 }).catch((e) => shot(rec, e));
  ok('recruiter added a pipeline stage');

  for (const path of ['/recruitment', '/recruitment/candidates', '/recruitment/interviews', '/settings/recruitment']) {
    const res = await rec.goto(BASE + path);
    if (!res.ok()) throw new Error(`${path} returned ${res.status()}`);
  }
  // A hiring manager does not see recruitment settings, and an operator has no access to jobs.
  if ((await (await head.goto(BASE + '/settings/recruitment')).url()).includes('/settings/recruitment') && !(await head.locator('text=/not have access|No access/i').count())) {
    throw new Error('hiring manager could open recruitment settings');
  }
  ok('every recruitment screen opens; settings are closed to a hiring manager');

  await b.close();
  if (errs.length) {
    console.error(errs.join('\n'));
    process.exit(1);
  }
  console.log('recruitment flow: OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
