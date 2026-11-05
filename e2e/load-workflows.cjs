/**
 * Workflow load test: the writes people make every day, at the same time, through the full API stack.
 *
 *   pnpm db:reset
 *   API_RATE_LIMIT_PER_MINUTE=1000000 node apps/api/dist/main.js &
 *   node e2e/load-workflows.cjs [--duration 60] [--concurrency 12] [--hires 200] [--report docs/ops/load-workflows-latest.md]
 *
 * 1. Scale: HR hires --hires people through the API (the same call as the hire form), payroll gives each a salary,
 *    and payroll computes a whole month for the legal entity. The run is cancelled afterwards.
 * 2. Mixed load for --duration seconds with --concurrency workflows in flight, each a full round trip:
 *    - punch: an employee punches in or out from the app;
 *    - leave: an employee applies for a day off, the manager approves it from the inbox, the employee cancels it
 *      (so balances never run out);
 *    - helpdesk: an employee raises a case, HR replies and resolves it, the employee confirms it;
 *    - reads: the screens people open most (directory, inbox, today, balances).
 *
 * It reports each step's p50 / p95 / p99, each workflow's end-to-end time and the error rate, and exits 1 when a
 * threshold is missed (defaults: step p95 under 1000 ms, payroll under 60 s for the hires, under 1% errors).
 * Numbers from one machine running everything are a baseline for spotting regressions, not production capacity.
 */
const { writeFileSync } = require('node:fs');
const os = require('node:os');
const { authenticator } = require('otplib');

const API = (process.env.CREW_API_URL ?? 'http://localhost:4000') + '/api/v1';
const PASSWORD = process.env.CREW_DEMO_PASSWORD;
if (!PASSWORD) throw new Error('Set CREW_DEMO_PASSWORD (source .env)');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const DURATION = Number(arg('duration', 60));
const CONCURRENCY = Number(arg('concurrency', 12));
const HIRES = Number(arg('hires', 200));
const STEP_P95_MS = Number(arg('p95', 1000));
const PAYROLL_MAX_S = Number(arg('payroll-max-s', 60));
const MAX_ERROR_RATE = Number(arg('max-error-rate', 0.01));
const REPORT = arg('report');

const stats = new Map();
const stat = (name) => {
  if (!stats.has(name)) stats.set(name, { lat: [], errors: 0, statuses: {} });
  return stats.get(name);
};
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0);
const fmt = (n) => n.toFixed(1);

class StepError extends Error {}

/** One API call, timed under `name`. Throws on a non-2xx answer so the workflow stops and counts as failed. */
async function call(name, method, path, token, body) {
  const s = stat(name);
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    s.lat.push(performance.now() - t0);
    s.errors++;
    s.statuses.network = (s.statuses.network ?? 0) + 1;
    throw new StepError(`${name}: ${e.message}`);
  }
  const text = await res.text();
  s.lat.push(performance.now() - t0);
  if (!res.ok) {
    s.errors++;
    s.statuses[res.status] = (s.statuses[res.status] ?? 0) + 1;
    throw new StepError(`${name}: ${res.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function login(email) {
  const j = await call('sign in', 'POST', '/auth/login', null, { email, password: PASSWORD });
  if (j.status !== 'ok') throw new Error(`${email} cannot sign in (${j.status}); run on a fresh database (pnpm db:reset)`);
  return j.accessToken;
}

/** Payroll needs two-step verification: enrol an authenticator for the demo payroll lead, as the Security page does. */
async function loginWithMfa(email) {
  const first = await call('sign in', 'POST', '/auth/login', null, { email, password: PASSWORD });
  if (first.status === 'ok') {
    const setup = await call('mfa setup', 'POST', '/me/mfa/setup', first.accessToken);
    const enabled = await call('mfa enable', 'POST', '/me/mfa/enable', first.accessToken, { code: authenticator.generate(setup.secret) });
    return enabled.accessToken;
  }
  throw new Error(`${email} already has two-step verification; run on a fresh database (pnpm db:reset)`);
}

async function pool(items, n, fn) {
  let i = 0;
  const errors = [];
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        try {
          await fn(item);
        } catch (e) {
          errors.push(e.message);
        }
      }
    }),
  );
  return errors;
}

const isoDate = (d) => d.toISOString().slice(0, 10);
function workingDays(from, count) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(isoDate(d));
  }
  return out;
}

async function scale(hr, payroll) {
  const out = {};
  const entities = await call('reads', 'GET', '/org/legal-entities', hr);
  const list = Array.isArray(entities) ? entities : entities.items;
  const india = list.find((e) => e.countryCode === 'IN') ?? list[0];
  const structures = await call('reads', 'GET', '/payroll/structures', payroll);
  const structure = (Array.isArray(structures) ? structures : structures.items).find((s) => !s.archivedAt && (!s.legalEntityId || s.legalEntityId === india.id));
  if (!structure) throw new Error('no active salary structure in the demo workspace');

  const t0 = performance.now();
  const hired = [];
  const hireErrors = await pool(
    Array.from({ length: HIRES }, (_, i) => i),
    10,
    async (i) => {
      const r = await call('hire (POST /employees)', 'POST', '/employees', hr, {
        legalEntityId: india.id,
        firstName: 'Load',
        lastName: `Test ${String(i + 1).padStart(4, '0')}`,
        dateOfJoining: '2026-01-15',
        probationMonths: 0,
      });
      hired.push(r.employee.id);
    },
  );
  out.hireSeconds = (performance.now() - t0) / 1000;
  out.hired = hired.length;

  const t1 = performance.now();
  const salaryErrors = await pool(hired, 10, (id) =>
    call('assign salary (POST /payroll/salaries/:id)', 'POST', `/payroll/salaries/${id}`, payroll, {
      effectiveFrom: '2026-01-15',
      annualCtc: String(300000 + Math.floor(Math.random() * 900000)),
      structureId: structure.id,
    }),
  );
  out.salarySeconds = (performance.now() - t1) / 1000;

  // A month with no run yet for this entity
  const runs = await call('reads', 'GET', '/payroll/runs', payroll);
  const taken = new Set((Array.isArray(runs) ? runs : runs.items).filter((r) => r.legalEntityId === india.id && r.status !== 'cancelled').map((r) => r.month));
  const now = new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() + 1;
  while (taken.has(`${y}-${String(m).padStart(2, '0')}`)) {
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  const month = `${y}-${String(m).padStart(2, '0')}`;
  const payDate = isoDate(new Date(Date.UTC(y, m, 0)));
  const run = await call('start payroll run', 'POST', '/payroll/runs', payroll, { legalEntityId: india.id, month, payDate });
  const t2 = performance.now();
  const computed = await call('compute payroll run', 'POST', `/payroll/runs/${run.id}/compute`, payroll);
  out.payrollSeconds = (performance.now() - t2) / 1000;
  const detail = await call('reads', 'GET', `/payroll/runs/${run.id}`, payroll);
  out.payslips = detail.itemCount ?? detail.items?.length ?? computed?.itemCount ?? computed?.computed ?? null;
  out.month = month;
  await call('cancel payroll run', 'POST', `/payroll/runs/${run.id}/cancel`, payroll, { reason: 'Load test run, not a real payroll' });
  out.errors = [...hireErrors, ...salaryErrors];
  return out;
}

async function main() {
  const tokens = {};
  for (const e of ['hr.admin', 'supervisor', 'plant.head', 'operator1', 'operator2', 'qa.lead', 'uk.hr']) tokens[e] = await login(`${e}@demo.crew.local`);
  tokens.payroll = await loginWithMfa('payroll@demo.crew.local');

  console.log(`Scale: hiring ${HIRES} people, giving each a salary, and computing a payroll month...`);
  const sc = await scale(tokens['hr.admin'], tokens.payroll);
  console.log(`  hired ${sc.hired} in ${fmt(sc.hireSeconds)} s, salaries in ${fmt(sc.salarySeconds)} s, payroll ${sc.month} (${sc.payslips ?? '?'} payslips) computed in ${fmt(sc.payrollSeconds)} s`);

  const categories = await call('reads', 'GET', '/helpdesk/categories', tokens.operator1);
  const category = categories.find((c) => !c.confidential && !c.archivedAt);

  // Each leave worker owns its own days, so concurrent requests never overlap; pending days stay within balances.
  const leaveUsers = ['operator1', 'operator2', 'qa.lead'];
  // Days in this leave year (balances are per year), that are working days for that person (not holidays).
  const yearEnd = `${new Date().getUTCFullYear()}-12-31`;
  const candidates = workingDays(isoDate(new Date(Date.now() + 3 * 86400000)), 80).filter((d) => d <= yearEnd);
  const leaveType = {};
  const days = {};
  for (const u of leaveUsers) {
    const b = await call('reads', 'GET', '/leave/balances', tokens[u]);
    leaveType[u] = b.balances.find((x) => x.code === 'CL' && Number(x.balance) >= 3)?.leaveTypeId ?? b.balances.find((x) => Number(x.balance) >= 3)?.leaveTypeId;
    if (!leaveType[u]) throw new Error(`${u} has no leave balance to test with`);
    // Days the person already has leave on (the demo data has some) would be refused as overlapping.
    const existing = (await call('reads', 'GET', '/leave/requests', tokens[u])).filter((r) => r.employeeId === b.employeeId && ['pending', 'approved'].includes(r.status));
    const booked = (d) => existing.some((r) => r.startDate <= d && d <= r.endDate);
    days[u] = [];
    for (const d of candidates.filter((x) => !booked(x))) {
      const pv = await call('reads', 'POST', '/leave/requests/preview', tokens[u], { leaveTypeId: leaveType[u], startDate: d, endDate: d });
      if (Number(pv.days) > 0) days[u].push(d);
    }
    if (days[u].length < 4) throw new Error(`${u} has too few working days left this year to test leave`);
  }
  const approvers = ['supervisor', 'plant.head', 'uk.hr', 'hr.admin'];
  let punchSeq = 0;
  let leaveSeq = 0;

  const workflows = {
    async punch() {
      const who = ['operator1', 'operator2', 'qa.lead'][punchSeq % 3];
      await call('punch (POST /attendance/punch)', 'POST', '/attendance/punch', tokens[who], { clientEventId: `load-${process.pid}-${punchSeq++}` });
      await call('reads', 'GET', '/attendance/today', tokens[who]);
    },
    async leave(worker) {
      const who = leaveUsers[worker % leaveUsers.length];
      // Workers sharing a person take turns through that person's days in separate halves, so they never overlap.
      const sharing = Math.ceil(CONCURRENCY / leaveUsers.length);
      const slot = Math.floor(worker / leaveUsers.length);
      const mine = days[who].filter((_, i) => i % sharing === slot);
      const day = mine[leaveSeq++ % mine.length];
      const req = await call('apply for leave (POST /leave/requests)', 'POST', '/leave/requests', tokens[who], { leaveTypeId: leaveType[who], startDate: day, endDate: day, reason: 'Load test' });
      let approved = false;
      for (const a of approvers) {
        const inbox = await call('approvals inbox (GET /approvals/inbox)', 'GET', '/approvals/inbox', tokens[a]);
        const item = inbox.find((x) => x.resourceId === req.id);
        if (item) {
          await call('approve (POST /approvals/:id/approve)', 'POST', `/approvals/${item.id}/approve`, tokens[a], {});
          approved = true;
          break;
        }
      }
      if (!approved) throw new StepError(`leave ${req.id} was in no approver's inbox`);
      await call('cancel leave (POST /leave/requests/:id/cancel)', 'POST', `/leave/requests/${req.id}/cancel`, tokens[who], { reason: 'Load test' });
    },
    async helpdesk() {
      const c = await call('raise case (POST /helpdesk/cases)', 'POST', '/helpdesk/cases', tokens.operator1, { categoryId: category.id, subject: 'Load test case', description: 'Raised by the workflow load test.' });
      await call('reply (POST /helpdesk/cases/:id/messages)', 'POST', `/helpdesk/cases/${c.id}/messages`, tokens['hr.admin'], { body: 'Handled by the load test.' });
      await call('resolve (POST /helpdesk/cases/:id/status)', 'POST', `/helpdesk/cases/${c.id}/status`, tokens['hr.admin'], { status: 'resolved', message: 'Resolved by the load test.' });
      await call('confirm (POST /helpdesk/cases/:id/status)', 'POST', `/helpdesk/cases/${c.id}/status`, tokens.operator1, { status: 'closed' });
    },
    async reads() {
      await call('reads', 'GET', '/employees?limit=50', tokens['hr.admin']);
      await call('reads', 'GET', '/approvals/inbox', tokens.supervisor);
      await call('reads', 'GET', '/leave/balances', tokens.operator2);
    },
  };
  // Mix: what a working day looks like (punches and reads dominate)
  const mix = ['punch', 'punch', 'punch', 'reads', 'reads', 'leave', 'helpdesk'];
  const flows = new Map(Object.keys(workflows).map((k) => [k, { lat: [], failed: 0, failures: [] }]));

  console.log(`Mixed load: ${CONCURRENCY} workflows in flight for ${DURATION} s...`);
  const end = Date.now() + DURATION * 1000;
  let n = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, worker) => {
      while (Date.now() < end) {
        const name = mix[n++ % mix.length];
        // Leave and helpdesk change shared state per person; keep one of each per worker slot.
        const f = flows.get(name);
        const t0 = performance.now();
        try {
          await workflows[name](worker);
          f.lat.push(performance.now() - t0);
        } catch (e) {
          f.failed++;
          if (f.failures.length < 5) f.failures.push(e.message);
        }
      }
    }),
  );
  const secs = (Date.now() - started) / 1000;

  const steps = [...stats.entries()].filter(([k]) => !['sign in', 'mfa setup', 'mfa enable'].includes(k));
  const allReq = steps.reduce((a, [, s]) => a + s.lat.length, 0);
  const allErr = steps.reduce((a, [, s]) => a + s.errors, 0);
  const errorRate = allReq ? allErr / allReq : 1;
  const totalFlows = [...flows.values()].reduce((a, f) => a + f.lat.length + f.failed, 0);
  const lines = [
    '# Workflow load test',
    '',
    `- Run at: ${new Date().toISOString()}`,
    `- Machine: ${os.cpus().length} CPU cores (${os.cpus()[0]?.model.trim()}), ${(os.totalmem() / 1024 ** 3).toFixed(0)} GB; API, database and load generator on the same machine`,
    '',
    '## Scale',
    '',
    `- Hired ${sc.hired} people through the API in ${fmt(sc.hireSeconds)} s (10 at a time), and gave each a salary in ${fmt(sc.salarySeconds)} s.`,
    `- Computed payroll for ${sc.month}: ${sc.payslips ?? 'unknown number of'} payslips in ${fmt(sc.payrollSeconds)} s (one request, one transaction). The run was then cancelled.`,
    ...(sc.errors.length ? [`- Errors while setting up: ${sc.errors.length} (first: ${sc.errors[0]})`] : []),
    '',
    '## Mixed workflows',
    '',
    `- ${CONCURRENCY} workflows in flight for ${fmt(secs)} s: ${totalFlows.toLocaleString('en')} workflows, ${allReq.toLocaleString('en')} requests (${fmt(allReq / secs)} per second), errors ${allErr} (${(errorRate * 100).toFixed(2)}%)`,
    '',
    '| Workflow | Completed | Failed | p50 ms | p95 ms | p99 ms |',
    '|---|---:|---:|---:|---:|---:|',
    ...[...flows.entries()].map(([k, f]) => {
      const l = f.lat.sort((a, b) => a - b);
      return `| ${k} | ${l.length} | ${f.failed} | ${fmt(pct(l, 50))} | ${fmt(pct(l, 95))} | ${fmt(pct(l, 99))} |`;
    }),
    '',
    '| Step | Requests | p50 ms | p95 ms | p99 ms | Errors |',
    '|---|---:|---:|---:|---:|---:|',
    ...steps.map(([k, s]) => {
      const l = s.lat.sort((a, b) => a - b);
      const st = Object.entries(s.statuses).map(([c, v]) => `${c}×${v}`).join(' ');
      return `| ${k} | ${l.length} | ${fmt(pct(l, 50))} | ${fmt(pct(l, 95))} | ${fmt(pct(l, 99))} | ${s.errors}${st ? ` (${st})` : ''} |`;
    }),
    '',
  ];
  const problems = [];
  for (const [k, s] of steps) {
    if (['start payroll run', 'compute payroll run', 'cancel payroll run'].includes(k)) continue;
    const p95 = pct(s.lat.sort((a, b) => a - b), 95);
    if (p95 > STEP_P95_MS) problems.push(`${k} p95 ${fmt(p95)} ms is over ${STEP_P95_MS} ms`);
  }
  if (sc.payrollSeconds > PAYROLL_MAX_S) problems.push(`payroll took ${fmt(sc.payrollSeconds)} s, over ${PAYROLL_MAX_S} s`);
  if (errorRate > MAX_ERROR_RATE) problems.push(`error rate ${(errorRate * 100).toFixed(2)}% is over ${(MAX_ERROR_RATE * 100).toFixed(2)}%`);
  if (sc.errors.length) problems.push(`${sc.errors.length} errors while hiring or assigning salaries`);
  for (const [k, f] of flows) if (f.failures.length) lines.push(`- ${k} failures (first ${f.failures.length}): ${f.failures.map((x) => `\`${x.slice(0, 160)}\``).join('; ')}`);
  if ([...flows.values()].some((f) => f.failures.length)) lines.push('');
  lines.push(
    problems.length
      ? `**Result: FAILED.** ${problems.join('; ')}.`
      : `**Result: passed** (thresholds: every step's p95 under ${STEP_P95_MS} ms, payroll under ${PAYROLL_MAX_S} s, errors under ${(MAX_ERROR_RATE * 100).toFixed(2)}%).`,
  );
  console.log(lines.join('\n'));
  if (REPORT) writeFileSync(REPORT, `${lines.join('\n')}\n`);
  if (problems.length) process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
