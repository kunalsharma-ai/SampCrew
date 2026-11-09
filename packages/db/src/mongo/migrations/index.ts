import type { MongoMigration } from '../migrator';
import { m0001Foundation } from './0001_foundation';

/** Every MongoDB migration, in order. Append new ones; never edit or reorder one that has shipped. */
export const MONGO_MIGRATIONS: MongoMigration[] = [m0001Foundation];
