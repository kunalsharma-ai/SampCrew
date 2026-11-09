/**
 * Workspace isolation for MongoDB lives in @crew/db (packages/db/src/mongo/table.ts), so the API, migrations and
 * seed scripts share one implementation. Re-exported here for the API's data layer.
 */
import { mongo } from '@crew/db';

export const ScopeViolationError = mongo.ScopeViolationError;
export type ScopeViolationError = InstanceType<typeof mongo.ScopeViolationError>;
export const ConstraintError = mongo.ConstraintError;
export type ConstraintError = InstanceType<typeof mongo.ConstraintError>;
export const Table = mongo.Table;
export type Table<T extends Record<string, unknown> = Record<string, any>> = mongo.Table<T>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Scope = mongo.Scope;
export const scopePipeline = mongo.scopePipeline;
