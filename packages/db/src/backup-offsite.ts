/**
 * The off-site backup storage saved in Console > Integrations > Off-site backups, turned into the settings the backup
 * service (infra/deploy/scripts/backup.sh) runs rclone with, and back: an older install's offsite.env and
 * BACKUP_REMOTE variables turned into a Console setting, so they can be moved into the database once.
 *
 * rclone reads a remote called "offsite" from RCLONE_CONFIG_OFFSITE_* variables (https://rclone.org/docs/#config-file);
 * backup.sh copies to BACKUP_REMOTE. Nothing here touches the network.
 */

export type OffsiteValues = Record<string, unknown>;
export type OffsiteSecrets = Record<string, string>;

/** The variables backup.sh runs with. An SFTP password is passed as OFFSITE_SFTP_PASSWORD for `rclone obscure`. */
export function offsiteEnvironment(enabled: boolean, settings: OffsiteValues, secrets: OffsiteSecrets): Record<string, string> {
  if (!enabled) return { BACKUP_REMOTE: '', BACKUP_ALERT_WEBHOOK: secrets.alertWebhook ?? '' };
  const path = String(settings.path ?? '').replace(/^\/+|\/+$/g, '');
  const join = (...parts: string[]) => parts.filter(Boolean).join('/');
  const env: Record<string, string> = {
    BACKUP_REMOTE_KEEP_DAYS: String(settings.keepDays ?? 30),
    BACKUP_ALERT_WEBHOOK: secrets.alertWebhook ?? '',
  };
  switch (settings.provider) {
    case 's3': {
      const endpoint = String(settings.endpoint ?? '');
      Object.assign(env, {
        RCLONE_CONFIG_OFFSITE_TYPE: 's3',
        RCLONE_CONFIG_OFFSITE_PROVIDER: endpoint ? 'Other' : 'AWS',
        RCLONE_CONFIG_OFFSITE_REGION: String(settings.region || 'us-east-1'),
        ...(endpoint ? { RCLONE_CONFIG_OFFSITE_ENDPOINT: endpoint } : {}),
        RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: String(settings.accessKeyId ?? ''),
        RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: secrets.secretAccessKey ?? '',
        // Buckets that refuse public ACLs (the default for new S3 buckets) fail rclone's bucket check otherwise.
        RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: 'true',
        BACKUP_REMOTE: `offsite:${join(String(settings.bucket), path)}`,
      });
      break;
    }
    case 'azure':
      Object.assign(env, {
        RCLONE_CONFIG_OFFSITE_TYPE: 'azureblob',
        RCLONE_CONFIG_OFFSITE_ACCOUNT: String(settings.account ?? ''),
        RCLONE_CONFIG_OFFSITE_KEY: secrets.accountKey ?? '',
        BACKUP_REMOTE: `offsite:${join(String(settings.bucket), path)}`,
      });
      break;
    case 'sftp':
      Object.assign(env, {
        RCLONE_CONFIG_OFFSITE_TYPE: 'sftp',
        RCLONE_CONFIG_OFFSITE_HOST: String(settings.host ?? ''),
        RCLONE_CONFIG_OFFSITE_PORT: String(settings.port ?? 22),
        RCLONE_CONFIG_OFFSITE_USER: String(settings.user ?? ''),
        ...(secrets.privateKey ? { RCLONE_CONFIG_OFFSITE_KEY_PEM: secrets.privateKey.replace(/\r?\n/g, '\\n') } : {}),
        ...(secrets.password ? { OFFSITE_SFTP_PASSWORD: secrets.password } : {}),
        BACKUP_REMOTE: `offsite:/${path}`,
      });
      break;
    case 'folder':
      Object.assign(env, { RCLONE_CONFIG_OFFSITE_TYPE: 'local', BACKUP_REMOTE: `offsite:/${path}` });
      break;
    default:
      throw new Error(`Unknown off-site storage provider ${String(settings.provider)}`);
  }
  return env;
}

/**
 * `export NAME='value'` lines for a POSIX shell to eval, first unsetting every RCLONE_CONFIG_OFFSITE_* variable the
 * process was started with (an old offsite.env), so only the saved setting applies.
 */
export function shellExports(env: Record<string, string>, inherited: NodeJS.ProcessEnv = {}): string {
  const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const lines: string[] = [];
  for (const name of Object.keys(inherited)) if (/^RCLONE_CONFIG_OFFSITE_[A-Z0-9_]+$/.test(name) && !(name in env)) lines.push(`unset ${name}`);
  if (!('OFFSITE_SFTP_PASSWORD' in env)) lines.push('unset OFFSITE_SFTP_PASSWORD');
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Bad variable name ${k}`);
    lines.push(`export ${k}=${quote(v)}`);
  }
  return `${lines.join('\n')}\n`;
}

export type LegacyOffsite =
  | { kind: 'none' }
  | { kind: 'importable'; variables: string[]; enabled: boolean; settings: OffsiteValues; secrets: OffsiteSecrets }
  | { kind: 'unsupported'; variables: string[]; reason: string };

/** Reads an older install's BACKUP_REMOTE, BACKUP_REMOTE_KEEP_DAYS, BACKUP_ALERT_WEBHOOK and RCLONE_CONFIG_OFFSITE_* variables. */
export function legacyOffsite(env: NodeJS.ProcessEnv): LegacyOffsite {
  const get = (k: string) => (env[k] ?? '').trim();
  const variables = Object.keys(env).filter((k) => (/^RCLONE_CONFIG_OFFSITE_/.test(k) || ['BACKUP_REMOTE', 'BACKUP_REMOTE_KEEP_DAYS', 'BACKUP_ALERT_WEBHOOK'].includes(k)) && get(k)).sort();
  const remote = get('BACKUP_REMOTE');
  const webhook = get('BACKUP_ALERT_WEBHOOK');
  if (!remote && !webhook) return { kind: 'none' };
  const keep = Number(get('BACKUP_REMOTE_KEEP_DAYS') || 30);
  const secrets: OffsiteSecrets = webhook ? { alertWebhook: webhook } : {};
  if (!remote) {
    // Only alerts were set up: keep them, with the copy off.
    return { kind: 'importable', variables, enabled: false, settings: { provider: 'folder', path: '/backups-offsite', keepDays: keep }, secrets };
  }
  const m = /^offsite:(.*)$/.exec(remote);
  if (!m) return { kind: 'unsupported', variables, reason: `BACKUP_REMOTE (${remote}) names a remote other than "offsite"` };
  const target = m[1]!.replace(/^\/+|\/+$/g, '');
  const [first, ...rest] = target.split('/');
  const type = get('RCLONE_CONFIG_OFFSITE_TYPE');
  const extra = (allowed: string[]) => Object.keys(env).filter((k) => k.startsWith('RCLONE_CONFIG_OFFSITE_') && get(k) && !allowed.includes(k.slice('RCLONE_CONFIG_OFFSITE_'.length)));
  const keepDays = Number.isFinite(keep) && keep >= 0 ? Math.round(keep) : 30;
  switch (type) {
    case 's3': {
      const others = extra(['TYPE', 'PROVIDER', 'REGION', 'ENDPOINT', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'NO_CHECK_BUCKET']);
      if (others.length) return { kind: 'unsupported', variables, reason: `${others.join(', ')} cannot be set in the Console` };
      if (!first || !get('RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID') || !get('RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY')) return { kind: 'unsupported', variables, reason: 'the S3 bucket, access key id or secret is missing' };
      const endpoint = get('RCLONE_CONFIG_OFFSITE_ENDPOINT');
      return {
        kind: 'importable', variables, enabled: true,
        settings: { provider: 's3', bucket: first, region: get('RCLONE_CONFIG_OFFSITE_REGION'), endpoint: endpoint && !/^https?:\/\//.test(endpoint) ? `https://${endpoint}` : endpoint, accessKeyId: get('RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID'), path: rest.join('/'), keepDays },
        secrets: { ...secrets, secretAccessKey: get('RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY') },
      };
    }
    case 'azureblob': {
      const others = extra(['TYPE', 'ACCOUNT', 'KEY']);
      if (others.length) return { kind: 'unsupported', variables, reason: `${others.join(', ')} cannot be set in the Console` };
      if (!first || !get('RCLONE_CONFIG_OFFSITE_ACCOUNT') || !get('RCLONE_CONFIG_OFFSITE_KEY')) return { kind: 'unsupported', variables, reason: 'the Azure account, key or container is missing' };
      return {
        kind: 'importable', variables, enabled: true,
        settings: { provider: 'azure', account: get('RCLONE_CONFIG_OFFSITE_ACCOUNT'), bucket: first, path: rest.join('/'), keepDays },
        secrets: { ...secrets, accountKey: get('RCLONE_CONFIG_OFFSITE_KEY') },
      };
    }
    case 'sftp': {
      // An rclone password (PASS) is stored obscured; it is not read back here, so such a setup stays as it is.
      const others = extra(['TYPE', 'HOST', 'PORT', 'USER', 'KEY_PEM']);
      if (others.length) return { kind: 'unsupported', variables, reason: `${others.join(', ')} cannot be moved automatically; enter the SFTP details in the Console` };
      if (!get('RCLONE_CONFIG_OFFSITE_HOST') || !get('RCLONE_CONFIG_OFFSITE_USER') || !get('RCLONE_CONFIG_OFFSITE_KEY_PEM') || !target) return { kind: 'unsupported', variables, reason: 'the SFTP host, user, key or folder is missing' };
      return {
        kind: 'importable', variables, enabled: true,
        settings: { provider: 'sftp', host: get('RCLONE_CONFIG_OFFSITE_HOST'), port: Number(get('RCLONE_CONFIG_OFFSITE_PORT') || 22), user: get('RCLONE_CONFIG_OFFSITE_USER'), path: `/${target}`, keepDays },
        secrets: { ...secrets, privateKey: get('RCLONE_CONFIG_OFFSITE_KEY_PEM').replace(/\\n/g, '\n') },
      };
    }
    case 'local': {
      const others = extra(['TYPE']);
      if (others.length) return { kind: 'unsupported', variables, reason: `${others.join(', ')} cannot be set in the Console` };
      return { kind: 'importable', variables, enabled: true, settings: { provider: 'folder', path: `/${target}`, keepDays }, secrets };
    }
    default:
      return { kind: 'unsupported', variables, reason: type ? `rclone storage type "${type}" cannot be set in the Console (S3-compatible, Azure Blob, SFTP and a local folder can)` : 'RCLONE_CONFIG_OFFSITE_TYPE is not set' };
  }
}
