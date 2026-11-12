import { assertTransactionsSupported } from '../src/mongo/client';
import { migrateMongo } from '../src/mongo/migrator';
import type { Db, Document } from 'mongodb';
import { connect } from './env';

/** Lets the API show the point-in-time backup status on the Console's System health page: read-only, PBM's status only. */
export const BACKUP_STATUS_ROLE = 'crewBackupStatus';
/** pbmConfig is left out on purpose: it can hold storage credentials. */
const PBM_STATUS_COLLECTIONS = ['pbmBackups', 'pbmPITRChunks', 'pbmAgents', 'pbmRestores'];

async function upsertRole(admin: Db, role: string, privileges: Document[]) {
  const exists = ((await admin.command({ rolesInfo: role })).roles as unknown[]).length > 0;
  await admin.command(exists ? { updateRole: role, privileges, roles: [] } : { createRole: role, privileges, roles: [] });
}

/** Creates the user or resets its password and roles. True when it was created. */
async function upsertUser(db: Db, user: string, pwd: string, roles: Document[]): Promise<boolean> {
  const exists = ((await db.command({ usersInfo: user })).users as unknown[]).length > 0;
  await db.command(exists ? { updateUser: user, pwd, roles } : { createUser: user, pwd, roles });
  return !exists;
}

/**
 * Applies MongoDB migrations to MONGODB_URL (collections, validators, indexes). With MONGODB_API_PASSWORD set it also
 * creates or updates the API's own database user (MONGODB_API_USER, default crew_api) with read and write access to
 * this database only, plus read-only server monitoring for the Console's health page and read access to the
 * point-in-time backup status (BACKUP_STATUS_ROLE). With MONGODB_PBM_PASSWORD set it also creates or updates the user of
 * Percona Backup for MongoDB (MONGODB_PBM_USER, default crew_pbm) with the roles PBM documents. Safe to run on every
 * deploy.
 */
async function main() {
  const { client, db, name } = connect('crew-migrate');
  await client.connect();
  try {
    await assertTransactionsSupported(client);
    const ran = await migrateMongo(db, (m) => console.log(m));
    console.log(ran.length ? `Applied ${ran.length} migration(s).` : 'Database is up to date.');
    const admin = client.db('admin');
    const apiPassword = process.env.MONGODB_API_PASSWORD;
    if (apiPassword) {
      // The password comes from the environment or a secret manager, never from a migration.
      const user = process.env.MONGODB_API_USER ?? 'crew_api';
      await upsertRole(admin, BACKUP_STATUS_ROLE, PBM_STATUS_COLLECTIONS.map((collection) => ({ resource: { db: 'admin', collection }, actions: ['find'] })));
      const roles = [{ role: 'readWrite', db: name }, { role: 'clusterMonitor', db: 'admin' }, { role: BACKUP_STATUS_ROLE, db: 'admin' }];
      const created = await upsertUser(db, user, apiPassword, roles);
      console.log(`${created ? 'Created' : 'Updated'} database user ${user} (read and write on ${name}).`);
    }
    const pbmPassword = process.env.MONGODB_PBM_PASSWORD;
    if (pbmPassword) {
      // https://docs.percona.com/percona-backup-mongodb/install/configure-authentication.html
      const user = process.env.MONGODB_PBM_USER ?? 'crew_pbm';
      await upsertRole(admin, 'pbmAnyAction', [{ resource: { anyResource: true }, actions: ['anyAction'] }]);
      const roles = ['backup', 'restore', 'clusterMonitor', 'pbmAnyAction'].map((role) => ({ role, db: 'admin' }));
      const created = await upsertUser(admin, user, pbmPassword, [{ role: 'readWrite', db: 'admin' }, ...roles]);
      console.log(`${created ? 'Created' : 'Updated'} database user ${user} (point-in-time backups).`);
    }
  } finally {
    await client.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
