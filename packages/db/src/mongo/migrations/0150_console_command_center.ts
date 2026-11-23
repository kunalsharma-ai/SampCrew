import type { MongoMigration } from '../migrator';
import { syncConsoleRolesMongo, type Tables } from '../provision';
import { Table } from '../table';

/**
 * The Console command center:
 *  - Console roles move into the database (platform_roles): the six built-in roles are added, and every admin keeps
 *    the role key they hold (super_admin, support, billing_ops and viewer are still built-in roles, so nobody loses
 *    access). Their permissions only grow where the new areas need them (contracts CONSOLE_SYSTEM_ROLES).
 *  - Client companies: every Super Workspace (tenant) without one gets its own company, copied from what the tenant
 *    already holds (name, industry, size, website, contact email and phone, country, demo flag, creation date).
 *    Nothing is made up: fields the tenant never had stay empty. One company per tenant, so nothing changes in use.
 *  - Console notification preferences start empty (nothing muted, sound and desktop off).
 * Safe to run again: a tenant that already has a company, and a role row that exists, are left alone.
 */
export const m0150ConsoleCommandCenter: MongoMigration = {
  name: '0150_console_command_center',
  up: async (db) => {
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const tables = { collection: (name: string) => new Table(db, name, session, { scope: null }) } as unknown as Tables;
        await syncConsoleRolesMongo(tables);
        const companies = tables.collection('companies');
        const tenants = await db.collection('tenants').find({ $or: [{ company_id: null }, { company_id: { $exists: false } }] }, { session }).toArray();
        for (const t of tenants) {
          const company = await companies.insert({
            name: t.name,
            industry: t.industry ?? null,
            company_size: t.company_size ?? null,
            website: t.website ?? null,
            email: t.contact_email ?? null,
            phone: t.contact_phone ?? null,
            country_code: t.country_code ?? null,
            is_demo: t.is_demo === true,
            created_at: t.created_at instanceof Date ? t.created_at : new Date(),
            field_sources: { copiedFromWorkspace: new Date().toISOString() },
          });
          await db.collection('tenants').updateOne({ _id: t._id }, { $set: { company_id: company.id } }, { session });
        }
        await db.collection('platform_admins').updateMany({ notification_prefs: { $exists: false } }, { $set: { notification_prefs: {} } }, { session });
      });
    } finally {
      await session.endSession();
    }
  },
};
