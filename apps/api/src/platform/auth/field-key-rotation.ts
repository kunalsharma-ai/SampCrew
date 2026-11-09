import { AuditService } from '../audit/audit.service';
import type { MongoService as DatabaseService } from '../database/mongo.service';
import { decryptField, encryptField, keyIdOf } from './crypto';

/**
 * Every column that holds a value from encryptField(). A new encrypted column must be added here, and
 * test/gaps.spec.ts fails if a `*_enc` column in the database is missing from this list.
 */
export const ENCRYPTED_COLUMNS: ReadonlyArray<{ table: string; key: string; column: string }> = [
  { table: 'users', key: 'id', column: 'mfa_secret_enc' },
  { table: 'platform_admins', key: 'id', column: 'mfa_secret_enc' },
  { table: 'employee_sensitive', key: 'employee_id', column: 'bank_account_enc' },
  { table: 'employee_sensitive', key: 'employee_id', column: 'bank_routing_enc' },
  { table: 'employee_sensitive', key: 'employee_id', column: 'tax_id_enc' },
  { table: 'employee_sensitive', key: 'employee_id', column: 'national_id_enc' },
  { table: 'webhook_endpoints', key: 'id', column: 'secret_enc' },
  { table: 'integration_connections', key: 'id', column: 'credentials_enc' },
  { table: 'sso_connections', key: 'id', column: 'client_secret_enc' },
  { table: 'sso_login_states', key: 'state_hash', column: 'code_verifier_enc' },
  { table: 'platform_integrations', key: 'key', column: 'secrets_enc' },
];

export interface RotationColumnResult {
  table: string;
  column: string;
  /** Values found on an older key (or written before key ids) before this run. */
  pending: number;
  /** Values rewritten with the current key. */
  rewritten: number;
}

/** Rows whose value in `column` is set but not on the key `current`. */
const notOnKey = (column: string, current: string) => ({ $and: [{ [column]: { $nin: ['', null] } }, { [column]: { $not: { $regex: `^v2\\.${current}\\.` } } }] });

/** How many values in each column are not yet on the current key. */
export async function fieldKeyStatus(db: DatabaseService, keys: string): Promise<RotationColumnResult[]> {
  const current = currentKeyId(keys);
  return db.platform(async (tx) => {
    const out: RotationColumnResult[] = [];
    for (const c of ENCRYPTED_COLUMNS) {
      out.push({ table: c.table, column: c.column, pending: await tx.collection(c.table).count(notOnKey(c.column, current)), rewritten: 0 });
    }
    return out;
  });
}

/**
 * Re-encrypts every value that is not on the current key (the first in `keys`), in batches of `batchSize` rows per
 * transaction so the API keeps working while it runs. A row changed meanwhile makes that batch retry. Safe to run again: values already on the current key are left alone.
 * A value no key in the ring can open stops the run with an error naming the table and row, and nothing in that
 * batch is changed.
 */
export async function rotateFieldKeys(db: DatabaseService, keys: string, opts: { batchSize?: number; dryRun?: boolean } = {}): Promise<RotationColumnResult[]> {
  const batchSize = opts.batchSize ?? 200;
  const current = currentKeyId(keys);
  const before = await fieldKeyStatus(db, keys);
  if (opts.dryRun) return before;
  const results: RotationColumnResult[] = [];
  for (const c of ENCRYPTED_COLUMNS) {
    const pending = before.find((b) => b.table === c.table && b.column === c.column)!.pending;
    let rewritten = 0;
    for (;;) {
      const n = await db.platform(async (tx) => {
        const table = tx.collection(c.table);
        const rows = await table.find(notOnKey(c.column, current), { sort: { [c.key]: 1 as const }, limit: batchSize, projection: { [c.key]: 1, [c.column]: 1 } });
        for (const row of rows) {
          let plain: string;
          try {
            plain = decryptField(row[c.column] as string, keys);
          } catch (e) {
            throw new Error(`${c.table}.${c.column} for ${c.key} ${row[c.key]} cannot be decrypted with the keys given (${(e as Error).message})`);
          }
          await table.updateOne({ [c.key]: row[c.key] }, { $set: { [c.column]: encryptField(plain, keys) } });
        }
        return rows.length;
      });
      rewritten += n;
      if (n < batchSize) break;
    }
    results.push({ table: c.table, column: c.column, pending, rewritten });
  }
  const total = results.reduce((a, r) => a + r.rewritten, 0);
  await db.platform(async (tx) => {
    await new AuditService().record(tx, {
      tenantId: null,
      action: 'platform.field_key_rotated',
      resourceType: 'field_encryption_key',
      resourceId: current,
      metadata: { keyId: current, rewritten: total, columns: results.filter((r) => r.rewritten).map((r) => `${r.table}.${r.column}:${r.rewritten}`) },
    });
  });
  return results;
}

export const currentKeyId = (keys: string) => keyIdOf(keys.split(',')[0]!.trim());
