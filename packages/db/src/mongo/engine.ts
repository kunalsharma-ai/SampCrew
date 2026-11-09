import { randomUUID } from 'node:crypto';
import { Binary, Decimal128, type Document } from 'mongodb';
import type { ColumnSpec, Condition, IndexSpec, KeyColumn, TableSpec, UniqueSpec } from './schema';
import { TABLES } from './schema.generated';

/**
 * The PostgreSQL rules SampCrew relied on, applied to MongoDB documents: column defaults, types, enums, NOT NULL,
 * unique keys (including partial and case-insensitive ones) and foreign keys. Documents keep the column names; the
 * primary key `id` is stored as `_id` and read back as `id`.
 */

export class UnknownTableError extends Error {}

export function tableSpec(name: string, tables: Record<string, TableSpec> = TABLES): TableSpec {
  const spec = Object.prototype.hasOwnProperty.call(tables, name) ? tables[name] : undefined;
  if (!spec) throw new UnknownTableError(`Unknown collection ${name} (packages/db/src/mongo/schema.generated.ts)`);
  return spec;
}

/**
 * A data-rule failure, with the PostgreSQL error code the services already handle (e.g. `err.code === '23505'`):
 * 23505 unique, 23503 foreign key, 23502 not null, 23514 check, 22P02 invalid value, P0001 a business rule (row guard).
 */
export class ConstraintError extends Error {
  constructor(
    readonly code: '23505' | '23503' | '23502' | '23514' | '22P02' | 'P0001',
    message: string,
    readonly constraint?: string,
    readonly table?: string,
  ) {
    super(message);
    this.name = 'ConstraintError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

export const today = () => new Date().toISOString().slice(0, 10);

function defaultValue(spec: ColumnSpec): unknown {
  const d = spec.default;
  if (d === undefined) return undefined;
  if (typeof d === 'object') {
    if ('json' in d) return structuredClone(d.json);
    if (d.fn === 'now') return new Date();
    if (d.fn === 'uuid') return randomUUID();
    if (d.fn === 'today') return today();
  }
  return d;
}

/** Converts a value to how a column is stored. Throws 22P02 for a value that cannot be that type. */
/**
 * A decimal string rounded (half away from zero) to `scale` digits after the point, written with exactly that many:
 * numeric(12, 2) stores 1.5 as 1.50 and 2.345 as 2.35.
 */
export function withScale(value: string, scale: number): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e(-?\d+))?$/i.exec(value.trim());
  if (!m) throw new Error(`Not a decimal: ${value}`);
  const [, sign, int, frac = '', exp = '0'] = m;
  // All digits as one integer, and where the point sits counted from the right.
  let digits = BigInt(int! + frac);
  let point = frac.length - Number(exp);
  if (point < 0) {
    digits *= 10n ** BigInt(-point);
    point = 0;
  }
  if (point > scale) {
    const div = 10n ** BigInt(point - scale);
    const rest = digits % div;
    digits = digits / div + (rest * 2n >= div ? 1n : 0n);
  } else digits *= 10n ** BigInt(scale - point);
  const text = digits.toString().padStart(scale + 1, '0');
  const out = scale ? `${text.slice(0, -scale)}.${text.slice(-scale)}` : text;
  return digits === 0n ? out : `${sign}${out}`;
}

export function toStored(table: string, column: string, spec: ColumnSpec, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const bad = () => new ConstraintError('22P02', `Invalid value for ${table}.${column}`, column, table);
  switch (spec.type) {
    case 'uuid':
      if (typeof value !== 'string' || !UUID.test(value)) throw bad();
      return value.toLowerCase();
    case 'citext':
      if (typeof value !== 'string') throw bad();
      return value.toLowerCase();
    case 'string':
      if (typeof value !== 'string') throw bad();
      return value;
    case 'int': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isInteger(n)) throw bad();
      return n;
    }
    case 'decimal': {
      if (value instanceof Decimal128) return value;
      const s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : typeof value === 'string' ? value.trim() : '';
      if (!/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) throw bad();
      return Decimal128.fromString(spec.scale === undefined ? s : withScale(s, spec.scale));
    }
    case 'bool':
      if (typeof value !== 'boolean') throw bad();
      return value;
    case 'timestamp': {
      const d = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
      if (!d || Number.isNaN(d.getTime())) throw bad();
      return d;
    }
    case 'date': {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      if (typeof value !== 'string') throw bad();
      const s = value.slice(0, 10);
      if (!DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw bad();
      return s;
    }
    case 'time':
      if (typeof value !== 'string' || !TIME.test(value)) throw bad();
      return value.length === 5 ? `${value}:00` : value;
    case 'bytes':
      if (value instanceof Binary) return value;
      if (Buffer.isBuffer(value) || value instanceof Uint8Array) return new Binary(value);
      throw bad();
    case 'json':
      return value;
    case 'string[]':
    case 'uuid[]':
    case 'int[]':
      if (!Array.isArray(value)) throw bad();
      if (spec.type === 'uuid[]') return value.map((v) => toStored(table, column, { type: 'uuid' }, v));
      if (spec.type === 'int[]') return value.map((v) => toStored(table, column, { type: 'int' }, v));
      return value.map((v) => toStored(table, column, { type: 'string' }, v));
  }
}

/** A stored document as the services read it: `id` for `_id`, decimals as strings, bytes as Buffers. */
/** Internal counter written by Table.lock() so concurrent transactions on one row conflict; never returned. */
export const LOCK_FIELD = '_lock';

export function toRow<T = Document>(doc: Document | null | undefined): T {
  if (!doc) return doc as T;
  const out: Document = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_id') out.id = v;
    else if (k !== LOCK_FIELD) out[k] = fromStored(v);
  }
  return out as T;
}

function fromStored(v: unknown): unknown {
  if (v instanceof Decimal128) return v.toString();
  if (v instanceof Binary) return Buffer.from(v.buffer);
  if (Array.isArray(v)) return v.map(fromStored);
  return v;
}

/** A new document from a row: defaults filled, values converted, NOT NULL and enums checked. */
export function prepareInsert(table: string, spec: TableSpec, row: Document): Document {
  const doc: Document = {};
  for (const key of Object.keys(row)) {
    if (key !== 'id' && key !== '_id' && !spec.columns[key]) throw new ConstraintError('22P02', `Unknown column ${table}.${key}`, key, table);
  }
  for (const [col, cs] of Object.entries(spec.columns)) {
    let value = col === 'id' ? (row.id ?? row._id) : row[col];
    if (value === undefined) value = cs.identity ? undefined : defaultValue(cs);
    if (value === undefined && !cs.required) continue;
    if ((value === undefined || value === null) && cs.required && !cs.identity) {
      throw new ConstraintError('23502', `${table}.${col} is required`, col, table);
    }
    if (value === undefined) continue;
    const stored = toStored(table, col, cs, value);
    if (cs.enum && stored !== null && !cs.enum.includes(stored as string)) {
      throw new ConstraintError('23514', `${table}.${col} must be one of ${cs.enum.join(', ')}`, col, table);
    }
    doc[col === 'id' ? '_id' : col] = stored;
  }
  // Tables without an id column (join tables) still need a document id.
  // An identity id is numbered by the table on insert.
  if (doc._id === undefined && !spec.columns.id?.identity) doc._id = randomUUID();
  return doc;
}

/** Converts the values a filter compares columns with, and maps `id` to `_id`. Operators pass through. */
export function prepareFilter(table: string, spec: TableSpec, filter: Document): Document {
  const out: Document = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      out[key] = (value as Document[]).map((f) => prepareFilter(table, spec, f));
      continue;
    }
    if (key.startsWith('$')) {
      out[key] = value;
      continue;
    }
    const field = key === 'id' ? '_id' : key;
    const cs = spec.columns[key === '_id' ? 'id' : key] ?? (key === '_id' || key === 'id' ? { type: 'string' as const } : undefined);
    out[field] = cs ? convertCondition(table, key, cs, value) : value;
  }
  return out;
}

function convertCondition(table: string, column: string, cs: ColumnSpec, value: unknown): unknown {
  const convert = (v: unknown) => (v === null || v === undefined ? v : safeStored(table, column, cs, v));
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Decimal128) && !Array.isArray(value) && !(value instanceof RegExp) && !(value instanceof Binary)) {
    const out: Document = {};
    for (const [op, v] of Object.entries(value as Document)) {
      if (['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'].includes(op)) out[op] = convert(v);
      else if (op === '$in' || op === '$nin' || op === '$all') out[op] = (v as unknown[]).map(convert);
      else if (op === '$elemMatch' || op === '$not') out[op] = v;
      else out[op] = v;
    }
    return out;
  }
  if (Array.isArray(value)) return cs.type.endsWith('[]') ? value : value; // array equality: as given
  return convert(value);
}

/** Like toStored, but a value that is not of the column's type is left alone (a filter then matches nothing). */
function safeStored(table: string, column: string, cs: ColumnSpec, v: unknown): unknown {
  const scalar: ColumnSpec = cs.type.endsWith('[]') ? { type: cs.type.slice(0, -2) as ColumnSpec['type'] } : cs;
  try {
    return toStored(table, column, scalar, v);
  } catch {
    return v;
  }
}

const SET_OPS = ['$set', '$setOnInsert'];

/** Converts update values, refuses unknown columns and changes to `id`, and sets updated_at on touched tables. */
export function prepareUpdate(table: string, spec: TableSpec, update: Document): Document {
  const out: Document = {};
  for (const [op, body] of Object.entries(update)) {
    if (!op.startsWith('$')) throw new ConstraintError('22P02', 'Updates must use operators such as $set', undefined, table);
    const converted: Document = {};
    for (const [path, value] of Object.entries(body as Document)) {
      const col = path.split('.')[0]!;
      if (col === 'id' || col === '_id') throw new ConstraintError('22P02', `${table}.id cannot change`, 'id', table);
      const cs = spec.columns[col];
      if (!cs) throw new ConstraintError('22P02', `Unknown column ${table}.${col}`, col, table);
      if (SET_OPS.includes(op) && path === col) {
        if ((value === null || value === undefined) && cs.required) throw new ConstraintError('23502', `${table}.${col} is required`, col, table);
        const stored = toStored(table, col, cs, value);
        if (cs.enum && stored !== null && stored !== undefined && !cs.enum.includes(stored as string)) {
          throw new ConstraintError('23514', `${table}.${col} must be one of ${cs.enum.join(', ')}`, col, table);
        }
        converted[path] = stored === undefined ? null : stored;
      } else if (op === '$unset' && cs.required) {
        throw new ConstraintError('23502', `${table}.${col} is required`, col, table);
      } else if (op === '$inc' && cs.type === 'decimal') {
        converted[path] = toStored(table, col, cs, value);
      } else if ((op === '$push' || op === '$addToSet') && cs.type.endsWith('[]') && path === col) {
        const scalar = { type: cs.type.slice(0, -2) } as ColumnSpec;
        converted[path] = value && typeof value === 'object' && '$each' in (value as Document)
          ? { ...(value as Document), $each: ((value as Document).$each as unknown[]).map((v) => toStored(table, col, scalar, v)) }
          : toStored(table, col, scalar, value);
      } else {
        converted[path] = value;
      }
    }
    out[op] = converted;
  }
  if (spec.touch && !(out.$set && 'updated_at' in out.$set)) {
    out.$set = { ...(out.$set ?? {}), updated_at: new Date() };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Unique keys
// ---------------------------------------------------------------------------------------------------------------

/**
 * How a unique key is enforced: by a MongoDB unique index when it can express it (with a partial filter for nullable
 * columns, a case-insensitive collation for lower()/upper()), otherwise by guard documents (see guardKey).
 */
export function uniqueStrategy(spec: TableSpec, u: UniqueSpec): 'index' | 'guard' {
  if (u.primary && u.cols.length === 1 && u.cols[0]!.col === 'id') return 'index';
  if (u.where?.some((c) => c.op === 'null' || c.op === 'ne' || c.op === 'in')) return 'guard';
  const folds = u.cols.filter((c) => c.fold);
  // A collation applies to the whole index, which is right only if every other string column is a uuid or a code.
  if (folds.length && u.cols.some((c) => !c.fold && ['string', 'citext'].includes(spec.columns[c.col]?.type ?? ''))) return 'guard';
  return 'index';
}

const BSON: Record<string, string> = {
  uuid: 'string', string: 'string', citext: 'string', int: 'number', decimal: 'decimal', bool: 'bool', json: 'object',
  timestamp: 'date', date: 'string', time: 'string', bytes: 'binData', 'string[]': 'array', 'uuid[]': 'array', 'int[]': 'array',
};

function conditionFilter(c: Condition): Document {
  if (c.op === 'eq') return { [c.col]: c.value };
  if (c.op === 'true') return { [c.col]: true };
  if (c.op === 'notnull') return { [c.col]: { $exists: true } };
  throw new Error(`Condition ${c.op} has no partial index form`);
}

/** The MongoDB index for a unique key enforced by an index. */
export function uniqueIndex(spec: TableSpec, u: UniqueSpec): { key: Document; options: Document } | null {
  if (uniqueStrategy(spec, u) !== 'index') return null;
  // A key that includes the row id is unique already (PostgreSQL needed these for composite foreign keys).
  if (u.cols.some((c) => c.col === 'id')) return null;
  const key: Document = {};
  for (const c of u.cols) key[c.col === 'id' ? '_id' : c.col] = 1;
  const partial: Document[] = [];
  for (const c of u.cols) {
    const cs = spec.columns[c.col];
    // PostgreSQL treats NULLs as distinct in unique keys; MongoDB does not, so only index rows where they are set.
    if (cs && !cs.required && !c.nullEqual) partial.push({ [c.col]: { $type: BSON[cs.type] } });
  }
  for (const c of u.where ?? []) partial.push(conditionFilter(c));
  const options: Document = { name: u.name, unique: true };
  if (partial.length) options.partialFilterExpression = partial.length === 1 ? partial[0] : { $and: partial };
  if (u.cols.some((c) => c.fold)) options.collation = { locale: 'en', strength: 2 };
  return { key, options };
}

/** A non-unique index, or null when it cannot be expressed (its rule is then enforced in code). */
export function plainIndex(spec: TableSpec, i: IndexSpec): { key: Document; options: Document } | null {
  if (i.skip || !i.cols) return null;
  const key: Document = {};
  for (const c of i.cols) key[c.col === 'id' ? '_id' : c.col] = c.desc ? -1 : 1;
  const options: Document = { name: i.name };
  const partial = (i.where ?? []).filter((c) => c.op === 'eq' || c.op === 'true' || c.op === 'notnull').map(conditionFilter);
  if (partial.length && partial.length === (i.where ?? []).length) {
    options.partialFilterExpression = partial.length === 1 ? partial[0] : { $and: partial };
  }
  if (i.cols.some((c) => c.fold)) options.collation = { locale: 'en', strength: 2 };
  return { key, options };
}

export function matchesConditions(doc: Document, conds: Condition[] | undefined): boolean {
  for (const c of conds ?? []) {
    const v = doc[c.col];
    const isNull = v === null || v === undefined;
    if (c.op === 'null' && !isNull) return false;
    if (c.op === 'notnull' && isNull) return false;
    if (c.op === 'eq' && v !== c.value) return false;
    if (c.op === 'ne' && (isNull || v === c.value)) return false;
    if (c.op === 'in' && !(c.value as string[]).includes(v as string)) return false;
    if (c.op === 'true' && v !== true) return false;
  }
  return true;
}

/**
 * The guard id for a document under a unique key enforced by guards, or null when the key does not apply to it
 * (a NULL column, or a partial condition that does not hold). Two documents with the same guard id collide.
 */
export function guardKey(table: string, spec: TableSpec, u: UniqueSpec, doc: Document): string | null {
  if (!matchesConditions(doc, u.where)) return null;
  const parts: unknown[] = [];
  for (const c of u.cols) {
    const field = c.col === 'id' ? '_id' : c.col;
    let v = doc[field];
    if ((v === null || v === undefined) && !c.nullEqual) return null;
    if (v instanceof Decimal128) v = v.toString();
    if (typeof v === 'string' && c.fold) v = v.toLowerCase();
    parts.push(v ?? null);
  }
  return `${table}|${u.name}|${JSON.stringify(parts)}`;
}

export function guardedKeys(spec: TableSpec): UniqueSpec[] {
  return spec.unique.filter((u) => uniqueStrategy(spec, u) === 'guard');
}

/** The collection validator: types, enums and NOT NULL columns. */
export function validatorFor(spec: TableSpec): Document {
  const properties: Document = {};
  const required: string[] = [];
  for (const [col, cs] of Object.entries(spec.columns)) {
    const field = col === 'id' ? '_id' : col;
    const types = [BSON[cs.type]!];
    if (!cs.required) types.push('null');
    if (cs.type === 'json') types.push('array', 'string', 'number', 'bool');
    if (cs.type === 'int') types.splice(0, 1, 'int', 'long', 'double');
    const p: Document = { bsonType: types.length === 1 ? types[0] : types };
    if (cs.enum) p.enum = cs.required ? cs.enum : [...cs.enum, null];
    properties[field] = p;
    if (cs.required && !cs.identity) required.push(field);
  }
  return { $jsonSchema: { bsonType: 'object', required: [...new Set(['_id', ...required])], properties } };
}

/** Tables whose foreign keys point at `table`, for cascades and restrictions on delete. */
export function referencing(table: string, tables: Record<string, TableSpec> = TABLES) {
  const out: Array<{ table: string; fk: TableSpec['fks'][number] }> = [];
  for (const [name, spec] of Object.entries(tables)) {
    for (const fk of spec.fks) if (fk.ref === table) out.push({ table: name, fk });
  }
  return out;
}

export function keyColumns(u: UniqueSpec): KeyColumn[] {
  return u.cols;
}
