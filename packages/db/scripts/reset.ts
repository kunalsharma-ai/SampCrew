import { connect } from './env';

/** Drops the whole database named in MONGODB_URL. For laptops and CI only. */
async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.CREW_ENV === 'production' || process.env.CREW_ENV === 'staging') {
    throw new Error('Refusing to reset a production or staging database.');
  }
  const { client, db, name } = connect('crew-reset');
  await client.connect();
  try {
    await db.dropDatabase();
  } finally {
    await client.close();
  }
  console.log(`Database ${name} reset.`);
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
