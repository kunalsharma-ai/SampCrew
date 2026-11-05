/**
 * Re-encrypts every encrypted field with the current FIELD_ENCRYPTION_KEY (docs/ops/runbook.md, "Secrets").
 *
 *   node dist/cli/rotate-field-key.js            rewrite values still on an older key
 *   node dist/cli/rotate-field-key.js --check    only count them (exit code 2 while any remain)
 *
 * Reads the same environment as the API. Before running, set FIELD_ENCRYPTION_KEY to the new key and
 * FIELD_ENCRYPTION_KEYS_PREVIOUS to the old one, and restart the API with both, so values are readable throughout.
 */
import { loadConfig } from '../platform/config/config';
import { DatabaseService } from '../platform/database/database.service';
import { currentKeyId, fieldKeyStatus, rotateFieldKeys } from '../platform/auth/field-key-rotation';

async function main() {
  const config = loadConfig();
  const db = new DatabaseService(config);
  try {
    const check = process.argv.includes('--check');
    const results = check ? await fieldKeyStatus(db, config.fieldKeys) : await rotateFieldKeys(db, config.fieldKeys);
    console.log(`Current key id: ${currentKeyId(config.fieldKeys)}`);
    for (const r of results) console.log(`  ${r.table}.${r.column}: ${r.pending} on an older key${check ? '' : `, ${r.rewritten} rewritten`}`);
    const left = check ? results.reduce((a, r) => a + r.pending, 0) : (await fieldKeyStatus(db, config.fieldKeys)).reduce((a, r) => a + r.pending, 0);
    console.log(left ? `${left} value(s) still on an older key.` : 'Every value is on the current key; FIELD_ENCRYPTION_KEYS_PREVIOUS can be emptied.');
    process.exitCode = left ? 2 : 0;
  } finally {
    await db.onModuleDestroy();
  }
}

main().catch((e) => {
  console.error(`Key rotation failed: ${(e as Error).message}`);
  process.exit(1);
});
