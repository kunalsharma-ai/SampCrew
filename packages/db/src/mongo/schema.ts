/** Column and table rules carried over from the PostgreSQL schema (see schema.generated.ts). */

export type ColumnType =
  | 'uuid'
  | 'string'
  /** Case-insensitive text (PostgreSQL citext). Stored lower-cased; filters on it are lower-cased too. */
  | 'citext'
  | 'int'
  /** Exact decimal (PostgreSQL numeric). Stored as Decimal128, read back as a string, as node-postgres returned it. */
  | 'decimal'
  | 'bool'
  | 'json'
  | 'timestamp'
  /** Calendar date, stored and read as 'YYYY-MM-DD'. */
  | 'date'
  /** Time of day, stored and read as 'HH:MM:SS'. */
  | 'time'
  | 'bytes'
  | 'string[]'
  | 'uuid[]'
  | 'int[]';

export type ColumnDefault = string | number | boolean | { fn: 'now' | 'uuid' | 'today' } | { json: unknown };

export interface ColumnSpec {
  type: ColumnType;
  required?: boolean;
  default?: ColumnDefault;
  enum?: string[];
  /** A generated, increasing number (PostgreSQL identity column). */
  identity?: boolean;
  /** Digits after the point of a decimal (numeric(p, s)): values are rounded to it on write, as PostgreSQL did. */
  scale?: number;
}

export interface KeyColumn {
  col: string;
  /** Compared case-insensitively (lower(col) / upper(col) in the SQL index). */
  fold?: 'lower' | 'upper';
  /** NULL counts as a value, so two NULLs collide (COALESCE(col, zero uuid) in the SQL index). */
  nullEqual?: boolean;
  desc?: boolean;
}

/** One condition of a partial index (the SQL WHERE clause), all of which must hold. */
export interface Condition {
  col: string;
  op: 'null' | 'notnull' | 'eq' | 'ne' | 'in' | 'true';
  value?: string | string[];
}

export interface UniqueSpec {
  name: string;
  cols: KeyColumn[];
  where?: Condition[];
  primary?: boolean;
}

export interface ForeignKeySpec {
  cols: string[];
  ref: string;
  refCols: string[];
  onDelete: 'no_action' | 'restrict' | 'cascade' | 'set_null' | 'set_default';
}

export interface IndexSpec {
  name: string;
  cols?: KeyColumn[];
  where?: Condition[];
  /** A condition with no MongoDB equivalent; the index is created without it. */
  whereRaw?: string;
  /** Not created in MongoDB (GiST exclusion or expression index); the rule is enforced in code. */
  skip?: string;
}

/**
 * Who may reach a table from a workspace transaction:
 *  - tenant: rows carry tenant_id and belong to one workspace.
 *  - tenant_self: the tenants table; a workspace sees and updates only its own row.
 *  - tenant_or_user: memberships; per workspace, or the signed-in user's own before a workspace is chosen.
 *  - users: people, visible to a workspace only when they are a member of it.
 *  - shared: the plan catalogue, read-only.
 *  - platform: sessions and SAMPLEDGE tables, never reachable from a workspace.
 */
export type TableAccess = 'tenant' | 'tenant_self' | 'tenant_or_user' | 'users' | 'shared' | 'platform';

export interface TableSpec {
  access: TableAccess;
  /** What a workspace transaction may do (the crew_app grants in PostgreSQL). */
  grants: Array<'select' | 'insert' | 'update' | 'delete'>;
  /** Columns a workspace transaction may read and change, when it may not use them all (PostgreSQL column grants). */
  tenantColumns?: { select: string[]; update: string[] };
  /** updated_at is set on every update. */
  touch?: boolean;
  /** Business-rule triggers from PostgreSQL, enforced in the owning module's service instead. */
  triggers?: string[];
  columns: Record<string, ColumnSpec>;
  unique: UniqueSpec[];
  fks: ForeignKeySpec[];
  indexes: IndexSpec[];
  /** CHECK constraints, kept for reference. Enums and the common shapes are enforced by the collection validator. */
  checks: string[];
}
