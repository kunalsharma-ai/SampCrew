import { Client } from 'pg';
import { migrate } from '../src/migrator';
import { adminUrl } from './env';

async function main() {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    const ran = await migrate(client, (m) => console.log(m));
    console.log(ran.length ? `Applied ${ran.length} migration(s).` : 'Database is up to date.');
    const apiPassword = process.env.DATABASE_API_PASSWORD;
    if (apiPassword) {
      // The API login role's password comes from the environment / secret manager, never from a migration file.
      await client.query(`alter role crew_api with password ${client.escapeLiteral(apiPassword)}`);
    }
  } finally {
    await client.end();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
