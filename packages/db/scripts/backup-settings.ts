/**
 * Prints the off-site backup settings saved in Console > Integrations > Off-site backups as shell `export` lines, for
 * infra/deploy/scripts/backup.sh to eval before every off-site copy (so a change in the Console applies without a
 * restart):
 *
 *   eval "$(tsx scripts/backup-settings.ts)"
 *
 * The secrets are decrypted with the field encryption key ring the API keeps in the same database (field_keys), so
 * the backup service needs nothing but the database connection. They are printed only to the calling shell, never
 * logged.
 *
 * Moving an older install over: when nothing is saved yet and the service was started with the old BACKUP_REMOTE /
 * BACKUP_ALERT_WEBHOOK / RCLONE_CONFIG_OFFSITE_* variables (offsite.env), they are saved into the database once,
 * encrypted, with an audit event, and from then on only the database is used. A message on stderr says which lines
 * to delete.
 *
 * Exit codes: 0 settings printed (from the database), 3 the database could not be read or nothing usable is saved,
 * in which case backup.sh keeps the variables it was started with (the disaster-recovery path, when the database
 * itself is what is being restored).
 */
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { PLATFORM_INTEGRATIONS } from '@crew/contracts';
import { legacyOffsite, offsiteEnvironment, shellExports } from '../src/backup-offsite';
import { readFieldKeys, ringString } from '../src/field-keys';
import { decryptField, encryptField } from '../src/field-crypto';
import { appendAuditEvent, linkAuditChain, Table } from '../src/mongo';
import { connect } from './env';

interface Row { key: string; enabled: boolean; settings: Record<string, unknown>; secrets_enc: string }

const LEGACY_EXIT = 3;
const warn = (m: string) => process.stderr.write(`[backup-settings] ${m}\n`);

const hint = (v: string) => (v.length <= 8 ? '••••' : `••••${v.slice(-4)}`);

async function main(): Promise<number> {
  const { client, db } = connect('crew-backup-settings');
  await client.connect();
  try {
    const ring = await readFieldKeys(db);
    if (!ring) {
      warn('The database has no encryption key yet: start the API once (it creates one), and the off-site settings are read from the database from then on.');
      return LEGACY_EXIT;
    }
    const keys = ringString(ring);
    let row = (await db.collection<Row>('platform_integrations').findOne({ key: 'backups' })) as Row | null;
    if (!row) {
      const legacy = legacyOffsite(process.env);
      if (legacy.kind === 'none') {
        process.stdout.write(shellExports({ BACKUP_REMOTE: '', BACKUP_ALERT_WEBHOOK: '' }, process.env));
        return 0;
      }
      if (legacy.kind === 'unsupported') {
        warn(`The off-site storage set in offsite.env could not be moved into the database (${legacy.reason}). It is still used for now; set it up in Console > Integrations > Off-site backups, then delete offsite.env and the BACKUP_REMOTE / BACKUP_ALERT_WEBHOOK lines.`);
        return LEGACY_EXIT;
      }
      const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          const table = new Table<Row & Record<string, unknown>>(db, 'platform_integrations', session, { scope: null });
          if (await table.findOne({ key: 'backups' })) return; // the API or another run got there first
          await table.insert({
            key: 'backups', enabled: legacy.enabled, settings: legacy.settings,
            secrets_enc: Object.keys(legacy.secrets).length ? encryptField(JSON.stringify(legacy.secrets), keys) : '',
            secret_hints: Object.fromEntries(Object.entries(legacy.secrets).map(([k, v]) => [k, hint(v)])),
            config_hash: createHash('sha256').update(JSON.stringify([sorted(legacy.settings), sorted(legacy.secrets)])).digest('hex'),
            imported_from: legacy.variables, updated_by_label: `moved from the backup service's settings (${hostname()})`,
          });
          await appendAuditEvent(db, session, {
            tenant_id: null, actor_type: 'system', actor_id: null, actor_label: 'backup service', action: 'platform.integration_imported',
            resource_type: 'platform_integration', resource_id: 'backups', changes: { after: { enabled: legacy.enabled, settings: legacy.settings } },
            metadata: { variables: legacy.variables, secrets: Object.keys(legacy.secrets) }, ip: null, user_agent: null, request_id: null,
          });
        });
      } finally {
        await session.endSession();
      }
      await linkAuditChain(client, db, null);
      const def = PLATFORM_INTEGRATIONS.find((d) => d.key === 'backups')!;
      warn(`Moved the off-site backup settings (${legacy.variables.join(', ')}) into the database: they are managed in Console > Integrations > ${def.name} from now on. Delete offsite.env and the BACKUP_REMOTE, BACKUP_REMOTE_KEEP_DAYS and BACKUP_ALERT_WEBHOOK lines from .env.`);
      row = (await db.collection<Row>('platform_integrations').findOne({ key: 'backups' })) as Row | null;
      if (!row) return LEGACY_EXIT;
    }
    const secrets = row.secrets_enc ? (JSON.parse(decryptField(row.secrets_enc, keys)) as Record<string, string>) : {};
    process.stdout.write(shellExports(offsiteEnvironment(row.enabled, row.settings, secrets), process.env));
    return 0;
  } finally {
    await client.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    warn(`could not read the off-site backup settings from the database: ${(e as Error).message}`);
    process.exit(LEGACY_EXIT);
  },
);
