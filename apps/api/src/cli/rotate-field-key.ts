/**
 * Rotates the field encryption key, which is kept in the database (field_keys; docs/ops/runbook.md, "Secrets"):
 *
 *   node dist/cli/rotate-field-key.js --new       1. add a new random key as the current one (old keys stay readable)
 *                                                 2. restart every API server (docker compose restart api) so all use it
 *   node dist/cli/rotate-field-key.js             3. re-encrypt every value still on an older key
 *   node dist/cli/rotate-field-key.js --retire    4. drop the old keys (refused while any value still needs one)
 *   node dist/cli/rotate-field-key.js --check     count the values still on an older key (exit code 2 while any remain)
 *
 * Each step is recorded in the platform audit log. Reads only the database connection from the environment.
 */
import { addFieldKey, mongo, readFieldKeys, retireOldFieldKeys } from '@crew/db';
import { AuditService } from '../platform/audit/audit.service';
import { currentKeyId, fieldKeyStatus, rotateFieldKeys } from '../platform/auth/field-key-rotation';
import { loadConfig } from '../platform/config/config';
import { loadInstanceSecrets } from '../platform/config/instance-secrets';
import { MongoService as DatabaseService } from '../platform/database/mongo.service';

async function withRawDb<T>(url: string, fn: (db: import('mongodb').Db) => Promise<T>): Promise<T> {
  const client = mongo.createMongoClient({ url, appName: 'crew-rotate-field-key', maxPoolSize: 2 });
  await client.connect();
  try {
    return await fn(client.db(mongo.databaseName(url)));
  } finally {
    await client.close();
  }
}

async function main() {
  const config = await loadInstanceSecrets(loadConfig(), (m) => console.warn(m));
  const db = new DatabaseService(config);
  const audit = (action: string, keyId: string, metadata: Record<string, unknown>) =>
    db.platform((tx) => new AuditService().record(tx, { tenantId: null, action, resourceType: 'field_encryption_key', resourceId: keyId, actorLabel: 'rotate-field-key command', metadata }));
  try {
    if (process.argv.includes('--new')) {
      const ring = await withRawDb(config.MONGODB_URL, addFieldKey);
      await audit('platform.field_key_added', ring[0]!.id, { keyId: ring[0]!.id, previous: ring.slice(1).map((k) => k.id) });
      console.log(`Added key ${ring[0]!.id}; ${ring.length - 1} older key(s) kept for reading.`);
      console.log('Next: restart every API server (docker compose restart api), then run this command without options.');
      return;
    }
    if (process.argv.includes('--retire')) {
      const left = (await fieldKeyStatus(db, config.fieldKeys)).reduce((a, r) => a + r.pending, 0);
      const saved = await withRawDb(config.MONGODB_URL, readFieldKeys);
      if (saved && saved[0]!.id !== currentKeyId(config.fieldKeys)) throw new Error('This command started before the newest key was added; run it again');
      if (left) {
        console.log(`${left} value(s) still need an older key; run this command without options first.`);
        process.exitCode = 2;
        return;
      }
      const r = await withRawDb(config.MONGODB_URL, retireOldFieldKeys);
      if (r.removed.length) await audit('platform.field_key_retired', r.kept.id, { keyId: r.kept.id, removed: r.removed });
      console.log(r.removed.length ? `Removed ${r.removed.length} old key(s); ${r.kept.id} is the only key.` : `Nothing to remove; ${r.kept.id} is the only key.`);
      return;
    }
    const check = process.argv.includes('--check');
    const results = check ? await fieldKeyStatus(db, config.fieldKeys) : await rotateFieldKeys(db, config.fieldKeys);
    console.log(`Current key id: ${currentKeyId(config.fieldKeys)}`);
    for (const r of results) console.log(`  ${r.table}.${r.column}: ${r.pending} on an older key${check ? '' : `, ${r.rewritten} rewritten`}`);
    const left = check ? results.reduce((a, r) => a + r.pending, 0) : (await fieldKeyStatus(db, config.fieldKeys)).reduce((a, r) => a + r.pending, 0);
    console.log(left ? `${left} value(s) still on an older key.` : 'Every value is on the current key; run this command with --retire to drop the old keys.');
    process.exitCode = left ? 2 : 0;
  } finally {
    await db.onModuleDestroy();
  }
}

main().catch((e) => {
  console.error(`Key rotation failed: ${(e as Error).message}`);
  process.exit(1);
});
