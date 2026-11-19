/**
 * Communication end-to-end flow in the Web Portal (it replaced Ask HR), against the demo workspace.
 *
 *   pnpm db:reset            # fresh demo workspace (HR admin must not have MFA enrolled yet)
 *   pnpm dev:api & pnpm dev:web &
 *   node e2e/communication-flow.cjs
 *
 * 1. An operator opens Communication from the menu, starts a conversation with the HR team and sends a message with
 *    a file. It shows "Sent" or "Delivered".
 * 2. HR sees it waiting on the Communication overview and in the menu count, opens it (the file is there) and
 *    answers. The operator's message turns "Read" and HR's answer arrives without reloading.
 * 3. HR makes a group, then writes an email to the Assembly Line department plus the group, with bold text, a Cc and
 *    an attachment, saves it as a draft, reopens it and sends it. The email page lists every recipient with a status.
 * 4. The operator finds the email under Emails, opens it and sees the formatted text and the attachment.
 * 5. HR finds the operator's communication record (the email and the chat).
 * Fails on any browser error.
 */
const { chromium } = require('playwright');
const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');

const ok = (m) => console.log(`ok - ${m}`);
const errs = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => errs.push(`${who} PAGEERROR ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(`${who} ${m.text()}`));
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

const dialogOf = (p) => p.locator('dialog[open]');
const pdf = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n% ${name}\n%%EOF\n`) });

(async () => {
  const b = await chromium.launch();
  const stamp = Date.now();
  let current;
  try {
    // 1. The operator writes to HR from Communication.
    const neha = current = await signIn(b, 'operator2@demo.crew.local');
    const nehaNav = neha.getByRole('navigation', { name: 'Main' });
    if (await nehaNav.getByRole('link', { name: /^Ask HR/ }).count()) throw new Error('Ask HR is still in the menu');
    await nehaNav.getByRole('link', { name: /^Communication/ }).click();
    await neha.waitForURL(/\/communication\/chat/);
    await neha.getByRole('button', { name: 'New conversation' }).first().click();
    let d = dialogOf(neha);
    await d.getByRole('radio', { name: 'HR team' }).click();
    await d.getByRole('button', { name: 'Message HR' }).click();
    await neha.waitForURL(/\/communication\/chat\/[0-9a-f-]{36}$/);
    const chatUrl = neha.url();
    const question = `My shift allowance is missing this month (${stamp})`;
    await neha.getByTestId('chat-file-input').setInputFiles(pdf(`timesheet-${stamp}.pdf`));
    await neha.getByText(`timesheet-${stamp}.pdf`).first().waitFor();
    await neha.getByPlaceholder(/Write a message/).fill(question);
    await neha.getByRole('button', { name: 'Send' }).click();
    const mine = neha.getByTestId('message').filter({ hasText: question });
    await mine.getByTestId('message-delivery').getByText(/Sent|Delivered/).waitFor();
    await mine.getByTestId('message-file').getByText(`timesheet-${stamp}.pdf`).waitFor();
    ok('operator opened Communication from the menu and sent HR a message with a file');

    // 2. HR answers it.
    const hr = current = await signIn(b, 'hr.admin@demo.crew.local');
    const hrNav = hr.getByRole('navigation', { name: 'Main' });
    if (await hrNav.getByRole('link', { name: /^(Ask HR|HR helpdesk)/ }).count()) throw new Error('HR still sees Ask HR or HR helpdesk in the menu');
    await hrNav.getByRole('link', { name: /^Communication/ }).locator('[aria-label$="waiting"]').waitFor();
    await hrNav.getByRole('link', { name: /^Communication/ }).click();
    await hr.waitForURL(/\/communication$/);
    await hr.getByTestId('comm-stats').waitFor();
    const waiting = hr.getByTestId('waiting-for-hr');
    await waiting.getByText('Neha Deshmukh').first().click();
    const chatId = chatUrl.split('/').pop();
    await hr.waitForURL((u) => u.pathname.endsWith(chatId));
    const theirs = hr.getByTestId('message').filter({ hasText: question });
    await theirs.getByTestId('message-file').getByText(`timesheet-${stamp}.pdf`).waitFor();
    const answer = `Added to next payroll, thanks (${stamp})`;
    await hr.getByPlaceholder(/Write a message/).fill(answer);
    await hr.keyboard.press('Enter');
    await hr.getByTestId('message').filter({ hasText: answer }).waitFor();
    current = neha;
    // No reload: the answer and the read tick arrive live.
    await neha.getByTestId('message').filter({ hasText: answer }).waitFor({ timeout: 20000 });
    await mine.getByTestId('message-delivery').getByText('Read').waitFor({ timeout: 20000 });
    ok('HR saw it waiting, opened the file and answered; the operator saw Read and the answer live');

    // 3. HR makes a group and emails the department plus the group.
    current = hr;
    const groupName = `Night shift leads ${stamp}`;
    await hr.goto(BASE + '/communication/groups');
    await hr.getByRole('button', { name: /New group/ }).click();
    d = dialogOf(hr);
    await d.getByLabel('Name').fill(groupName);
    await d.getByPlaceholder('Name, department or designation').fill('Arjun');
    await d.getByTestId('people-picker').getByRole('button', { name: /Arjun/ }).first().click();
    await d.getByRole('button', { name: 'Save group' }).click();
    await hr.getByTestId('group-card').filter({ hasText: groupName }).waitFor();
    ok('HR made a group');

    const subject = `Diwali shift timings ${stamp}`;
    await hr.goto(BASE + '/communication/emails/new');
    const picker = hr.getByTestId('audience-picker');
    await picker.getByTestId('audience-departments').getByRole('button', { name: 'Assembly Line' }).click();
    await picker.getByTestId('audience-groups').getByRole('button', { name: new RegExp(groupName) }).click();
    await picker.getByTestId('audience-reach').getByText(/Reaches \d+ (person|people)/).waitFor();
    await hr.getByRole('button', { name: 'Add Cc or Bcc' }).click();
    await hr.getByRole('textbox', { name: 'Cc', exact: true }).fill('plant-office@example.com');
    await hr.getByRole('textbox', { name: /^Subject/ }).fill(subject);
    const editor = hr.getByTestId('rich-text');
    await editor.click();
    await hr.keyboard.type('The plant closes early on ');
    const bold = hr.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Bold' });
    await bold.click();
    await hr.keyboard.type('Friday');
    await bold.click();
    await hr.keyboard.type('. Buses leave at ');
    // Ctrl+B is bold in the editor (not the menu's collapse shortcut).
    await hr.keyboard.press('Control+B');
    await hr.keyboard.type('4 PM');
    await hr.keyboard.press('Control+B');
    await hr.keyboard.type('.');
    await hr.getByTestId('email-file-input').setInputFiles(pdf(`roster-${stamp}.pdf`));
    await hr.getByRole('list', { name: 'Attachments' }).getByText(`roster-${stamp}.pdf`).waitFor();
    await hr.getByRole('button', { name: 'Save draft' }).click();
    await hr.getByText(/Draft saved/i).first().waitFor();
    await hr.goto(BASE + '/communication/emails');
    await hr.getByTestId('email-row').filter({ hasText: subject }).filter({ hasText: /Draft/ }).first().click();
    await hr.getByRole('textbox', { name: /^Subject/ }).waitFor();
    if ((await hr.getByRole('textbox', { name: /^Subject/ }).inputValue()) !== subject) throw new Error('draft did not reopen with its subject');
    await hr.getByTestId('rich-text').locator('b, strong', { hasText: 'Friday' }).waitFor();
    await hr.getByTestId('rich-text').locator('b, strong', { hasText: '4 PM' }).waitFor();
    await hr.getByRole('button', { name: 'Send', exact: true }).click();
    await hr.getByTestId('send-confirm').getByRole('button', { name: 'Yes, send' }).click();
    await hr.waitForURL(/\/communication\/emails\/[0-9a-f-]{36}/);
    const recipients = hr.getByTestId('email-recipients');
    await recipients.getByText('Neha Deshmukh').waitFor();
    await recipients.getByText('Arjun', { exact: false }).first().waitFor();
    await recipients.getByText('plant-office@example.com').first().waitFor();
    ok('HR emailed the Assembly Line and the group with bold text, a Cc and an attachment, via a saved draft');

    // 4. The operator reads it in SampCrew.
    current = neha;
    await neha.goto(BASE + '/communication/emails');
    await neha.getByTestId('inbox-email').filter({ hasText: subject }).first().click();
    await neha.getByTestId('inbox-email').filter({ hasText: subject }).locator('b, strong', { hasText: 'Friday' }).waitFor();
    await neha.getByText(`roster-${stamp}.pdf`).first().waitFor();
    ok('the operator found the email under Emails with its formatting and attachment');

    // 5. HR's record of what the operator was sent and said.
    current = hr;
    await recipients.getByRole('link', { name: 'Neha Deshmukh' }).click();
    await hr.waitForURL(/\/communication\/people\//);
    await hr.getByText(subject).first().waitFor();
    ok('HR opened the operator\'s communication record');

    if (errs.length) throw new Error(`browser errors:\n${errs.join('\n')}`);
    console.log('communication flow passed');
  } catch (e) {
    await current?.screenshot({ path: process.env.SHOT ?? '/tmp/communication-fail.png', fullPage: true }).catch(() => {});
    console.error(e);
    if (errs.length) console.error(errs.join('\n'));
    process.exitCode = 1;
  } finally {
    await b.close();
  }
})();
