import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** argon2id with OWASP-recommended parameters (19 MiB, 2 iterations). */
export const hashPassword = (password: string) => hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

export async function verifyPassword(hashValue: string | null, password: string): Promise<boolean> {
  if (!hashValue) {
    // Burn comparable time so missing accounts are not distinguishable by latency.
    await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    return false;
  }
  try {
    return await verify(hashValue, password);
  } catch {
    return false;
  }
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * AES-256-GCM envelope for small secrets (MFA seeds, bank and tax identifiers, webhook and SSO secrets).
 *
 * `keys` is a key ring: one or more base64 32-byte keys separated by commas, the first being the current key. New
 * values are written as `v2.<key id>.<iv>.<tag>.<ciphertext>` (base64url) with the current key; the key id is the
 * first 8 hex characters of SHA-256 of the key, so a value names the key that can open it. Values written before key
 * ids existed (`v1.<iv>.<tag>.<ciphertext>`) are opened by trying each key in the ring. The re-encryption job
 * (`src/cli/rotate-field-key.ts`) rewrites everything with the current key, after which old keys can be dropped.
 */
export function encryptField(plaintext: string, keys: string): string {
  const [current] = keyRing(keys);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current!.key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v2', current!.id, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptField(payload: string, keys: string): string {
  const ring = keyRing(keys);
  const parts = payload.split('.');
  if (parts[0] === 'v2' && parts.length === 5) {
    const k = ring.find((r) => r.id === parts[1]);
    if (!k) throw new Error(`No key for ciphertext (key id ${parts[1]}); add the old key to FIELD_ENCRYPTION_KEYS_PREVIOUS`);
    return open(k.key, parts[2]!, parts[3]!, parts[4]!);
  }
  if (parts[0] === 'v1' && parts.length === 4) {
    let last: unknown;
    for (const k of ring) {
      try {
        return open(k.key, parts[1]!, parts[2]!, parts[3]!);
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error('Unable to decrypt');
  }
  throw new Error('Unsupported ciphertext');
}

/** The key id a value was written with, or null for v1 values (written before key ids). */
export function fieldKeyId(payload: string): string | null {
  const parts = payload.split('.');
  return parts[0] === 'v2' && parts.length === 5 ? parts[1]! : null;
}

/** The id of a key (the current key's id is what every value carries after rotation). */
export const keyIdOf = (keyBase64: string) => createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('hex').slice(0, 8);

function keyRing(keys: string): Array<{ id: string; key: Buffer }> {
  const ring = keys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => ({ id: keyIdOf(k), key: Buffer.from(k, 'base64') }));
  if (!ring.length || ring.some((r) => r.key.length !== 32)) throw new Error('Field encryption keys must be 32 bytes, base64 encoded');
  return ring;
}

function open(key: Buffer, iv: string, tag: string, ct: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** A temporary password that passes the password rules: 16 characters from four character groups. */
export function temporaryPasswordValue(): string {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*?-'];
  const bytes = randomBytes(32);
  const chars = groups.map((g, i) => g[bytes[i]! % g.length]!);
  const all = groups.join('');
  for (let i = 4; chars.length < 16; i++) chars.push(all[bytes[i]! % all.length]!);
  // Shuffle so the groups are not always in the same places.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[16 + (i % 16)]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
