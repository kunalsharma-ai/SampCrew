/**
 * Seeds reference data (feature catalogue, plans), bootstraps the first SAMPLEDGE platform admin from
 * environment variables, and optionally creates a clearly labelled demo tenant.
 *
 *   CREW_BOOTSTRAP_ADMIN_EMAIL / CREW_BOOTSTRAP_ADMIN_PASSWORD   first Super Admin (only if none exists)
 *   CREW_SEED_DEMO=true + CREW_DEMO_PASSWORD                      demo tenant "demo-northwind"
 */
import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { syncCatalogue } from '../src/catalogue';
import { seedDemoTenant } from './demo';
import { adminUrl } from './env';

async function main() {
  const pool = new Pool({ connectionString: adminUrl() });
  try {
    await syncCatalogue(pool);
    console.log('Catalogue synced (features, plans).');

    const email = process.env.CREW_BOOTSTRAP_ADMIN_EMAIL;
    const password = process.env.CREW_BOOTSTRAP_ADMIN_PASSWORD;
    if (email && password) {
      const { rowCount } = await pool.query('select 1 from platform_admins');
      if (!rowCount) {
        await pool.query(
          `insert into platform_admins (email, full_name, password_hash, role) values ($1, 'Platform Super Admin', $2, 'super_admin')`,
          [email.toLowerCase(), await hash(password)],
        );
        console.log(`Bootstrapped platform super admin ${email}. Enrol MFA at first sign-in.`);
      }
    }

    if (process.env.CREW_SEED_DEMO === 'true') {
      const demoPassword = process.env.CREW_DEMO_PASSWORD;
      if (!demoPassword) throw new Error('CREW_SEED_DEMO=true needs CREW_DEMO_PASSWORD');
      const created = await seedDemoTenant(pool, await hash(demoPassword));
      console.log(created ? 'Demo tenant "demo-northwind" created (marked as demo data).' : 'Demo tenant already exists.');
    }
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
