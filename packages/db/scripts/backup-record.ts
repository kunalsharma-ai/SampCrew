import { prepareInsert, tableSpec } from '../src/mongo/engine';
import { connect } from './env';

/**
 * Records one run of infra/deploy/scripts/backup.sh in backup_runs, for the Console's System health page:
 *
 *   backup-record.ts '{"started_at":"...","status":"ok","db_file":"crew-db-....archive.gz.enc","db_bytes":123,...}'
 *
 * Keeps the last KEEP runs. A failure to record never fails the backup itself (backup.sh ignores the exit code), but
 * it is printed, because then the health page shows an old backup.
 */
const KEEP = 1000;

async function main() {
  const run = JSON.parse(process.argv[2] ?? '{}') as Record<string, unknown>;
  const { client, db } = connect('crew-backup');
  await client.connect();
  try {
    const doc = prepareInsert('backup_runs', tableSpec('backup_runs'), { ...run, finished_at: new Date() });
    await db.collection('backup_runs').insertOne(doc);
    const old = await db.collection('backup_runs').find({}, { projection: { _id: 1 } }).sort({ finished_at: -1 }).skip(KEEP).toArray();
    if (old.length) await db.collection('backup_runs').deleteMany({ _id: { $in: old.map((o) => o._id) } });
  } finally {
    await client.close();
  }
}
main().catch((e) => {
  console.error(`could not record the backup run: ${(e as Error).message}`);
  process.exit(1);
});
