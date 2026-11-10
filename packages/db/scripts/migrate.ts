import { assertTransactionsSupported } from '../src/mongo/client';
import { migrateMongo } from '../src/mongo/migrator';
import { connect } from './env';

/**
 * Applies MongoDB migrations to MONGODB_URL (collections, validators, indexes). With MONGODB_API_PASSWORD set it also
 * creates or updates the API's own database user (MONGODB_API_USER, default crew_api) with read and write access to
 * this database only, plus read-only server monitoring for the Console's health page. Safe to run on every deploy.
 */
async function main() {
  const { client, db, name } = connect('crew-migrate');
  await client.connect();
  try {
    await assertTransactionsSupported(client);
    const ran = await migrateMongo(db, (m) => console.log(m));
    console.log(ran.length ? `Applied ${ran.length} migration(s).` : 'Database is up to date.');
    const apiPassword = process.env.MONGODB_API_PASSWORD;
    if (apiPassword) {
      // The password comes from the environment or a secret manager, never from a migration.
      const user = process.env.MONGODB_API_USER ?? 'crew_api';
      const roles = [{ role: 'readWrite', db: name }, { role: 'clusterMonitor', db: 'admin' }];
      const exists = ((await db.command({ usersInfo: user })).users as unknown[]).length > 0;
      await db.command(exists ? { updateUser: user, pwd: apiPassword, roles } : { createUser: user, pwd: apiPassword, roles });
      console.log(`${exists ? 'Updated' : 'Created'} database user ${user} (read and write on ${name}).`);
    }
  } finally {
    await client.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
