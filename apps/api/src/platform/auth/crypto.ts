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

/** AES-256-GCM envelope for small secrets (MFA seeds). Output: v1.<iv>.<tag>.<ciphertext>, base64url. */
export function encryptField(plaintext: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptField(payload: string, keyBase64: string): string {
  const [v, iv, tag, ct] = payload.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
