import { mongo } from '@crew/db';
import { applyTestEnv } from './env';

/** Drops the test database, creates its collections, validators and indexes, and syncs the plan catalogue, once per test run. */
export default async function setup() {
  applyTestEnv();
  const url = process.env.MONGODB_URL!;
  const name = mongo.databaseName(url);
  if (!/test/.test(name)) throw new Error(`Refusing to drop non-test database ${name}`);
  const client = mongo.createMongoClient({ url, appName: 'crew-test-setup' });
  await client.connect();
  try {
    await client.db(name).dropDatabase();
    await mongo.migrateMongo(client.db(name));
    const session = client.startSession();
    try {
      await session.withTransaction(() => mongo.syncCatalogueMongo({ collection: (t) => new mongo.Table(client.db(name), t, session, { scope: null }) }));
    } finally {
      await session.endSession();
    }
  } finally {
    await client.close();
  }
}
