/**
 * Console admin recovery command: manages SAMPLEDGE Super Admin Console accounts straight in the database, for when
 * nobody can sign in to the console (the only Super admin lost their phone, forgot their password, left, or is
 * locked out). Day-to-day changes belong in Console > Console admins, where another admin makes them.
 *
 *   pnpm db:admin list
 *   pnpm db:admin create --email ops@sampledge.com --name "Asha Rao" [--role super_admin]
 *   pnpm db:admin reset-password --email ops@sampledge.com
 *   pnpm db:admin reset-mfa --email ops@sampledge.com
 *   pnpm db:admin unlock --email ops@sampledge.com
 *   pnpm db:admin set-role --email ops@sampledge.com --role support
 *   pnpm db:admin disable --email ops@sampledge.com
 *   pnpm db:admin enable --email ops@sampledge.com
 *
 * In production (infra/deploy):  docker compose run --rm migrate /app/infra/deploy/scripts/admin.sh <command> ...
 *
 * create and reset-password print a one-time temporary password (or take CREW_ADMIN_PASSWORD from the environment);
 * the admin must choose their own at the next sign-in and set up two-step verification if it is not on. Every change
 * signs the admin out everywhere and is written to the platform audit trail as done by "recovery command". The last
 * active Super admin cannot be disabled or demoted. MONGODB_URL must reach the SampCrew database.
 */
import { randomBytes } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { hash } from '@node-rs/argon2';
import { password as passwordRule, PLATFORM_ROLES } from '@crew/contracts';
import type { ClientSession, Db, MongoClient } from 'mongodb';
import { appendAuditEvent, linkAuditChain, Table } from '../src/mongo';
import { connect } from './env';

const COMMANDS = ['list', 'create', 'reset-password', 'reset-mfa', 'unlock', 'set-role', 'disable', 'enable'] as const;
type Command = (typeof COMMANDS)[number];

interface AdminDoc {
  id: string; email: string; full_name: string; role: string; status: 'active' | 'disabled'; mfa_enabled: boolean;
  must_change_password: boolean | null; locked_until: Date | null; last_login_at: Date | null;
}

class UsageError extends Error {}

/** argon2id with the API's parameters (apps/api/src/platform/auth/crypto.ts), so either side can verify the hash. */
const hashPassword = (p: string) => hash(p, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new UsageError(`Unexpected argument "${a}"`);
    const [k, inline] = a.slice(2).split('=', 2);
    const v = inline ?? rest[++i];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`--${k} needs a value`);
    flags[k!] = v;
  }
  if (!command || !(COMMANDS as readonly string[]).includes(command)) throw new UsageError(command ? `Unknown command "${command}"` : 'Give a command');
  return { command: command as Command, flags };
}

/** A temporary password that passes the console's password rule: 24 random characters plus one of each kind. */
function temporaryPassword(): string {
  for (;;) {
    const p = `${randomBytes(18).toString('base64url')}-a7Q`;
    if (passwordRule.safeParse(p).success) return p;
  }
}

function chosenPassword(): { value: string; generated: boolean } {
  const given = process.env.CREW_ADMIN_PASSWORD;
  if (!given) return { value: temporaryPassword(), generated: true };
  const ok = passwordRule.safeParse(given);
  if (!ok.success) throw new UsageError(`CREW_ADMIN_PASSWORD: ${ok.error.issues[0]!.message}`);
  return { value: given, generated: false };
}

function role(flags: Record<string, string>, fallback?: string): string {
  const r = flags.role ?? fallback;
  if (!r || !(PLATFORM_ROLES as readonly string[]).includes(r)) throw new UsageError(`--role must be one of ${PLATFORM_ROLES.join(', ')}`);
  return r;
}

function email(flags: Record<string, string>): string {
  const e = flags.email?.trim().toLowerCase();
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new UsageError('--email must be an email address');
  return e;
}

const operator = () => {
  let user = 'unknown';
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry (some containers): keep "unknown".
  }
  return `recovery command (${user}@${hostname()})`;
};

export async function run(argv: string[], ctx: { client: MongoClient; db: Db; print: (line: string) => void }): Promise<void> {
  const { client, db, print } = ctx;
  const { command, flags } = parseArgs(argv);

  if (command === 'list') {
    const rows = await db.collection<AdminDoc>('platform_admins').find({}, { sort: { email: 1 } }).toArray();
    if (!rows.length) print('No console admins yet. Create the first with: create --email <address> --name "<full name>"');
    for (const a of rows) {
      const flagsText = [
        a.status === 'disabled' && 'DISABLED',
        !a.mfa_enabled && 'no two-step verification',
        a.must_change_password && 'temporary password',
        a.locked_until && a.locked_until > new Date() && 'LOCKED',
      ].filter(Boolean).join(', ');
      print(`${a.email.padEnd(36)} ${a.role.padEnd(12)} ${a.full_name}${flagsText ? `  [${flagsText}]` : ''}  last sign-in: ${a.last_login_at?.toISOString() ?? 'never'}`);
    }
    return;
  }

  const address = email(flags);
  const label = operator();
  let printed: string[] = [];

  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      printed = [];
      const admins = new Table<AdminDoc>(db, 'platform_admins', session, { scope: null });
      const audit = (action: string, id: string, changes: Record<string, unknown>) =>
        appendAuditEvent(db, session, {
          tenant_id: null, actor_type: 'system', actor_id: null, actor_label: label, action, resource_type: 'platform_admin', resource_id: id,
          changes: { email: address, ...changes }, metadata: { via: 'recovery_command' }, ip: null, user_agent: null, request_id: null,
        });

      if (command === 'create') {
        if (await admins.exists({ email: address })) throw new UsageError(`${address} is already a console admin (use reset-password or enable)`);
        const fullName = flags.name?.trim();
        if (!fullName) throw new UsageError('--name is required');
        const r = role(flags, 'super_admin');
        const pw = chosenPassword();
        const row = await admins.insert({ email: address, full_name: fullName, role: r, password_hash: await hashPassword(pw.value), must_change_password: true });
        await audit('platform.admin_created', row.id, { role: r });
        printed.push(`Created ${r} ${address}.`, ...passwordLines(pw));
        return;
      }

      const target = await admins.findOne({ email: address });
      if (!target) throw new UsageError(`No console admin with email ${address} (run list)`);

      if (command === 'reset-password') {
        const pw = chosenPassword();
        await admins.updateOne({ id: target.id }, { $set: { password_hash: await hashPassword(pw.value), must_change_password: true, failed_login_count: 0, locked_until: null } });
        await signOut(db, session, target.id);
        await audit('platform.admin_password_reset', target.id, {});
        printed.push(`Password reset for ${address}. They were signed out everywhere.`, ...passwordLines(pw));
      } else if (command === 'reset-mfa') {
        await admins.updateOne({ id: target.id }, { $set: { mfa_enabled: false, mfa_secret_enc: null, failed_login_count: 0, locked_until: null } });
        await signOut(db, session, target.id);
        await audit('platform.admin_mfa_reset', target.id, {});
        printed.push(`Two-step verification removed for ${address}. They set it up again at their next sign-in.`);
      } else if (command === 'unlock') {
        await admins.updateOne({ id: target.id }, { $set: { failed_login_count: 0, locked_until: null } });
        await audit('platform.admin_unlocked', target.id, {});
        printed.push(`${address} can sign in again.`);
      } else if (command === 'enable') {
        if (target.status === 'active') {
          printed.push(`${address} is already active.`);
          return;
        }
        await admins.updateOne({ id: target.id }, { $set: { status: 'active', failed_login_count: 0, locked_until: null } });
        await audit('platform.admin_enabled', target.id, { status: 'active' });
        printed.push(`${address} is active again.`);
      } else if (command === 'disable' || command === 'set-role') {
        const next = command === 'disable' ? { role: target.role, status: 'disabled' as const } : { role: role(flags), status: target.status };
        if (next.role === target.role && next.status === target.status) {
          printed.push(`${address} is already ${command === 'disable' ? 'disabled' : `a ${next.role}`}.`);
          return;
        }
        if (target.role === 'super_admin' && target.status === 'active' && (next.role !== 'super_admin' || next.status !== 'active')) {
          const others = await admins.find({ role: 'super_admin', status: 'active', id: { $ne: target.id } }, { projection: { id: 1 } });
          for (const o of others) await admins.lock({ id: o.id, role: 'super_admin', status: 'active' });
          if (!(await admins.count({ role: 'super_admin', status: 'active', id: { $ne: target.id } }))) {
            throw new UsageError(`${address} is the last active Super admin. Create or promote another one first.`);
          }
        }
        const changes = command === 'disable' ? { status: 'disabled' } : { role: next.role };
        await admins.updateOne({ id: target.id }, { $set: changes });
        await signOut(db, session, target.id);
        await audit(command === 'disable' ? 'platform.admin_disabled' : 'platform.admin_updated', target.id, changes);
        printed.push(command === 'disable' ? `${address} is disabled and was signed out everywhere.` : `${address} is now a ${next.role}. They were signed out everywhere.`);
      }
    });
  } finally {
    await session.endSession();
  }
  await linkAuditChain(client, db, null);
  for (const line of printed) print(line);
}

function passwordLines(pw: { value: string; generated: boolean }): string[] {
  return pw.generated
    ? [`Temporary password (shown once, share it over a secure channel): ${pw.value}`, 'They must choose a new password at their next sign-in.']
    : ['Password set from CREW_ADMIN_PASSWORD. They must choose a new one at their next sign-in.'];
}

async function signOut(db: Db, session: ClientSession, adminId: string) {
  await new Table(db, 'platform_sessions', session, { scope: null }).update({ admin_id: adminId, revoked_at: null }, { $set: { revoked_at: new Date() } });
}

const USAGE = `Usage: pnpm db:admin <command> [--email <address>] [--name "<full name>"] [--role <role>]
Commands: ${COMMANDS.join(', ')}
Roles: ${PLATFORM_ROLES.join(', ')} (create defaults to super_admin)`;

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === 'help') {
    console.log(USAGE);
    return;
  }
  const { client, db } = connect('crew-admin-recovery');
  await client.connect();
  try {
    await run(argv, { client, db, print: (l) => console.log(l) });
  } finally {
    await client.close();
  }
}

if (process.argv[1] && /platform-admin\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
