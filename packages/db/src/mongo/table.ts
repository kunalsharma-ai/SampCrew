import { randomUUID } from 'node:crypto';
import {
  MongoServerError,
  type AggregateOptions,
  type ClientSession,
  type Db,
  type Document,
  type FindOptions,
} from 'mongodb';
import {
  ConstraintError,
  guardKey,
  guardedKeys,
  prepareFilter,
  prepareInsert,
  prepareUpdate,
  referencing,
  tableSpec,
  toRow,
} from './engine';
import type { TableSpec } from './schema';
import { TABLES } from './schema.generated';

export const UNIQUE_GUARDS = '_unique_keys';
export const SEQUENCES = '_sequences';

/** Thrown when code asks a scoped transaction for something outside its scope. Always a bug, never user input. */
export class ScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeViolationError';
  }
}

/** Whose rows a transaction may reach. Platform transactions have no scope. */
export interface Scope {
  kind: 'tenant' | 'user';
  id: string;
}

export type Op = 'select' | 'insert' | 'update' | 'delete';

/** Tables that are append-only in PostgreSQL (reject_mutation trigger): rows are never changed or removed. */
function appendOnly(spec: TableSpec) {
  return spec.triggers?.includes('reject_mutation') ?? false;
}

/** The restriction a scope puts on a table, or null when the table is shared reference data. */
export function restrictionFor(name: string, spec: TableSpec, scope: Scope | null): { field: string; value: string } | null {
  if (!scope) return null;
  switch (spec.access) {
    case 'shared':
      return null;
    case 'platform':
    case 'users':
      throw new ScopeViolationError(`${name} is not reachable from a ${scope.kind === 'tenant' ? 'workspace' : 'user'} transaction`);
    case 'tenant_self':
      if (scope.kind === 'tenant') return { field: '_id', value: scope.id };
      throw new ScopeViolationError(`${name} is not reachable before a workspace is chosen`);
    case 'tenant_or_user':
      return scope.kind === 'tenant' ? { field: 'tenant_id', value: scope.id } : { field: 'user_id', value: scope.id };
    case 'tenant':
      if (scope.kind === 'tenant') return { field: 'tenant_id', value: scope.id };
      throw new ScopeViolationError(`${name} is not reachable before a workspace is chosen`);
  }
}

export function allowedOps(spec: TableSpec, scope: Scope | null): Set<Op> {
  if (appendOnly(spec)) return new Set(scope && !spec.grants.includes('insert') ? ['select'] : ['select', 'insert']);
  if (!scope) return new Set(['select', 'insert', 'update', 'delete']);
  if (spec.access === 'shared') return new Set(['select']);
  if (scope.kind === 'user') return new Set(['select']);
  return new Set(spec.grants as Op[]);
}

/**
 * Stages a scoped aggregation may use. Anything else (notably $out, $merge, $documents, $collStats, $currentOp,
 * $geoNear, which must come first, and $unionWith, which MongoDB does not allow in a transaction) is refused,
 * so a pipeline cannot write elsewhere or read outside its scope.
 */
const ALLOWED_STAGES = new Set([
  '$match', '$project', '$addFields', '$set', '$unset', '$group', '$sort', '$limit', '$skip', '$count', '$unwind',
  '$lookup', '$graphLookup', '$facet', '$bucket', '$bucketAuto', '$sortByCount', '$replaceRoot', '$replaceWith',
  '$sample', '$densify', '$fill', '$setWindowFields', '$redact',
]);

export interface TableOptions {
  scope: Scope | null;
  tables?: Record<string, TableSpec>;
  /** Refuse every write, whatever the grants say (e.g. the audit trail from a workspace). */
  readOnly?: boolean;
  /** Extra filter every read and write must also match (e.g. users who are members of the workspace). */
  within?: Document;
  /** Apply the table's workspace column limits even without a scope (users seen from a workspace). */
  workspaceColumns?: boolean;
}

export type Row = Document;

/**
 * One collection seen through a transaction. It applies the PostgreSQL rules (defaults, types, NOT NULL, enums,
 * unique keys, foreign keys, cascades) and, with a scope, confines every read and write to that workspace or user,
 * the way row-level security did. Rows come back with `id` (not `_id`), decimals as strings and dates as
 * 'YYYY-MM-DD', as node-postgres returned them.
 */
export class Table<T extends Row = Row> {
  readonly spec: TableSpec;
  private readonly restriction: { field: string; value: string } | null;
  private readonly ops: Set<Op>;
  private readonly tables: Record<string, TableSpec>;

  constructor(
    private readonly db: Db,
    readonly name: string,
    private readonly session: ClientSession,
    private readonly opts: TableOptions,
  ) {
    this.tables = opts.tables ?? TABLES;
    this.spec = tableSpec(name, this.tables);
    this.restriction = restrictionFor(name, this.spec, opts.scope);
    this.ops = opts.readOnly ? new Set<Op>(['select']) : allowedOps(this.spec, opts.scope);
    this.columns = (opts.scope || opts.workspaceColumns) && this.spec.tenantColumns ? this.spec.tenantColumns : null;
  }

  private readonly columns: { select: string[]; update: string[] } | null;

  private get coll() {
    return this.db.collection(this.name);
  }

  // ----------------------------------------------------------------------------------------------- reads

  /** Rows matching `filter`. `sort` and `projection` may name `id`. */
  async find(filter: Document = {}, options: FindOptions & { sort?: Document; projection?: Document } = {}): Promise<T[]> {
    this.need('select');
    const docs = await this.coll
      .find(this.filter(filter), { ...options, sort: mapIdKeys(options.sort), projection: mapIdKeys(options.projection), session: this.session })
      .toArray();
    return docs.map((d) => this.visible(toRow<T>(d)));
  }

  async findOne(filter: Document = {}, options: FindOptions & { sort?: Document; projection?: Document } = {}): Promise<T | undefined> {
    const rows = await this.find(filter, { ...options, limit: 1 });
    return rows[0];
  }

  async count(filter: Document = {}): Promise<number> {
    this.need('select');
    return this.coll.countDocuments(this.filter(filter), { session: this.session });
  }

  async exists(filter: Document = {}): Promise<boolean> {
    return (await this.findOne(filter, { projection: { _id: 1 } })) !== undefined;
  }

  async distinct<V = unknown>(field: string, filter: Document = {}): Promise<V[]> {
    this.need('select');
    const values = await this.coll.distinct(field === 'id' ? '_id' : field, this.filter(filter), { session: this.session });
    return values.map((v) => toRow({ v }).v as V);
  }

  /**
   * An aggregation over this collection's rows in scope. `$lookup`, `$graphLookup` and `$facet` read only rows in
   * the same scope. Write `_id` (not `id`) inside the pipeline; results come back with `id`.
   */
  async aggregate<R extends Row = Row>(pipeline: Document[] = [], options: AggregateOptions = {}): Promise<R[]> {
    this.need('select');
    const start = this.restriction ? [{ $match: { [this.restriction.field]: this.restriction.value } }] : [];
    const docs = await this.coll.aggregate([...start, ...scopePipeline(pipeline, this.opts.scope, this.tables)], { ...options, session: this.session }).toArray();
    if (this.columns) throw new ScopeViolationError(`${this.name}: use find() from a workspace transaction`);
    return docs.map((d) => toRow<R>(deepRow(d)));
  }

  // ----------------------------------------------------------------------------------------------- writes

  /** Inserts a row (defaults applied, rules checked) and returns it as stored. */
  async insert(row: Partial<T> & Row): Promise<T> {
    const [out] = await this.insertMany([row]);
    return out!;
  }

  async insertMany(rows: Array<Partial<T> & Row>): Promise<T[]> {
    this.need('insert');
    if (!rows.length) return [];
    const docs: Document[] = [];
    for (const row of rows) {
      const doc = prepareInsert(this.name, this.spec, this.stamp(row));
      for (const [col, cs] of Object.entries(this.spec.columns)) {
        if (cs.identity && doc[col === 'id' ? '_id' : col] === undefined) doc[col === 'id' ? '_id' : col] = await this.nextSequence();
      }
      docs.push(doc);
    }
    for (const doc of docs) await this.checkForeignKeys(doc);
    await this.addGuards(docs);
    await this.wrap(() => this.coll.insertMany(docs, { session: this.session, ordered: true }));
    return docs.map((d) => toRow<T>(d));
  }

  /** Updates matching rows. Returns how many matched. */
  async update(filter: Document, update: Document, options: { limit?: 1 } = {}): Promise<number> {
    this.need('update');
    this.checkUpdateScope(update);
    const prepared = prepareUpdate(this.name, this.spec, update);
    const f = this.filter(filter);
    const needRows = this.needsRowsOnUpdate(prepared);
    if (!needRows) {
      const r = await this.wrap(() =>
        options.limit === 1 ? this.coll.updateOne(f, prepared, { session: this.session }) : this.coll.updateMany(f, prepared, { session: this.session }),
      );
      return r.matchedCount;
    }
    const before = await this.coll.find(f, { session: this.session, ...(options.limit === 1 ? { limit: 1 } : {}) }).toArray();
    if (!before.length) return 0;
    const ids = before.map((d) => d._id);
    await this.wrap(() => this.coll.updateMany({ _id: { $in: ids } }, prepared, { session: this.session }));
    const after = await this.coll.find({ _id: { $in: ids } }, { session: this.session }).toArray();
    const changed = changedColumns(prepared);
    for (const doc of after) await this.checkForeignKeys(doc, changed);
    await this.removeGuards(before);
    await this.addGuards(after);
    return before.length;
  }

  async updateOne(filter: Document, update: Document): Promise<number> {
    return this.update(filter, update, { limit: 1 });
  }

  /** Updates one row and returns it as it is after the update, or undefined if none matched. */
  async updateAndGet(filter: Document, update: Document): Promise<T | undefined> {
    this.need('update');
    this.checkUpdateScope(update);
    const target = await this.coll.findOne(this.filter(filter), { session: this.session, projection: { _id: 1 } });
    if (!target) return undefined;
    await this.update({ _id: target._id }, update, { limit: 1 });
    return toRow<T>(await this.coll.findOne({ _id: target._id }, { session: this.session }));
  }

  /** Inserts `row` unless a row matches `filter`; then applies `update` (if given) to that row instead. */
  async upsert(filter: Document, row: Partial<T> & Row, update?: Document): Promise<T> {
    const existing = await this.coll.findOne(this.filter(filter), { session: this.session, projection: { _id: 1 } });
    if (!existing) return this.insert(row);
    if (update && Object.keys(update).length) await this.update({ _id: existing._id }, update, { limit: 1 });
    return toRow<T>(await this.coll.findOne({ _id: existing._id }, { session: this.session }));
  }

  /** Deletes matching rows, applying ON DELETE rules of the tables that reference them. Returns how many. */
  async delete(filter: Document, options: { limit?: 1 } = {}): Promise<number> {
    this.need('delete');
    const docs = await this.coll.find(this.filter(filter), { session: this.session, ...(options.limit === 1 ? { limit: 1 } : {}) }).toArray();
    if (!docs.length) return 0;
    await removeRows(this.db, this.session, this.name, this.spec, docs, this.tables);
    return docs.length;
  }

  async deleteOne(filter: Document): Promise<number> {
    return this.delete(filter, { limit: 1 });
  }

  // ----------------------------------------------------------------------------------------------- internals

  private need(op: Op) {
    if (!this.ops.has(op)) {
      throw new ScopeViolationError(`${this.name}: ${op} is not allowed from this transaction`);
    }
  }

  /** Drops columns a workspace may not read (password hashes, MFA secrets). */
  private visible(row: T): T {
    if (!this.columns) return row;
    const out: Row = {};
    for (const c of this.columns.select) if (c in row) out[c] = row[c];
    return out as T;
  }

  private filter(filter: Document): Document {
    let f = prepareFilter(this.name, this.spec, filter);
    if (this.columns) {
      const named = Object.keys(f).filter((k) => !k.startsWith('$')).map((k) => (k === '_id' ? 'id' : k));
      if (named.some((k) => !this.columns!.select.includes(k))) throw new ScopeViolationError(`${this.name}: cannot filter on hidden columns`);
    }
    if (this.opts.within) f = { $and: [f, this.opts.within] };
    if (!this.restriction) return f;
    const { field, value } = this.restriction;
    const given = f[field];
    if (given !== undefined && given !== value && !(typeof given === 'object' && given !== null)) {
      throw new ScopeViolationError(`${this.name}: filter names a different ${field === '_id' ? 'workspace' : field}`);
    }
    if (given !== undefined && typeof given === 'object' && given !== null) {
      return { $and: [f, { [field]: value }] };
    }
    return { ...f, [field]: value };
  }

  private stamp(row: Row): Row {
    if (!this.restriction) return row;
    const { field, value } = this.restriction;
    const key = field === '_id' ? 'id' : field;
    const given = row[key] ?? row[field];
    if (given !== undefined && given !== value) {
      throw new ScopeViolationError(`${this.name}: row belongs to a different ${key === 'id' ? 'workspace' : key}`);
    }
    return { ...row, [key]: value };
  }

  private checkUpdateScope(update: Document) {
    if (this.columns) {
      for (const body of Object.values(update)) {
        for (const f of Object.keys((body as Document) ?? {})) {
          if (!this.columns.update.includes(f.split('.')[0]!)) throw new ScopeViolationError(`${this.name}.${f} cannot be changed from a workspace`);
        }
      }
    }
    if (!this.restriction) return;
    const field = this.restriction.field;
    for (const [op, body] of Object.entries(update)) {
      if (!op.startsWith('$') || !body || typeof body !== 'object') continue;
      const fields = Object.keys(body).concat(op === '$rename' ? Object.values(body as Record<string, string>) : []);
      if (fields.some((f) => f === field || f.startsWith(`${field}.`) || (field === '_id' && f === 'id'))) {
        throw new ScopeViolationError(`${this.name}: updates cannot change ${field}`);
      }
    }
  }

  private needsRowsOnUpdate(prepared: Document): boolean {
    const changed = changedColumns(prepared);
    if (this.spec.fks.some((fk) => fk.cols.some((c) => changed.has(c)))) return true;
    return guardedKeys(this.spec).some((u) => u.cols.some((c) => changed.has(c.col)) || (u.where ?? []).some((c) => changed.has(c.col)));
  }

  private async checkForeignKeys(doc: Document, onlyChanged?: Set<string>) {
    for (const fk of this.spec.fks) {
      if (onlyChanged && !fk.cols.some((c) => onlyChanged.has(c))) continue;
      const values = fk.cols.map((c) => doc[c === 'id' ? '_id' : c]);
      if (values.some((v) => v === null || v === undefined)) continue;
      // A row may reference itself (e.g. a department's parent inserted in the same statement in SQL).
      if (fk.ref === this.name && fk.refCols.every((rc, i) => (rc === 'id' ? doc._id : doc[rc]) === values[i])) continue;
      const q: Document = {};
      fk.refCols.forEach((rc, i) => (q[rc === 'id' ? '_id' : rc] = values[i]));
      const found = await this.db.collection(fk.ref).findOne(q, { session: this.session, projection: { _id: 1 } });
      if (!found) {
        throw new ConstraintError('23503', `${this.name}.${fk.cols.join(', ')} refers to a ${fk.ref} row that does not exist`, `${this.name}_${fk.cols.join('_')}_fkey`, this.name);
      }
    }
  }

  private async addGuards(docs: Document[]) {
    await addGuards(this.db, this.session, this.name, this.spec, docs);
  }

  private async removeGuards(docs: Document[]) {
    await removeGuards(this.db, this.session, this.name, this.spec, docs);
  }

  private async nextSequence(): Promise<number> {
    const r = await this.db
      .collection<{ _id: string; value: number }>(SEQUENCES)
      .findOneAndUpdate({ _id: this.name }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', session: this.session });
    return r!.value;
  }

  private async wrap<R>(fn: () => Promise<R>): Promise<R> {
    return wrapErrors(this.name, fn);
  }
}

export async function wrapErrors<R>(table: string, fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) {
      const index = /index: (\S+)/.exec(err.message)?.[1];
      throw new ConstraintError('23505', `A ${table} row with these details already exists`, index, table);
    }
    if (err instanceof MongoServerError && err.code === 121) {
      throw new ConstraintError('23514', `A ${table} row breaks the collection's rules`, undefined, table);
    }
    throw err;
  }
}

function changedColumns(prepared: Document): Set<string> {
  const out = new Set<string>();
  for (const [op, body] of Object.entries(prepared)) {
    if (!op.startsWith('$') || !body || typeof body !== 'object') continue;
    for (const p of Object.keys(body)) out.add(p.split('.')[0]!);
    if (op === '$rename') for (const p of Object.values(body as Record<string, string>)) out.add(p.split('.')[0]!);
  }
  return out;
}

async function addGuards(db: Db, session: ClientSession, name: string, spec: TableSpec, docs: Document[]) {
  const guards = guardedKeys(spec);
  if (!guards.length) return;
  const rows: Document[] = [];
  for (const doc of docs) {
    for (const u of guards) {
      const key = guardKey(name, spec, u, doc);
      if (key) rows.push({ _id: key, table: name, row: doc._id });
    }
  }
  if (!rows.length) return;
  try {
    await db.collection(UNIQUE_GUARDS).insertMany(rows as never, { session, ordered: true });
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) {
      const key = /dup key: \{ _id: "([^|]+)\|([^|]+)\|/.exec(err.message);
      throw new ConstraintError('23505', `A ${name} row with these details already exists`, key?.[2], name);
    }
    throw err;
  }
}

async function removeGuards(db: Db, session: ClientSession, name: string, spec: TableSpec, docs: Document[]) {
  const guards = guardedKeys(spec);
  if (!guards.length) return;
  const keys = docs.flatMap((doc) => guards.map((u) => guardKey(name, spec, u, doc)).filter((k): k is string => !!k));
  if (keys.length) await db.collection(UNIQUE_GUARDS).deleteMany({ _id: { $in: keys as never[] } }, { session });
}

/**
 * Deletes documents and applies the ON DELETE rule of every foreign key that points at them: CASCADE deletes the
 * referencing rows (recursively), SET NULL clears the reference, and NO ACTION / RESTRICT refuses with 23503.
 */
export async function removeRows(db: Db, session: ClientSession, name: string, spec: TableSpec, docs: Document[], tables: Record<string, TableSpec> = TABLES): Promise<void> {
  if (spec.triggers?.includes('reject_mutation')) throw new ConstraintError('23514', `${name} is append-only`, undefined, name);
  const ids = new Set(docs.map((d) => d._id));
  for (const { table, fk } of referencing(name, tables)) {
    const refSpec = tableSpec(table, tables);
    for (const doc of docs) {
      const q: Document = {};
      fk.refCols.forEach((rc, i) => (q[fk.cols[i]!] = rc === 'id' ? doc._id : doc[rc]));
      if (Object.values(q).some((v) => v === null || v === undefined)) continue;
      if (table === name) {
        // Rows of the same table being deleted together do not block each other.
        q._id = { $nin: [...ids] };
      }
      if (fk.onDelete === 'cascade') {
        const children = await db.collection(table).find(q, { session }).toArray();
        if (children.length) await removeRows(db, session, table, refSpec, children, tables);
      } else if (fk.onDelete === 'set_null') {
        const nullable = fk.cols.filter((c) => !refSpec.columns[c]?.required);
        await db.collection(table).updateMany(q, { $set: Object.fromEntries(nullable.map((c) => [c, null])) }, { session });
      } else {
        const blocking = await db.collection(table).findOne(q, { session, projection: { _id: 1 } });
        if (blocking) {
          throw new ConstraintError('23503', `This ${name} row is still referenced by ${table}`, `${table}_${fk.cols.join('_')}_fkey`, table);
        }
      }
    }
  }
  await removeGuards(db, session, name, spec, docs);
  await db.collection(name).deleteMany({ _id: { $in: [...ids] } }, { session });
}

function mapIdKeys(d: Document | undefined): Document | undefined {
  if (!d) return d;
  const out: Document = {};
  for (const [k, v] of Object.entries(d)) out[k === 'id' ? '_id' : k] = v;
  return out;
}

/** Nested documents from $lookup get the same treatment as top-level rows. */
function deepRow(v: unknown): Document {
  if (Array.isArray(v)) return v.map(deepRow) as never;
  if (v && typeof v === 'object' && !(v instanceof Date) && v.constructor?.name === 'Object') {
    const out: Document = {};
    for (const [k, x] of Object.entries(v)) out[k] = Array.isArray(x) || (x && typeof x === 'object' && (x as object).constructor?.name === 'Object') ? deepRow(x) : x;
    return '_id' in out && out !== v ? toRow(out) : out;
  }
  return v as Document;
}

/**
 * Rewrites a pipeline so every stage that reads another collection reads only what the scope may see: tenant
 * tables get the scope filter, shared tables are read as they are, anything else is refused.
 */
export function scopePipeline(pipeline: Document[], scope: Scope | null, tables: Record<string, TableSpec> = TABLES): Document[] {
  return pipeline.map((stage) => {
    const keys = Object.keys(stage);
    if (keys.length !== 1) throw new ScopeViolationError('Each pipeline stage must have exactly one operator');
    const name = keys[0]!;
    if (!ALLOWED_STAGES.has(name)) throw new ScopeViolationError(`Pipeline stage ${name} is not allowed`);
    const body = stage[name];
    switch (name) {
      case '$lookup': {
        const match = foreignMatch(body.from, scope, tables);
        const inner = scopePipeline(body.pipeline ?? [], scope, tables);
        return { $lookup: { ...body, pipeline: match ? [{ $match: match }, ...inner] : inner } };
      }
      case '$graphLookup': {
        const match = foreignMatch(body.from, scope, tables);
        if (!match) return stage;
        const restrict = body.restrictSearchWithMatch ? { $and: [body.restrictSearchWithMatch, match] } : match;
        return { $graphLookup: { ...body, restrictSearchWithMatch: restrict } };
      }
      case '$facet': {
        const out: Document = {};
        for (const [k, sub] of Object.entries(body as Record<string, Document[]>)) out[k] = scopePipeline(sub, scope, tables);
        return { $facet: out };
      }
      default:
        return stage;
    }
  });
}

function foreignMatch(from: unknown, scope: Scope | null, tables: Record<string, TableSpec>): Document | null {
  if (typeof from !== 'string') throw new ScopeViolationError('Pipeline stages must name the collection they read');
  const spec = tableSpec(from, tables);
  if (!scope) return null;
  const r = restrictionFor(from, spec, scope);
  if (r && !allowedOps(spec, scope).has('select')) throw new ScopeViolationError(`${from} cannot be read from this transaction`);
  return r ? { [r.field]: r.value } : null;
}

export const newId = () => randomUUID();
