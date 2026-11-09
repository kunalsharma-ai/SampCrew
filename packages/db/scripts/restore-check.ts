import { verifyAuditChain } from '../src/mongo/audit-chain';
import { TABLES } from '../src/mongo/schema.generated';
import { connect } from './env';

/**
 * Checks used by infra/deploy/scripts/restore.sh on the database named in MONGODB_URL.
 *
 *   restore-check.ts --must-be-empty    fails unless the database has no collections (a restore never overwrites)
 *   restore-check.ts --print-database   prints the database name
 *   restore-check.ts --print-server-url prints MONGODB_URL without the database path (mongorestore reads that path
 *                                       as a filter), keeping the database it signs in to
 *   restore-check.ts                    after a restore: every SampCrew collection exists with its validator, and
 *                                       every workspace's audit trail and the platform's verifies
 */
/** The URL without its database path. A user signs in where the path pointed unless authSource says otherwise, so that is kept. */
export function serverUrl(url: string, database: string): string {
  const m = /^(mongodb(?:\+srv)?:\/\/)([^/?]*)(?:\/[^?]*)?(?:\?(.*))?$/.exec(url);
  if (!m) throw new Error('MONGODB_URL is not a valid connection URL');
  const [, scheme, hosts, query = ''] = m;
  const params = new URLSearchParams(query);
  if (hosts!.includes('@') && !params.has('authSource')) params.set('authSource', database);
  const q = params.toString();
  return `${scheme}${hosts}/${q ? `?${q}` : ''}`;
}

async function main() {
  const { client, db, name } = connect('crew-restore-check');
  const mode = process.argv[2];
  if (mode === '--print-database') {
    console.log(name);
    return;
  }
  if (mode === '--print-server-url') {
    console.log(serverUrl(process.env.MONGODB_URL!, name));
    return;
  }
  await client.connect();
  try {
    const collections = await db.listCollections({}, { nameOnly: false }).toArray();
    if (mode === '--must-be-empty') {
      if (collections.length) throw new Error(`refusing to restore: database ${name} already has ${collections.length} collections. Restore into a new, empty database.`);
      return;
    }
    const byName = new Map(collections.map((c) => [c.name, c as { options?: { validator?: unknown } }]));
    const missing = Object.keys(TABLES).filter((t) => !byName.has(t));
    const unvalidated = Object.keys(TABLES).filter((t) => byName.has(t) && !byName.get(t)!.options?.validator);
    if (missing.length) throw new Error(`check failed: collections missing after restore: ${missing.join(', ')}`);
    if (unvalidated.length) throw new Error(`check failed: collections without their validator: ${unvalidated.join(', ')}`);
    const tenants = await db.collection<{ _id: string; name: string }>('tenants').find({}, { projection: { name: 1 } }).toArray();
    const broken: string[] = [];
    for (const [id, label] of [[null, 'the platform'] as const, ...tenants.map((t) => [t._id, t.name] as const)]) {
      if ((await verifyAuditChain(db, id)).firstBrokenSeq !== null) broken.push(label);
    }
    if (broken.length) throw new Error(`check failed: audit trail does not verify for ${broken.join(', ')}`);
    const employees = await db.collection('employees').countDocuments();
    console.log(`restore verified: ${Object.keys(TABLES).length} collections with their validators, ${tenants.length} workspaces, ${employees} employees, every audit trail intact`);
  } finally {
    await client.close();
  }
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
