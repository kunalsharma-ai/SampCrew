import { randomBytes } from 'node:crypto';
import { decryptField, encryptField, loadFieldKeys, mongo, ringString } from '@crew/db';
import { ENCRYPTED_COLUMNS } from '../auth/field-key-rotation';
import type { AppConfig } from './config';

type SecretKey = 'jwt_access' | 'jwt_platform';
interface SecretDoc { _id?: string; key: SecretKey; value_enc: string; origin: 'generated' | 'environment'; created_at: Date }

const LEGACY: Record<SecretKey, 'JWT_ACCESS_SECRET' | 'JWT_PLATFORM_SECRET'> = { jwt_access: 'JWT_ACCESS_SECRET', jwt_platform: 'JWT_PLATFORM_SECRET' };

/**
 * This installation's own keys, kept in the database instead of the server's environment:
 *  - the field encryption key ring (field_keys, packages/db/src/field-keys.ts), which encrypts every saved secret;
 *  - the sign-in token signing keys for the Web Portal and mobile app, and for the Console (instance_secrets,
 *    encrypted with that ring).
 * The first API server to start creates them at random; every other server, and every later start, reads the same ones.
 *
 * Upgrading from a release that read FIELD_ENCRYPTION_KEY or JWT_ACCESS_SECRET / JWT_PLATFORM_SECRET: while nothing is
 * saved, a variable that is still set is moved into the database instead, so saved values stay readable and everyone
 * stays signed in. It is never read after that.
 *
 * Fills the values into `config` (the one loadConfig() returns) and returns it. Runs once per process.
 */
export async function loadInstanceSecrets(config: AppConfig, log: (message: string) => void = (m) => console.warn(m)): Promise<AppConfig> {
  if (config.JWT_ACCESS_SECRET && config.JWT_PLATFORM_SECRET && config.fieldKeys && config.instanceSecretsLoaded) return config;
  const client = mongo.createMongoClient({ url: config.MONGODB_URL, appName: 'crew-api-secrets', maxPoolSize: 2 });
  await client.connect();
  try {
    const db = client.db(mongo.databaseName(config.MONGODB_URL));
    const hasEncryptedData = async () => {
      for (const c of ENCRYPTED_COLUMNS) if (await db.collection(c.table).findOne({ [c.column]: { $nin: ['', null] } }, { projection: { _id: 1 } })) return true;
      return false;
    };
    config.fieldKeys = ringString(await loadFieldKeys(db, { env: process.env, hasEncryptedData, log }));
    const coll = db.collection<SecretDoc>('instance_secrets');
    const values = {} as Record<SecretKey, string>;
    for (const key of Object.keys(LEGACY) as SecretKey[]) {
      let doc = await coll.findOne({ key });
      if (!doc) {
        const fromEnv = (process.env[LEGACY[key]] ?? '').trim();
        const value = fromEnv.length >= 32 ? fromEnv : randomBytes(48).toString('base64url');
        try {
          await coll.insertOne(mongo.prepareInsert('instance_secrets', mongo.tableSpec('instance_secrets'), { key, value_enc: encryptField(value, config.fieldKeys), origin: fromEnv.length >= 32 ? 'environment' : 'generated' }) as SecretDoc);
          if (fromEnv.length >= 32) log(`Moved ${LEGACY[key]} into the database; it is no longer read from the server's settings. Delete that line.`);
          else if (fromEnv) log(`${LEGACY[key]} is shorter than 32 characters and was not used: a new random signing key was created in the database.`);
        } catch (e) {
          // Another API server created it at the same moment: use that one.
          if (!/E11000|duplicate/i.test((e as Error).message)) throw e;
        }
        doc = await coll.findOne({ key });
        if (!doc) throw new Error(`Could not create the ${key} signing key`);
      } else if (process.env[LEGACY[key]]) {
        log(`${LEGACY[key]} is ignored: the signing key is kept in the database. Delete that line from the server's settings.`);
      }
      values[key] = decryptField(doc.value_enc, config.fieldKeys);
    }
    if (values.jwt_access === values.jwt_platform) throw new Error('The two signing keys in instance_secrets must differ');
    config.JWT_ACCESS_SECRET = values.jwt_access;
    config.JWT_PLATFORM_SECRET = values.jwt_platform;
    config.instanceSecretsLoaded = true;
    return config;
  } finally {
    await client.close();
  }
}
