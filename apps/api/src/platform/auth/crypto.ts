import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

// The field encryption itself lives in @crew/db, so the database scripts (backups, recovery) open the same values.
export { decryptField, encryptField, fieldKeyId, keyIdOf } from '@crew/db';

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
