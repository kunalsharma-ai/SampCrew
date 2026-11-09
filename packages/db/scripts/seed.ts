/**
 * Seeds reference data (feature catalogue, plans), bootstraps the first SAMPLEDGE platform admin from
 * environment variables, and optionally creates a clearly labelled demo tenant.
 *
 *   CREW_BOOTSTRAP_ADMIN_EMAIL / CREW_BOOTSTRAP_ADMIN_PASSWORD   first Super Admin (only if none exists)
 *   CREW_SEED_DEMO=true + CREW_DEMO_PASSWORD                      demo tenant "demo-northwind"
 */
import { hash } from '@node-rs/argon2';
import { syncCatalogueMongo, Table } from '../src/mongo';
import { seedDemoTenant } from './demo';
import { connect } from './env';

async function main() {
  const { client, db } = connect('crew-seed');
  await client.connect();
  try {
    const session = client.startSession();
    try {
      await session.withTransaction(() => syncCatalogueMongo({ collection: (name) => new Table(db, name, session, { scope: null }) }));
    } finally {
      await session.endSession();
    }
    console.log('Catalogue synced (features, plans).');

    const email = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
    const password = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
    const production = process.env.CREW_ENV === 'production';
    if (email && password) {
      if (production && (password.length < 14 || /change-?me|example|password/i.test(password))) {
        throw new Error('CREW_BOOTSTRAP_ADMIN_PASSWORD must be at least 14 characters and not a template value in production');
      }
      if (!(await db.collection('platform_admins').countDocuments({}, { limit: 1 }))) {
        const session = client.startSession();
        try {
          const passwordHash = await hash(password);
          await session.withTransaction(() =>
            new Table(db, 'platform_admins', session, { scope: null }).insert({ email: email.toLowerCase(), full_name: 'Platform Super Admin', password_hash: passwordHash, role: 'super_admin' }),
          );
        } finally {
          await session.endSession();
        }
        console.log(`Bootstrapped platform super admin ${email}. Enrol MFA at first sign-in.`);
      }
    }

    if (process.env.CREW_SEED_DEMO === 'true' && production) {
      // Demo users share one password; they belong on laptops and staging, never in production.
      throw new Error('CREW_SEED_DEMO=true is refused when CREW_ENV=production');
    }
    if (process.env.CREW_SEED_DEMO === 'true') {
      const demoPassword = process.env.CREW_DEMO_PASSWORD;
      if (!demoPassword) throw new Error('CREW_SEED_DEMO=true needs CREW_DEMO_PASSWORD');
      const created = await seedDemoTenant(client, db, await hash(demoPassword));
      console.log(created ? 'Demo tenant "demo-northwind" created (marked as demo data).' : 'Demo tenant already exists.');
    }
  } finally {
    await client.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
