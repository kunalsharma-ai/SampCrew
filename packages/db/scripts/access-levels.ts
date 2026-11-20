/**
 * The move from the 14 built-in roles to the four access levels, per company.
 *
 *   pnpm db:access-levels report               how many people, approval chains, fields and groups were moved, per company
 *   pnpm db:access-levels rollback <slug>      puts that company's old role assignments, chains, fields and groups back
 *
 * The move itself runs with `pnpm db:seed` (and on every new company). A rollback only makes sense together with
 * deploying the release before the access levels: this release gives access through the levels only. Running the
 * seed again re-applies the move.
 */
import { rollbackAccessLevelsMongo, Table } from '../src/mongo';
import { connect } from './env';

async function main() {
  const [command, slug] = process.argv.slice(2);
  const { client, db } = connect('crew-access-levels');
  await client.connect();
  try {
    if (command === 'report') {
      const rows = await db.collection('access_level_migrations').aggregate<{ _id: { tenant: string; kind: string }; n: number }>([
        { $match: { rolled_back_at: null } },
        { $group: { _id: { tenant: '$tenant_id', kind: '$kind' }, n: { $sum: 1 } } },
      ]).toArray();
      const tenants = new Map((await db.collection('tenants').find({}, { projection: { slug: 1 } }).toArray()).map((t) => [String(t._id), String(t.slug)]));
      if (!rows.length) console.log('Nothing has been moved yet.');
      for (const r of rows) console.log(`${tenants.get(String(r._id.tenant)) ?? r._id.tenant}\t${r._id.kind}\t${r.n}`);
      return;
    }
    if (command === 'rollback' && slug) {
      const tenant = await db.collection('tenants').findOne({ slug });
      if (!tenant) throw new Error(`No company with the slug ${slug}`);
      const session = client.startSession();
      try {
        let restored = 0;
        await session.withTransaction(async () => {
          restored = (await rollbackAccessLevelsMongo({ collection: (name) => new Table(db, name, session, { scope: null }) }, String(tenant._id))).restored;
        });
        console.log(`Restored ${restored} records for ${slug}. Deploy the release before the access levels for them to take effect.`);
      } finally {
        await session.endSession();
      }
      return;
    }
    console.log('Usage: pnpm db:access-levels report | rollback <company slug>');
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
