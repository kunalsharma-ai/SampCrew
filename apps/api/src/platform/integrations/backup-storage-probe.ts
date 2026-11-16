import { createHash, createHmac } from 'node:crypto';
import { connect } from 'node:net';

type Values = Record<string, unknown>;
type Secrets = Record<string, string>;

const TIMEOUT = 15_000;
const CHECK_FILE = '.sampcrew-connection-check';
const CHECK_BODY = 'SampCrew checks here that the off-site backup storage accepts files. Safe to delete.\n';

/**
 * Console > Integrations > Off-site backups, Test connection: does what the backup service will do, with the values on
 * screen. Object storage (S3-compatible, Azure Blob) gets a small check file written, listed and deleted; SFTP gets
 * its SSH greeting checked (the sign-in itself is checked by the backup service's next copy, which System health
 * shows). Resolves with what worked, rejects with what did not.
 */
export async function probeBackupStorage(settings: Values, secrets: Secrets): Promise<string> {
  const path = String(settings.path ?? '').replace(/^\/+|\/+$/g, '');
  const object = path ? `${path}/${CHECK_FILE}` : CHECK_FILE;
  switch (settings.provider) {
    case 's3':
      return probeS3(settings, secrets, path, object);
    case 'azure':
      return probeAzure(settings, secrets, path, object);
    case 'sftp':
      return probeSsh(String(settings.host), Number(settings.port ?? 22));
    case 'folder':
      return `The folder ${settings.path} is on the backup server, so it is checked by the backup service's next copy (System health shows the result)`;
    default:
      throw new Error('Choose where the backups go');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// S3 and S3-compatible storage: AWS Signature Version 4 (https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html)
// ---------------------------------------------------------------------------------------------------------------

/** RFC 3986 encoding, as Signature Version 4 wants it. */
const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

export interface SignedRequest { url: string; headers: Record<string, string> }

/**
 * Signs one S3 request. `pathname` is the request path before encoding (e.g. /bucket/folder/file); `query` holds the
 * query parameters unencoded. Exported for the test against AWS's published example.
 */
export function signS3(opts: {
  method: string; origin: string; pathname: string; query?: Record<string, string>; region: string;
  accessKeyId: string; secretAccessKey: string; body?: string | Buffer; headers?: Record<string, string>; now?: Date;
}): SignedRequest {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const host = new URL(opts.origin).host;
  const payloadHash = sha256Hex(opts.body ?? '');
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])), host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const canonicalUri = opts.pathname.split('/').map(uriEncode).join('/') || '/';
  const query = Object.entries(opts.query ?? {}).map(([k, v]) => [uriEncode(k), uriEncode(v)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = query.map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [opts.method, canonicalUri, canonicalQuery, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${opts.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, day), opts.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  delete headers.host;
  return { url: `${opts.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`, headers };
}

async function probeS3(settings: Values, secrets: Secrets, path: string, object: string): Promise<string> {
  const bucket = String(settings.bucket);
  const region = String(settings.region || 'us-east-1');
  const endpoint = String(settings.endpoint ?? '').replace(/\/+$/, '');
  // Amazon: the bucket in the host name (dots in a bucket name break the certificate, so those use the path).
  // S3-compatible services: the bucket in the path, which is what rclone does for them.
  const virtualHost = !endpoint && !bucket.includes('.');
  const origin = endpoint || (virtualHost ? `https://${bucket}.s3.${region}.amazonaws.com` : `https://s3.${region}.amazonaws.com`);
  const prefix = virtualHost ? '' : `/${bucket}`;
  const where = endpoint ? `${bucket} on ${new URL(endpoint).host}` : `s3://${bucket}`;
  const call = async (method: string, key: string | null, query?: Record<string, string>, body?: string) => {
    const signed = signS3({ method, origin, pathname: `${prefix}/${key ?? ''}`, query, region, accessKeyId: String(settings.accessKeyId), secretAccessKey: secrets.secretAccessKey ?? '', body, headers: body ? { 'content-type': 'text/plain' } : {} });
    let res: Response;
    try {
      res = await fetch(signed.url, { method, headers: signed.headers, body, signal: AbortSignal.timeout(TIMEOUT), redirect: 'manual' });
    } catch (e) {
      throw new Error(`Could not reach ${origin}: ${(e as Error).cause instanceof Error ? ((e as Error).cause as Error).message : (e as Error).message}`);
    }
    const text = await res.text();
    return { status: res.status, text, code: /<Code>([^<]+)<\/Code>/.exec(text)?.[1], message: /<Message>([^<]+)<\/Message>/.exec(text)?.[1] };
  };
  const explain = (step: string, r: { status: number; code?: string; message?: string }) => {
    const known: Record<string, string> = {
      NoSuchBucket: `the bucket ${bucket} does not exist (check its name${endpoint ? '' : ' and region'})`,
      InvalidAccessKeyId: 'the access key id is not known to the storage service',
      SignatureDoesNotMatch: 'the secret access key does not match the access key id',
      AccessDenied: `the key may not ${step === 'write' ? 'write to' : step === 'list' ? 'list' : 'delete in'} this bucket or folder`,
      PermanentRedirect: `the bucket is in another region than ${region}`,
      AuthorizationHeaderMalformed: `the region ${region} is not the bucket's region`,
    };
    return new Error(`Could not ${step} ${where}: ${(r.code && known[r.code]) ?? r.message ?? r.code ?? `the service answered ${r.status}`}`);
  };
  const put = await call('PUT', object, undefined, CHECK_BODY);
  if (put.status !== 200) throw explain('write', put);
  const list = await call('GET', null, { 'list-type': '2', 'max-keys': '1', prefix: object });
  if (list.status !== 200) throw explain('list', list);
  const del = await call('DELETE', object);
  const target = `${where}${path ? `/${path}` : ''}`;
  if (del.status !== 204 && del.status !== 200) return `Wrote and listed a check file in ${target}, but could not delete it (${del.code ?? del.status}): old off-site copies will not be removed after the days you set, unless the bucket has its own lifecycle rule`;
  return `Wrote, listed and deleted a check file in ${target}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Azure Blob Storage: Shared Key (https://learn.microsoft.com/rest/api/storageservices/authorize-with-shared-key)
// ---------------------------------------------------------------------------------------------------------------

const AZURE_VERSION = '2021-08-06';

export function signAzure(opts: {
  method: string; account: string; accountKey: string; pathname: string; query?: Record<string, string>;
  headers?: Record<string, string>; contentLength?: number; contentType?: string; now?: Date;
}): SignedRequest {
  const headers: Record<string, string> = { 'x-ms-date': (opts.now ?? new Date()).toUTCString(), 'x-ms-version': AZURE_VERSION, ...opts.headers };
  const ms = Object.keys(headers).filter((k) => k.toLowerCase().startsWith('x-ms-')).map((k) => [k.toLowerCase(), headers[k]!.trim()] as const).sort(([a], [b]) => (a < b ? -1 : 1));
  const query = Object.entries(opts.query ?? {}).map(([k, v]) => [k.toLowerCase(), v] as const).sort(([a], [b]) => (a < b ? -1 : 1));
  const encodedPath = opts.pathname.split('/').map((p) => encodeURIComponent(p)).join('/');
  const resource = `/${opts.account}${encodedPath}${query.map(([k, v]) => `\n${k}:${v}`).join('')}`;
  const toSign = [
    opts.method, '', '', opts.contentLength ? String(opts.contentLength) : '', '', opts.contentType ?? '', '', '', '', '', '', '',
    ms.map(([k, v]) => `${k}:${v}`).join('\n'), resource,
  ].join('\n');
  const signature = createHmac('sha256', Buffer.from(opts.accountKey, 'base64')).update(toSign, 'utf8').digest('base64');
  const qs = new URLSearchParams(Object.entries(opts.query ?? {})).toString();
  return {
    url: `https://${opts.account}.blob.core.windows.net${encodedPath}${qs ? `?${qs}` : ''}`,
    headers: { ...headers, ...(opts.contentType ? { 'content-type': opts.contentType } : {}), authorization: `SharedKey ${opts.account}:${signature}` },
  };
}

async function probeAzure(settings: Values, secrets: Secrets, path: string, object: string): Promise<string> {
  const account = String(settings.account);
  const container = String(settings.bucket);
  const where = `${account}/${container}${path ? `/${path}` : ''}`;
  const call = async (method: string, pathname: string, query?: Record<string, string>, body?: string) => {
    const signed = signAzure({
      method, account, accountKey: secrets.accountKey ?? '', pathname, query,
      headers: body !== undefined ? { 'x-ms-blob-type': 'BlockBlob' } : {}, contentLength: body ? Buffer.byteLength(body) : 0, contentType: body !== undefined ? 'text/plain' : undefined,
    });
    let res: Response;
    try {
      res = await fetch(signed.url, { method, headers: signed.headers, body, signal: AbortSignal.timeout(TIMEOUT) });
    } catch (e) {
      throw new Error(`Could not reach ${account}.blob.core.windows.net: ${(e as Error).cause instanceof Error ? ((e as Error).cause as Error).message : (e as Error).message}`);
    }
    const text = await res.text();
    return { status: res.status, code: /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? res.headers.get('x-ms-error-code') ?? undefined };
  };
  const explain = (step: string, r: { status: number; code?: string }) => {
    const known: Record<string, string> = {
      ContainerNotFound: `the container ${container} does not exist`,
      AuthenticationFailed: 'the account key is not right for this storage account',
      AuthorizationPermissionMismatch: `the key may not ${step} here`,
    };
    return new Error(`Could not ${step} ${where}: ${(r.code && known[r.code]) ?? r.code ?? `the service answered ${r.status}`}`);
  };
  if (!/^[A-Za-z0-9+/]+=*$/.test(secrets.accountKey ?? '')) throw new Error('The account key should be the base64 key shown under Access keys in the Azure portal');
  const put = await call('PUT', `/${container}/${object}`, undefined, CHECK_BODY);
  if (put.status !== 201) throw explain('write to', put);
  const list = await call('GET', `/${container}`, { restype: 'container', comp: 'list', maxresults: '1', prefix: object });
  if (list.status !== 200) throw explain('list', list);
  const del = await call('DELETE', `/${container}/${object}`);
  if (del.status !== 202) return `Wrote and listed a check file in ${where}, but could not delete it (${del.code ?? del.status}): old off-site copies will not be removed after the days you set`;
  return `Wrote, listed and deleted a check file in ${where}`;
}

// ---------------------------------------------------------------------------------------------------------------
// SFTP: is an SSH server answering?
// ---------------------------------------------------------------------------------------------------------------

function probeSsh(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, timeout: 10_000 });
    let banner = '';
    const done = (err: Error | null, text?: string) => {
      socket.destroy();
      if (err) reject(err);
      else resolve(text!);
    };
    socket.on('data', (d) => {
      banner += d.toString('latin1');
      if (banner.includes('\n')) {
        const line = banner.split(/\r?\n/)[0]!.slice(0, 100);
        if (line.startsWith('SSH-')) done(null, `${host}:${port} answered as an SSH server (${line}). The sign-in is checked by the backup service's next copy; System health shows the result`);
        else done(new Error(`${host}:${port} answered, but not as an SSH server`));
      }
    });
    socket.on('timeout', () => done(new Error(`${host}:${port} did not answer within 10 seconds`)));
    socket.on('error', (e) => done(new Error(`Could not reach ${host}:${port}: ${e.message}`)));
  });
}
