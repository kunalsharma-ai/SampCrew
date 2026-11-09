import { createMongoClient, assertTransactionsSupported, databaseName } from '../src/mongo/client';
import { migrateMongo } from '../src/mongo/migrator';

/** Applies MongoDB migrations to MONGODB_URL (collections, validators, indexes). Safe to run on every deploy. */
async function main() {
  const url = process.env.MONGODB_URL;
  if (!url) throw new Error('Set MONGODB_URL, e.g. mongodb://localhost:27017/crew?replicaSet=rs0');
  const client = createMongoClient({ url, appName: 'crew-migrate' });
  await client.connect();
  try {
    await assertTransactionsSupported(client);
    const ran = await migrateMongo(client.db(databaseName(url)), (m) => console.log(m));
    console.log(ran.length ? `Applied ${ran.length} MongoDB migration(s).` : 'MongoDB is up to date.');
  } finally {
    await client.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
