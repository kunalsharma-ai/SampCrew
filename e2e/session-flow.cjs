/**
 * Sign-in sessions end-to-end flow: the Web Portal must never trap a browser in a redirect loop or sign people out
 * on its own.
 *
 *   pnpm db:reset && pnpm dev:api & pnpm dev:web &
 *   node e2e/session-flow.cjs
 *
 * 1. Requests sent together while the access token is about to expire (a page and its prefetches) share one token
 *    refresh, and the person stays signed in. Each used to refresh on its own; the API saw the old refresh token
 *    used twice, treated it as theft and ended the session.
 * 2. A workspace suspended, or with the Web Portal switched off, while someone is signed in ends that session and
 *    sign-in says why. Before, /me was refused, the layout sent the browser to "no access", whose layout asked /me
 *    again: ERR_TOO_MANY_REDIRECTS.
 * 3. Optional: with E2E_INSECURE_WEB_URL set to a web app that uses Secure cookies, opened on a plain http address
 *    other than localhost, sign-in explains that https is needed instead of returning to the sign-in page.
 *
 * Run it on a fresh database before the other flows: it signs in as the demo owner, who has not enrolled MFA yet.
 */
const path = require('node:path');
const { chromium } = require('playwright');
const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(__dirname, '../apps/api')] }));

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://localhost:27017/crew?replicaSet=rs0';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const OWNER = 'owner@demo.crew.local';
const ok = (msg) => console.log(`  ok  ${msg}`);

async function signIn(browser, base = WEB) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.fill('input[name=email]', OWNER);
  await page.fill('input[name=password]', PASSWORD);
  await page.click('button[type=submit]');
  return { context, page };
}

/** An unsigned token whose expiry is now: the middleware reads only `exp` to decide when to refresh. */
const expiringToken = () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) })}.x`;
};

async function expectSignedOut(page, reason, text) {
  const res = await page.goto(`${WEB}/`).catch((e) => {
    throw new Error(`opening the portal failed (${e.message.split('\n')[0]})`);
  });
  if (!res || res.status() !== 200) throw new Error(`expected the sign-in page, got ${res?.status()}`);
  const url = new URL(page.url());
  if (url.pathname !== '/login' || url.searchParams.get('reason') !== reason) throw new Error(`expected /login?reason=${reason}, got ${page.url()}`);
  await page.waitForSelector(`text=${text}`);
  const left = (await page.context().cookies()).filter((c) => c.name === 'crew_at' || c.name === 'crew_rt');
  if (left.length) throw new Error('session cookies were not cleared');
}

(async () => {
  const browser = await chromium.launch();
  const mongo = new MongoClient(MONGODB_URL);
  await mongo.connect();
  const db = mongo.db();
  const tenant = await db.collection('tenants').findOne({ slug: 'demo-northwind' });
  if (!tenant) throw new Error('demo workspace missing: run pnpm db:reset with CREW_SEED_DEMO=true');
  try {
    // 1. Concurrent refresh.
    {
      const { context, page } = await signIn(browser);
      await page.waitForURL((u) => u.pathname !== '/login');
      const host = new URL(WEB).hostname;
      await context.addCookies([{ name: 'crew_at', value: expiringToken(), domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }]);
      const statuses = await page.evaluate((paths) => Promise.all(paths.map((p) => fetch(p, { headers: { rsc: '1', 'next-router-prefetch': '1' }, redirect: 'manual' }).then((r) => r.status))), ['/employees', '/leave', '/attendance', '/approvals', '/helpdesk', '/settings/security']);
      if (statuses.some((s) => s !== 200)) throw new Error(`parallel requests during a token refresh were signed out: ${statuses.join(', ')}`);
      await page.goto(`${WEB}/employees`);
      if (new URL(page.url()).pathname !== '/employees') throw new Error(`signed out after a refresh: ${page.url()}`);
      const sessions = await db.collection('sessions').countDocuments({ tenant_id: tenant._id, revoked_reason: 'refresh_token_reuse' });
      if (sessions) throw new Error('the API saw a refresh token used twice');
      ok('requests sent together during a token refresh share one refresh; still signed in');
      await context.close();
    }

    // 2a. Workspace suspended while signed in.
    {
      const { context, page } = await signIn(browser);
      await page.waitForURL((u) => u.pathname !== '/login');
      await db.collection('tenants').updateOne({ _id: tenant._id }, { $set: { status: 'suspended' } });
      try {
        await expectSignedOut(page, 'tenant_suspended', 'This workspace is suspended');
      } finally {
        await db.collection('tenants').updateOne({ _id: tenant._id }, { $set: { status: 'active' } });
      }
      ok('suspended workspace: signed out with the reason, no redirect loop');
      await context.close();
    }

    // 2b. Web Portal switched off while signed in.
    {
      const { context, page } = await signIn(browser);
      await page.waitForURL((u) => u.pathname !== '/login');
      const before = await db.collection('tenant_access_controls').findOne({ tenant_id: tenant._id });
      if (before) await db.collection('tenant_access_controls').updateOne({ tenant_id: tenant._id }, { $set: { web_portal_enabled: false } });
      else await db.collection('tenant_access_controls').insertOne({ tenant_id: tenant._id, web_portal_enabled: false, mobile_app_enabled: true, web_off_features: [], mobile_off_features: [], disabled_permissions: [], device_vendors_disabled: [], updated_at: new Date() });
      try {
        await expectSignedOut(page, 'app_switched_off', 'switched the Web Portal off');
      } finally {
        if (before) await db.collection('tenant_access_controls').updateOne({ tenant_id: tenant._id }, { $set: { web_portal_enabled: before.web_portal_enabled } });
        else await db.collection('tenant_access_controls').deleteOne({ tenant_id: tenant._id });
      }
      ok('Web Portal switched off: signed out with the reason, no redirect loop');
      await context.close();
    }

    // 3. Plain http address with Secure cookies.
    if (process.env.E2E_INSECURE_WEB_URL) {
      const base = process.env.E2E_INSECURE_WEB_URL;
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${base}/login`);
      await page.fill('input[name=email]', OWNER);
      await page.fill('input[name=password]', PASSWORD);
      await page.click('button[type=submit]');
      await page.waitForSelector('text=Sign-in needs a secure address');
      ok('plain http address: sign-in explains that https is needed');
    }
  } finally {
    await mongo.close();
    await browser.close();
  }
  console.log('session flow passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
