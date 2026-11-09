/**
 * Backup and restore drill. Takes a full backup of the database with mongodump, restores it into a separate,
 * new database with mongorestore, and checks the copy is complete and still safe to run:
 *
 *   - the same collections, and the same number of documents in every collection;
 *   - every collection keeps its validator (types, required fields, CHECK rules) and its indexes, including the
 *     unique ones that keep workspaces apart;
 *   - every workspace's audit trail hash chain, and the platform's, still verifies;
 *   - the migration history matches.
 *
 * It reports how long the backup and the restore took (a measured recovery time for this data size) and writes a
 * Markdown report. It never touches the source database beyond reading it, and drops the drill copy afterwards
 * unless --keep is given.
 *
 *   pnpm --filter @crew/db dr-drill [--report docs/ops/dr-drill-latest.md] [--keep]
 *
 * mongodump and mongorestore (MongoDB Database Tools) come from MONGO_TOOLS when set, else the PATH. This proves
 * the backup format and the restore procedure. It does not replace drills of the production cluster's own
 * point-in-time recovery, which must be run there.
 */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from 'mongodb';
import { canonicalJson } from '../src/mongo/canonical';
import { verifyAuditChain } from '../src/mongo/audit-chain';
import { MIGRATIONS_COLLECTION } from '../src/mongo/migrator';
import { connect } from './env';

const args = process.argv.slice(2);
const reportPath = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined;
const keep = args.includes('--keep');
const tool = (name: string) => (process.env.MONGO_TOOLS ? join(process.env.MONGO_TOOLS, name) : name);

/** Runs a database tool with the archive streamed through stdout (dump) or stdin (restore), so it also works through a wrapper such as `docker exec -i`. */
function runTool(name: string, toolArgs: string[], io: { out?: string; in?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool(name), toolArgs, { stdio: [io.in ? 'pipe' : 'ignore', io.out ? 'pipe' : 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += d));
    if (io.out) child.stdout!.pipe(createWriteStream(io.out));
    if (io.in) createReadStream(io.in).pipe(child.stdin!);
    child.on('error', (e) => reject(new Error(`${tool(name)} could not start (${e.message}). Install MongoDB Database Tools or set MONGO_TOOLS.`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} failed (exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`))));
  });
}

interface CollectionFacts {
  count: number;
  validator: string;
  indexes: string;
}

async function collectionFacts(db: Db): Promise<Map<string, CollectionFacts>> {
  const out = new Map<string, CollectionFacts>();
  const collections = (await db.listCollections({ type: 'collection' }).toArray()).filter((c) => !c.name.startsWith('system.'));
  for (const c of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    const coll = db.collection(c.name);
    const options = (c as { options?: { validator?: unknown } }).options ?? {};
    const indexes = (await coll.indexes()).map((i) => ({ name: i.name, key: i.key, unique: i.unique ?? false, partial: i.partialFilterExpression ?? null })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    out.set(c.name, { count: await coll.countDocuments(), validator: canonicalJson(options.validator ?? null), indexes: canonicalJson(indexes) });
  }
  return out;
}

async function brokenChains(db: Db) {
  const tenants = await db.collection<{ _id: string; name: string }>('tenants').find({}, { projection: { name: 1 } }).sort({ name: 1 }).toArray();
  const broken: string[] = [];
  let checked = 0;
  for (const [id, name] of [[null, 'the platform'] as const, ...tenants.map((t) => [t._id, t.name] as const)]) {
    const v = await verifyAuditChain(db, id);
    checked += v.checked;
    if (v.firstBrokenSeq !== null) broken.push(`${name} (from entry ${v.firstBrokenSeq})`);
  }
  return { broken, checked, tenants: tenants.length };
}

async function main() {
  const { client, db: src, name: sourceName } = connect('crew-dr-drill');
  const drillName = `crew_dr_drill_${Date.now()}`;
  const url = process.env.MONGODB_URL!;
  const dir = await mkdtemp(join(tmpdir(), 'crew-dr-'));
  const file = join(dir, 'crew.archive.gz');
  const lines: string[] = [];
  const say = (s: string) => {
    console.log(s);
    lines.push(s);
  };
  const problems: string[] = [];

  await client.connect();
  const dst = client.db(drillName);
  try {
    say(`# Backup and restore drill`);
    say('');
    say(`- Run at: ${new Date().toISOString()}`);
    say(`- Source database: ${sourceName} on ${new URL(url.replace(/^mongodb(\+srv)?:/, 'http:')).hostname}`);
    const info = await src.admin().command({ buildInfo: 1 });
    say(`- MongoDB: ${info.version as string}`);

    let t0 = Date.now();
    await runTool('mongodump', [`--uri=${url}`, `--db=${sourceName}`, '--archive', '--gzip'], { out: file });
    const backupMs = Date.now() - t0;
    const size = (await stat(file)).size;
    say(`- Backup: ${(size / 1024 / 1024).toFixed(2)} MB in ${(backupMs / 1000).toFixed(1)} s (mongodump archive, gzip)`);

    t0 = Date.now();
    await runTool('mongorestore', [`--uri=${url}`, '--archive', '--gzip', `--nsInclude=${sourceName}.*`, `--nsFrom=${sourceName}.*`, `--nsTo=${drillName}.*`, '--stopOnError'], { in: file });
    const restoreMs = Date.now() - t0;
    say(`- Restore into a new database: ${(restoreMs / 1000).toFixed(1)} s`);

    const [a, b] = [await collectionFacts(src), await collectionFacts(dst)];
    const missing = [...a.keys()].filter((t) => !b.has(t));
    const differ = [...a.entries()].filter(([t, f]) => b.has(t) && b.get(t)!.count !== f.count).map(([t, f]) => `${t}: ${f.count} vs ${b.get(t)!.count}`);
    const docs = [...a.values()].reduce((s, f) => s + f.count, 0);
    say(`- Collections: ${a.size} in the source, ${b.size} restored; ${docs.toLocaleString('en')} documents compared`);
    if (missing.length) problems.push(`Collections missing after restore: ${missing.join(', ')}`);
    if (differ.length) problems.push(`Document counts differ: ${differ.join('; ')}`);

    const lostValidators = [...a.entries()].filter(([t, f]) => b.has(t) && b.get(t)!.validator !== f.validator).map(([t]) => t);
    const lostIndexes = [...a.entries()].filter(([t, f]) => b.has(t) && b.get(t)!.indexes !== f.indexes).map(([t]) => t);
    const unvalidated = [...b.entries()].filter(([t, f]) => !t.startsWith('_') && f.validator === 'null').map(([t]) => t);
    say(`- Validators and indexes: ${lostValidators.length || lostIndexes.length || unvalidated.length ? 'DIFFERENT' : 'every collection has the same validator and indexes as the source'}`);
    if (lostValidators.length) problems.push(`Validators differ after restore on: ${lostValidators.join(', ')}`);
    if (lostIndexes.length) problems.push(`Indexes differ after restore on: ${lostIndexes.join(', ')}`);
    if (unvalidated.length) problems.push(`Collections without a validator: ${unvalidated.join(', ')}`);

    const chains = await brokenChains(dst);
    say(`- Audit trail: ${chains.checked.toLocaleString('en')} entries across ${chains.tenants} workspaces and the platform checked; ${chains.broken.length ? `broken for ${chains.broken.join(', ')}` : 'every hash chain intact'}`);
    if (chains.broken.length) problems.push(`Audit chain broken after restore: ${chains.broken.join(', ')}`);

    const mig = async (db: Db) => (await db.collection(MIGRATIONS_COLLECTION).find().sort({ _id: 1 }).toArray()).map((m) => `${m._id}:${m.checksum}`).join(',');
    const [ma, mb] = [await mig(src), await mig(dst)];
    say(`- Migrations: ${ma === mb ? `same history (${ma ? ma.split(',').length : 0} applied)` : 'DIFFERENT'}`);
    if (ma !== mb) problems.push('Migration history differs after restore');

    say(`- Measured recovery time for this data: ${((backupMs + restoreMs) / 1000).toFixed(1)} s (backup plus restore; excludes provisioning a server and switching traffic)`);
    say('');
    say(problems.length ? `**Result: FAILED**\n\n${problems.map((p) => `- ${p}`).join('\n')}` : '**Result: passed.** The restored copy is complete, keeps every rule and index, and its audit trail verifies.');
  } finally {
    if (!keep) await dst.dropDatabase().catch(() => undefined);
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
  if (keep) console.log(`Kept the restored copy as database ${drillName}.`);
  if (reportPath) await writeFile(reportPath, `${lines.join('\n')}\n`);
  if (problems.length) process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
