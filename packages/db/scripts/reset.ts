import { Client } from 'pg';
import { adminUrl } from './env';

async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.CREW_ENV === 'production' || process.env.CREW_ENV === 'staging') {
    throw new Error('Refusing to reset a production or staging database.');
  }
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  await client.query('drop schema public cascade; create schema public;');
  await client.end();
  console.log('Database reset.');
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
