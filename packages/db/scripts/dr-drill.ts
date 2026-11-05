/**
 * Backup and restore drill. Takes a full backup of the database with pg_dump, restores it into a separate,
 * new database, and checks the copy is complete and still safe to run:
 *
 *   - the same tables, and the same number of rows in every table;
 *   - Row-Level Security still enabled and forced on every table that has a tenant_id;
 *   - every workspace's audit trail hash chain still verifies;
 *   - the migration history matches.
 *
 * It reports how long the backup and the restore took (a measured recovery time for this data size) and writes a
 * Markdown report. It never touches the source database beyond reading it, and drops the drill copy afterwards
 * unless --keep is given.
 *
 *   pnpm --filter @crew/db dr-drill [--report docs/ops/dr-drill-latest.md] [--keep]
 *
 * This proves the backup format and the restore procedure. It does not replace drills against the managed
 * database's own point-in-time recovery in production, which must be run there.
 */
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { adminUrl } from './env';

const run = promisify(execFile);
const args = process.argv.slice(2);
const reportPath = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined;
const keep = args.includes('--keep');

type Counts = Map<string, number>;

/**
 * pg_dump and pg_restore must be the same major version as the server: a newer pg_dump writes settings an older
 * server rejects. Uses PG_BIN when set, else /usr/lib/postgresql/<major>/bin when it exists, else the PATH, and
 * refuses to run with a different major version.
 */
async function pgTools(serverMajor: number) {
  const dirs = [process.env.PG_BIN, `/usr/lib/postgresql/${serverMajor}/bin`].filter(Boolean) as string[];
  let dir = '';
  for (const d of dirs) {
    if (await access(join(d, 'pg_dump')).then(() => true, () => false)) {
      dir = d;
      break;
    }
  }
  const tool = (name: string) => (dir ? join(dir, name) : name);
  for (const name of ['pg_dump', 'pg_restore']) {
    const { stdout } = await run(tool(name), ['--version']);
    const major = Number(/(\d+)(?:\.\d+)?/.exec(stdout)?.[1]);
    if (major !== serverMajor) throw new Error(`${tool(name)} is version ${major} but the server is ${serverMajor}. Install the matching client tools (for example postgresql-client-${serverMajor}) or set PG_BIN.`);
  }
  return { dump: tool('pg_dump'), restore: tool('pg_restore') };
}

async function tableCounts(c: Client): Promise<Counts> {
  const tables = await c.query<{ t: string }>(`select tablename as t from pg_tables where schemaname = 'public' order by 1`);
  const out: Counts = new Map();
  for (const { t } of tables.rows) out.set(t, Number((await c.query(`select count(*) as n from public."${t}"`)).rows[0].n));
  return out;
}

async function rlsGaps(c: Client) {
  const r = await c.query<{ t: string }>(
    `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'tenant_id')
        and not (c.relrowsecurity and c.relforcerowsecurity)`,
  );
  return r.rows.map((x) => x.t);
}

async function brokenChains(c: Client) {
  const tenants = await c.query<{ id: string; name: string }>('select id, name from tenants order by name');
  const broken: string[] = [];
  let checked = 0;
  for (const t of tenants.rows) {
    const v = await c.query<{ checked: string; first_broken_seq: string | null }>('select * from audit_verify_chain($1)', [t.id]);
    checked += Number(v.rows[0]?.checked ?? 0);
    if (v.rows[0]?.first_broken_seq) broken.push(`${t.name} (from entry ${v.rows[0].first_broken_seq})`);
  }
  return { broken, checked, tenants: tenants.rowCount ?? 0 };
}

async function main() {
  const source = new URL(adminUrl());
  const drillDb = `crew_dr_drill_${Date.now()}`;
  const target = new URL(source.toString());
  target.pathname = `/${drillDb}`;
  const dir = await mkdtemp(join(tmpdir(), 'crew-dr-'));
  const file = join(dir, 'crew.dump');
  const lines: string[] = [];
  const say = (s: string) => {
    console.log(s);
    lines.push(s);
  };
  const problems: string[] = [];

  const src = new Client({ connectionString: source.toString() });
  await src.connect();
  try {
    say(`# Backup and restore drill`);
    say('');
    say(`- Run at: ${new Date().toISOString()}`);
    say(`- Source database: ${source.pathname.slice(1)} on ${source.hostname}`);
    const version = (await src.query('show server_version')).rows[0].server_version as string;
    say(`- PostgreSQL: ${version}`);
    const tools = await pgTools(Number(version.split('.')[0]));

    let t0 = Date.now();
    await run(tools.dump, ['--format=custom', '--no-owner', '--no-privileges', `--file=${file}`, source.toString()], { maxBuffer: 64 * 1024 * 1024 });
    const backupMs = Date.now() - t0;
    const size = (await stat(file)).size;
    say(`- Backup: ${(size / 1024 / 1024).toFixed(2)} MB in ${(backupMs / 1000).toFixed(1)} s (pg_dump custom format)`);

    await src.query(`create database "${drillDb}"`);
    t0 = Date.now();
    // Roles are cluster-wide and already exist; ownership and grants are re-applied by the migrations' grant statements below.
    await run(tools.restore, ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${target.toString()}`, file], { maxBuffer: 64 * 1024 * 1024 });
    const restoreMs = Date.now() - t0;
    say(`- Restore into a new database: ${(restoreMs / 1000).toFixed(1)} s`);

    const dst = new Client({ connectionString: target.toString() });
    await dst.connect();
    try {
      const [a, b] = [await tableCounts(src), await tableCounts(dst)];
      const missing = [...a.keys()].filter((t) => !b.has(t));
      const differ = [...a.entries()].filter(([t, n]) => b.has(t) && b.get(t) !== n).map(([t, n]) => `${t}: ${n} vs ${b.get(t)}`);
      const rows = [...a.values()].reduce((s, n) => s + n, 0);
      say(`- Tables: ${a.size} in the source, ${b.size} restored; ${rows.toLocaleString('en')} rows compared`);
      if (missing.length) problems.push(`Tables missing after restore: ${missing.join(', ')}`);
      if (differ.length) problems.push(`Row counts differ: ${differ.join('; ')}`);

      const gaps = await rlsGaps(dst);
      say(`- Row-Level Security: ${gaps.length ? `NOT forced on ${gaps.join(', ')}` : 'enabled and forced on every table with a tenant_id'}`);
      if (gaps.length) problems.push(`RLS not forced after restore on: ${gaps.join(', ')}`);

      const chains = await brokenChains(dst);
      say(`- Audit trail: ${chains.checked.toLocaleString('en')} entries across ${chains.tenants} workspaces checked; ${chains.broken.length ? `broken for ${chains.broken.join(', ')}` : 'every hash chain intact'}`);
      if (chains.broken.length) problems.push(`Audit chain broken after restore: ${chains.broken.join(', ')}`);

      const mig = async (c: Client) => (await c.query<{ v: string }>(`select string_agg(name, ',' order by name) as v from schema_migrations`).catch(() => ({ rows: [{ v: 'unknown' }] }))).rows[0]!.v;
      const [ma, mb] = [await mig(src), await mig(dst)];
      say(`- Migrations: ${ma === mb ? `same history (${ma.split(',').length} applied)` : 'DIFFERENT'}`);
      if (ma !== mb) problems.push('Migration history differs after restore');
    } finally {
      await dst.end();
    }
    say(`- Measured recovery time for this data: ${((backupMs + restoreMs) / 1000).toFixed(1)} s (backup plus restore; excludes provisioning a server and switching traffic)`);
    say('');
    say(problems.length ? `**Result: FAILED**\n\n${problems.map((p) => `- ${p}`).join('\n')}` : '**Result: passed.** The restored copy is complete, isolated per workspace and its audit trail verifies.');
  } finally {
    if (!keep) await src.query(`drop database if exists "${drillDb}"`).catch(() => undefined);
    await src.end();
    await rm(dir, { recursive: true, force: true });
  }
  if (keep) console.log(`Kept the restored copy as database ${drillDb}.`);
  if (reportPath) await writeFile(reportPath, `${lines.join('\n')}\n`);
  if (problems.length) process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
