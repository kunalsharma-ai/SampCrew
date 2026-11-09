import { mongo } from '@crew/db';
import { applyMongoTestEnv } from './env';

/** Drops and recreates the MongoDB test database and applies migrations once per run. */
export default async function setup() {
  applyMongoTestEnv();
  const url = process.env.MONGODB_URL!;
  const name = mongo.databaseName(url);
  if (!/test/.test(name)) throw new Error(`Refusing to drop non-test database ${name}`);
  const client = mongo.createMongoClient({ url, appName: 'crew-test-setup' });
  await client.connect();
  try {
    await mongo.assertTransactionsSupported(client);
    await client.db(name).dropDatabase();
    await mongo.migrateMongo(client.db(name));
  } finally {
    await client.close();
  }
}
