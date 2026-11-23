/**
 * Every delete asks for the person's own password (the "Confirm with your password" dialog on the web and in the
 * Console, the password sheet in the mobile app). Flows that are about something else require this file once: each
 * page any browser opens then types the password into that dialog when it shows, like the person would, so the flow
 * goes on testing its own module. The password is the Console admin's on the Console, the demo password elsewhere;
 * a flow that signs in with another password sets it with deletePassword(page, password). A flow that checks the
 * dialog itself calls manualDeletes(page) for that page.
 */
const playwright = require('playwright');

const CONSOLE = (process.env.CONSOLE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const SELECTOR = '[data-testid="delete-password-form"], [data-testid="delete-password-sheet"]';
const passwords = new WeakMap();
const manual = new WeakSet();

const passwordFor = (page) => passwords.get(page)
  ?? (page.url().startsWith(CONSOLE) ? process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD : process.env.CREW_DEMO_PASSWORD);

function watch(page) {
  (async () => {
    while (!page.isClosed()) {
      try {
        const form = page.locator(SELECTOR).first();
        await form.waitFor({ state: 'visible', timeout: 0 });
        if (manual.has(page)) { await form.waitFor({ state: 'hidden', timeout: 0 }); continue; }
        await form.locator('[data-testid="delete-password-input"]').fill(passwordFor(page) ?? '');
        await form.locator('[data-testid="delete-password-submit"]').click();
        await form.waitFor({ state: 'hidden', timeout: 15000 });
      } catch {
        if (page.isClosed()) return;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  })();
}

function wrapContext(ctx) {
  if (ctx.__deleteWatch) return ctx;
  ctx.__deleteWatch = true;
  ctx.pages().forEach(watch);
  ctx.on('page', watch);
  return ctx;
}

function wrapBrowser(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => wrapContext(await newContext(...args));
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    wrapContext(page.context());
    return page;
  };
  return browser;
}

for (const type of [playwright.chromium, playwright.firefox, playwright.webkit]) {
  if (!type || type.__deleteWatch) continue;
  type.__deleteWatch = true;
  const launch = type.launch.bind(type);
  type.launch = async (...args) => wrapBrowser(await launch(...args));
}

module.exports = {
  deletePassword: (page, password) => passwords.set(page, password),
  manualDeletes: (page) => manual.add(page),
};
