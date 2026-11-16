/**
 * Manages installation-wide integrations from a terminal, for automated setups and scripted tests. People normally use
 * the Super Admin Console > Integrations instead; both write the same encrypted database records, with the same
 * checks, and both are in the platform audit log. Nothing here reads keys from the environment or a file on disk:
 * values are given on the command line or piped in.
 *
 *   node dist/cli/integrations.js list
 *   node dist/cli/integrations.js set <key> '<json>'      e.g. set scanning '{"enabled":true,"url":"tcp://clamav:3310"}'
 *   node dist/cli/integrations.js set <key> -             the JSON on standard input (keeps keys out of shell history)
 *   node dist/cli/integrations.js test <key>              tests what is saved against the real service
 *   node dist/cli/integrations.js remove <key>
 *
 * In production (infra/deploy):  docker compose exec -T api node dist/cli/integrations.js ...
 *
 * <key> is one of ai, email, push, scanning, mobile_sso, razorpay, stripe, backups. The JSON has the fields the Console
 * form sends (packages/contracts/src/platform-integrations.ts). Secret fields left out keep the saved secret.
 * Exit codes: 0 done, 1 refused or failed (the reason is printed), 2 usage error.
 */
import { hostname, userInfo } from 'node:os';
import { PLATFORM_INTEGRATION_KEYS, type PlatformIntegrationKey } from '@crew/contracts';
import { AuditService } from '../platform/audit/audit.service';
import { loadConfig } from '../platform/config/config';
import { loadInstanceSecrets } from '../platform/config/instance-secrets';
import { MongoService as DatabaseService } from '../platform/database/mongo.service';
import { PlatformIntegrationsService } from '../platform/integrations/platform-integrations.service';

class UsageError extends Error {}

const USAGE = 'Usage: integrations.js list | set <key> <json|-> | test <key> | remove <key>';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function operator(): string {
  let user = 'unknown';
  try {
    user = userInfo().username;
  } catch {
    /* no user name in some containers */
  }
  return `integrations command (${user}@${hostname()})`;
}

async function main(argv: string[]): Promise<number> {
  const [command, key, value] = argv;
  if (!command || !['list', 'set', 'test', 'remove'].includes(command)) throw new UsageError(USAGE);
  if (command !== 'list' && !(PLATFORM_INTEGRATION_KEYS as readonly string[]).includes(key ?? '')) throw new UsageError(`Give one of: ${PLATFORM_INTEGRATION_KEYS.join(', ')}`);
  const config = await loadInstanceSecrets(loadConfig(), (m) => console.warn(m));
  const db = new DatabaseService(config);
  const integrations = new PlatformIntegrationsService(db, new AuditService(), config);
  const label = operator();
  try {
    if (command === 'list') {
      for (const v of await integrations.list()) {
        const secrets = Object.entries(v.secrets).filter(([, s]) => s.set).map(([k, s]) => `${k} ${s.hint}`).join(', ');
        console.log(`${v.key.padEnd(11)} ${(v.enabled ? 'on' : 'off').padEnd(4)} ${v.source.padEnd(8)} ${JSON.stringify(v.settings)}${secrets ? `  secrets: ${secrets}` : ''}`);
      }
      return 0;
    }
    const k = key as PlatformIntegrationKey;
    if (command === 'set') {
      if (!value) throw new UsageError('Give the settings as JSON, or - to read them from standard input');
      let body: unknown;
      try {
        body = JSON.parse(value === '-' ? await readStdin() : value);
      } catch {
        throw new UsageError('The settings are not valid JSON');
      }
      const v = await integrations.save(k, body, { label });
      console.log(`Saved ${k}: ${v.enabled ? 'on' : 'off'}.`);
      return 0;
    }
    if (command === 'test') {
      const saved = (await integrations.list()).find((v) => v.key === k)!;
      const r = await integrations.test(k, { ...saved.settings, enabled: saved.enabled }, {});
      console.log(`${r.ok ? 'Works' : 'Failed'}: ${r.detail}`);
      return r.ok ? 0 : 1;
    }
    await integrations.reset(k, { label });
    console.log(`Removed the saved setting for ${k}.`);
    return 0;
  } finally {
    await db.onModuleDestroy();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error & { details?: Array<{ path: string; message: string }> }) => {
    if (e instanceof UsageError) {
      console.error(e.message);
      process.exit(2);
    }
    const details = (e as { response?: { details?: Array<{ path: string; message: string }> } }).response?.details ?? e.details;
    console.error(`Refused: ${e.message}${details?.length ? `\n${details.map((d) => `  ${d.path}: ${d.message}`).join('\n')}` : ''}`);
    process.exit(1);
  },
);
