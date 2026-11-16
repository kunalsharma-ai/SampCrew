import { randomBytes } from 'node:crypto';
import type { Db } from 'mongodb';
import { keyIdOf } from './field-crypto';
import { prepareInsert, tableSpec } from './mongo/engine';

/** One field encryption key as the database keeps it. */
export interface StoredFieldKey {
  /** keyIdOf(key): the id written into every value encrypted with it. */
  id: string;
  /** The key itself, base64, 32 bytes. */
  key: string;
  /** "generated" by SampCrew, or "environment" (moved from an older release's FIELD_ENCRYPTION_KEY). */
  origin: 'generated' | 'environment';
  added_at: string;
}

interface RingDoc {
  key: 'ring';
  /** The current key first, then older keys still needed to read values not yet re-encrypted. */
  keys: StoredFieldKey[];
  updated_at: Date;
}

const TABLE = 'field_keys';
const isKey = (k: string) => Buffer.from(k, 'base64').length === 32;
const entry = (key: string, origin: StoredFieldKey['origin']): StoredFieldKey => ({ id: keyIdOf(key), key, origin, added_at: new Date().toISOString() });

/** The ring as encryptField / decryptField take it: base64 keys, comma-separated, the current key first. */
export const ringString = (keys: StoredFieldKey[]) => keys.map((k) => k.key).join(',');

/** The saved ring, or null when this database has none yet. */
export async function readFieldKeys(db: Db): Promise<StoredFieldKey[] | null> {
  const doc = await db.collection<RingDoc>(TABLE).findOne({ key: 'ring' });
  return doc?.keys?.length ? doc.keys : null;
}

/** The variables older releases read the key ring from. They are read only to move them into the database once. */
function legacyKeys(env: NodeJS.ProcessEnv): string[] {
  const keys = [env.FIELD_ENCRYPTION_KEY ?? '', ...(env.FIELD_ENCRYPTION_KEYS_PREVIOUS ?? '').split(',')].map((k) => k.trim()).filter(Boolean);
  const bad = keys.filter((k) => !isKey(k));
  if (bad.length) throw new Error('FIELD_ENCRYPTION_KEY / FIELD_ENCRYPTION_KEYS_PREVIOUS must hold 32-byte base64 keys');
  return [...new Set(keys)];
}

/**
 * The field encryption key ring, kept in the database (field_keys) so that nothing but the database connection has
 * to be set on the server. The first start creates a random key; every later start, and every other server, reads
 * the same one.
 *
 * Upgrading from a release that read FIELD_ENCRYPTION_KEY (and FIELD_ENCRYPTION_KEYS_PREVIOUS) from .env: while the
 * database has no ring, those values are moved in, so everything already encrypted stays readable. They are never
 * read after that. When the database already holds encrypted values but neither a ring nor those variables are
 * there, this refuses rather than create a key that cannot open them.
 */
export async function loadFieldKeys(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; hasEncryptedData: () => Promise<boolean>; log?: (message: string) => void },
): Promise<StoredFieldKey[]> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const saved = await readFieldKeys(db);
  if (saved) {
    if ((env.FIELD_ENCRYPTION_KEY ?? '').trim() || (env.FIELD_ENCRYPTION_KEYS_PREVIOUS ?? '').trim()) {
      const known = new Set(saved.map((k) => k.key));
      const extra = legacyKeys(env).filter((k) => !known.has(k));
      log(
        extra.length
          ? `FIELD_ENCRYPTION_KEY is ignored: the encryption keys are kept in the database, and the value in the server's settings is not one of them. Delete that line.`
          : `FIELD_ENCRYPTION_KEY is ignored: the encryption keys are kept in the database. Delete that line from the server's settings.`,
      );
    }
    return saved;
  }
  const fromEnv = legacyKeys(env);
  if (!fromEnv.length && (await opts.hasEncryptedData())) {
    throw new Error(
      'This database holds encrypted values but no encryption key. If it was used by a release that kept FIELD_ENCRYPTION_KEY in the server settings, set that line once more and start again: the key is then moved into the database.',
    );
  }
  const keys = fromEnv.length ? fromEnv.map((k) => entry(k, 'environment')) : [entry(randomBytes(32).toString('base64'), 'generated')];
  try {
    await db.collection(TABLE).insertOne(prepareInsert(TABLE, tableSpec(TABLE), { key: 'ring', keys }));
    if (fromEnv.length) log(`Moved FIELD_ENCRYPTION_KEY${fromEnv.length > 1 ? ' and FIELD_ENCRYPTION_KEYS_PREVIOUS' : ''} into the database; they are no longer read from the server's settings. Delete those lines.`);
  } catch (e) {
    // Another server created the ring at the same moment: use that one.
    if (!/E11000|duplicate/i.test((e as Error).message)) throw e;
  }
  const ring = await readFieldKeys(db);
  if (!ring) throw new Error('Could not create the field encryption key');
  return ring;
}

/**
 * Starts a rotation: a new random key becomes the current one, and the old keys stay in the ring so values written
 * with them can still be read. Returns the new ring. Servers pick it up when they restart.
 */
export async function addFieldKey(db: Db): Promise<StoredFieldKey[]> {
  const fresh = entry(randomBytes(32).toString('base64'), 'generated');
  const r = await db.collection<RingDoc>(TABLE).findOneAndUpdate(
    { key: 'ring' },
    { $push: { keys: { $each: [fresh], $position: 0 } }, $set: { updated_at: new Date() } },
    { returnDocument: 'after' },
  );
  if (!r?.keys?.length) throw new Error('This database has no field encryption key yet; start the API once first');
  return r.keys;
}

/** Ends a rotation: drops every key but the current one. Call only when nothing is left on an older key. */
export async function retireOldFieldKeys(db: Db): Promise<{ kept: StoredFieldKey; removed: string[] }> {
  const saved = await readFieldKeys(db);
  if (!saved) throw new Error('This database has no field encryption key yet');
  const [kept, ...old] = saved;
  if (old.length) {
    // Only if the ring is still the one read, so a rotation started meanwhile is not cut short.
    const r = await db.collection<RingDoc>(TABLE).updateOne({ key: 'ring', 'keys.0.id': kept!.id, keys: { $size: saved.length } }, { $set: { keys: [kept!], updated_at: new Date() } });
    if (!r.modifiedCount) throw new Error('The keys changed while retiring the old ones; run it again');
  }
  return { kept: kept!, removed: old.map((k) => k.id) };
}
