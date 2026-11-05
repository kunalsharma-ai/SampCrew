/**
 * API load test. Signs in a few demo users through the API, then keeps CONCURRENCY requests in flight against
 * read-heavy routes the Web Portal and the mobile app call on every screen, for DURATION seconds. Every request goes
 * through the full stack: authentication, permission checks, Row-Level Security and the database.
 *
 * It reports throughput, p50 / p95 / p99 latency per route and overall, and the error rate, and exits 1 when the
 * thresholds are missed (defaults: p95 under 300 ms, under 1% errors). Rate limiting is per client, so run the API
 * with a higher API_RATE_LIMIT_PER_MINUTE for the test, or the test measures the limiter instead of the API:
 *
 *   pnpm db:reset
 *   API_RATE_LIMIT_PER_MINUTE=1000000 node apps/api/dist/main.js &
 *   node e2e/load.cjs [--duration 30] [--concurrency 20] [--p95 300] [--max-error-rate 0.01] [--report docs/ops/load-latest.md]
 *
 * Numbers from one machine running the API, the database and the test together are a baseline for spotting
 * regressions, not a statement of production capacity.
 */
const { writeFileSync } = require('node:fs');
const os = require('node:os');

const API = (process.env.CREW_API_URL ?? 'http://localhost:4000') + '/api/v1';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const DURATION = Number(arg('duration', 30));
const CONCURRENCY = Number(arg('concurrency', 20));
const P95_MS = Number(arg('p95', 300));
const MAX_ERROR_RATE = Number(arg('max-error-rate', 0.01));
const REPORT = arg('report');

const TODAY = new Date().toISOString().slice(0, 10);
// Who calls what. HR reads the people directory and approvals; employees read their own day, balances and requests.
const ROUTES = {
  'uk.hr@demo.crew.local': ['/employees?limit=50', '/approvals/inbox', '/org/overview', '/leave/requests', `/attendance/team?date=${TODAY}`],
  'supervisor@demo.crew.local': ['/approvals/inbox', `/attendance/team?date=${TODAY}`, '/employees/me'],
  'operator1@demo.crew.local': ['/employees/me', '/attendance/today', '/leave/balances', '/leave/requests', '/notifications'],
};

async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const j = await r.json();
  if (j.status !== 'ok') throw new Error(`${email} cannot sign in through the API (${r.status} ${j.status ?? j.code}); run on a fresh database (pnpm db:reset)`);
  return j.accessToken;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0);
const fmt = (n) => n.toFixed(1);

async function main() {
  const users = [];
  for (const [email, routes] of Object.entries(ROUTES)) users.push({ email, routes, token: await login(email) });
  // Check every route works once before measuring, so a broken route fails loudly instead of as "errors".
  for (const u of users)
    for (const r of u.routes) {
      const res = await fetch(API + r, { headers: { authorization: `Bearer ${u.token}` } });
      if (!res.ok) throw new Error(`${u.email} GET ${r} -> ${res.status} ${await res.text()}`);
    }
  const jobs = users.flatMap((u) => u.routes.map((r) => ({ ...u, route: r })));

  const stats = new Map(jobs.map((j) => [j.route, { lat: [], errors: 0, statuses: {} }]));
  const end = Date.now() + DURATION * 1000;
  let n = 0;
  const worker = async () => {
    while (Date.now() < end) {
      const j = jobs[n++ % jobs.length];
      const s = stats.get(j.route);
      const t0 = performance.now();
      try {
        const res = await fetch(API + j.route, { headers: { authorization: `Bearer ${j.token}` } });
        await res.arrayBuffer();
        s.lat.push(performance.now() - t0);
        if (!res.ok) {
          s.errors++;
          s.statuses[res.status] = (s.statuses[res.status] ?? 0) + 1;
        }
      } catch (e) {
        s.lat.push(performance.now() - t0);
        s.errors++;
        s.statuses[e.code ?? 'network'] = (s.statuses[e.code ?? 'network'] ?? 0) + 1;
      }
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const secs = (Date.now() - started) / 1000;

  const all = [...stats.values()].flatMap((s) => s.lat).sort((a, b) => a - b);
  const errors = [...stats.values()].reduce((a, s) => a + s.errors, 0);
  const errorRate = all.length ? errors / all.length : 1;
  const p95 = pct(all, 95);
  const lines = [
    '# API load test',
    '',
    `- Run at: ${new Date().toISOString()}`,
    `- Machine: ${os.cpus().length} CPU cores (${os.cpus()[0]?.model.trim()}), ${(os.totalmem() / 1024 ** 3).toFixed(0)} GB; API, database and load generator on the same machine`,
    `- Load: ${CONCURRENCY} requests in flight for ${fmt(secs)} s, ${users.length} signed-in users, ${jobs.length} routes`,
    `- Requests: ${all.length.toLocaleString('en')} (${fmt(all.length / secs)} per second), errors ${errors} (${(errorRate * 100).toFixed(2)}%)`,
    `- Latency overall: p50 ${fmt(pct(all, 50))} ms, p95 ${fmt(p95)} ms, p99 ${fmt(pct(all, 99))} ms`,
    '',
    '| Route | Requests | p50 ms | p95 ms | p99 ms | Errors |',
    '|---|---:|---:|---:|---:|---:|',
    ...[...stats.entries()].map(([r, s]) => {
      const l = s.lat.sort((a, b) => a - b);
      const st = Object.entries(s.statuses).map(([k, v]) => `${k}×${v}`).join(' ');
      return `| GET ${r.split('?')[0]} | ${l.length} | ${fmt(pct(l, 50))} | ${fmt(pct(l, 95))} | ${fmt(pct(l, 99))} | ${s.errors}${st ? ` (${st})` : ''} |`;
    }),
    '',
  ];
  const problems = [];
  if (p95 > P95_MS) problems.push(`p95 ${fmt(p95)} ms is over the ${P95_MS} ms threshold`);
  if (errorRate > MAX_ERROR_RATE) problems.push(`error rate ${(errorRate * 100).toFixed(2)}% is over ${(MAX_ERROR_RATE * 100).toFixed(2)}%`);
  lines.push(problems.length ? `**Result: FAILED.** ${problems.join('; ')}.` : `**Result: passed** (thresholds: p95 under ${P95_MS} ms, errors under ${(MAX_ERROR_RATE * 100).toFixed(2)}%).`);
  console.log(lines.join('\n'));
  if (REPORT) writeFileSync(REPORT, `${lines.join('\n')}\n`);
  if (problems.length) process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
