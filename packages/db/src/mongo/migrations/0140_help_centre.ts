import type { MongoMigration } from '../migrator';
import { syncHelpLibraryMongo } from '../help-library';
import { Table } from '../table';

/** The Help & Support parts of the People module (contracts FEATURE_PARTS). */
const HELP_PARTS = ['core_hr.help_centre', 'core_hr.help_queries', 'core_hr.help_inbox'];

/**
 * Help & Support: seeds the built-in help library (categories, articles, query categories, settings), and makes the
 * three Help & Support parts Active for the whole application.
 *
 * New feature parts normally start Pending in the Console until SAMPLEDGE activates them. Help & Support is meant to be
 * there for everyone from the day it ships, so an existing installation gets them Active; SAMPLEDGE can still switch
 * them off in Feature management, and each company's Super Workspace for its levels. A fresh database is left to the
 * first catalogue sync, which makes every part Active anyway. Safe to run again: Console choices are never changed.
 */
export const m0140HelpCentre: MongoMigration = {
  name: '0140_help_centre',
  up: async (db) => {
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        await syncHelpLibraryMongo({ collection: (name: string) => new Table(db, name, session, { scope: null }) });
        const states = db.collection('platform_feature_states');
        if ((await states.countDocuments({}, { session })) === 0) return;
        for (const key of HELP_PARTS) {
          const row = await states.findOne({ key }, { session });
          if (!row) await new Table(db, 'platform_feature_states', session, { scope: null }).insert({ key, state: 'active', updated_by: 'migration 0140' });
          else if (row.state === 'pending' && row.updated_by === 'catalogue') await states.updateOne({ _id: row._id }, { $set: { state: 'active', updated_by: 'migration 0140' } }, { session });
        }
      });
    } finally {
      await session.endSession();
    }
  },
};
