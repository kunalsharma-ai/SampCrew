import type {
  AggregateOptions,
  ClientSession,
  Collection,
  CountDocumentsOptions,
  DeleteOptions,
  Document,
  Filter,
  FindOneAndDeleteOptions,
  FindOneAndUpdateOptions,
  FindOptions,
  InsertOneOptions,
  OptionalUnlessRequiredId,
  ReplaceOptions,
  UpdateFilter,
  UpdateOptions,
  WithoutId,
} from 'mongodb';
import { mongo } from '@crew/db';

/** SampCrew documents use UUID strings for `_id` (as the PostgreSQL ids were), never ObjectIds. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MongoDoc = { _id: string; [field: string]: any };

/** Thrown when code asks a scoped transaction for something outside its scope. Always a bug, never user input. */
export class ScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeViolationError';
  }
}

/** Whose data a transaction may reach: one workspace, or (before a workspace is chosen) one user's own documents. */
export interface Scope {
  kind: 'tenant' | 'user';
  id: string;
  rules: Record<string, mongo.CollectionRule>;
}

/** The filter a scope applies to a collection with this rule, or null when the collection is shared reference data. */
export function scopeFilter(name: string, scope: Scope): { field: string; value: string } | null {
  const rule = mongo.collectionRule(name, scope.rules);
  if (!rule) throw new ScopeViolationError(`Collection ${name} is not registered (packages/db/src/mongo/collections.ts)`);
  if (rule.scope === 'shared') return null;
  if (rule.scope === 'platform') throw new ScopeViolationError(`Collection ${name} is platform-only`);
  if (scope.kind === 'tenant') return { field: 'tenantId', value: scope.id };
  if (rule.userField) return { field: rule.userField, value: scope.id };
  throw new ScopeViolationError(`Collection ${name} is not readable before a workspace is chosen`);
}

/**
 * Stages a scoped aggregation may use. Anything else (notably $out, $merge, $documents, $collStats, $currentOp,
 * $geoNear, which must come first, and $unionWith, which MongoDB does not allow in a transaction) is refused, so a pipeline cannot write elsewhere or read outside its scope.
 */
const ALLOWED_STAGES = new Set([
  '$match', '$project', '$addFields', '$set', '$unset', '$group', '$sort', '$limit', '$skip', '$count', '$unwind',
  '$lookup', '$graphLookup', '$facet', '$bucket', '$bucketAuto', '$sortByCount', '$replaceRoot',
  '$replaceWith', '$sample', '$densify', '$fill', '$setWindowFields', '$redact',
]);

const UPDATE_OPERATORS_TOUCHING_FIELDS = ['$set', '$unset', '$rename', '$inc', '$mul', '$min', '$max', '$setOnInsert', '$push', '$addToSet', '$pull', '$pullAll', '$pop', '$currentDate', '$bit'];

/**
 * A collection seen through a scope: every filter is narrowed to `scope.field = scope.value`, inserts are stamped
 * with it, and updates cannot change it. This is what replaces PostgreSQL row-level security, so it fails closed:
 * a filter naming another workspace throws instead of silently returning nothing.
 */
export class ScopedCollection<T extends Document = MongoDoc> {
  private readonly field: string;
  private readonly value: string;

  constructor(
    private readonly coll: Collection<T>,
    restriction: { field: string; value: string },
    private readonly scope: Scope,
    private readonly session: ClientSession,
    private readonly writable: boolean,
  ) {
    this.field = restriction.field;
    this.value = restriction.value;
  }

  get collectionName(): string {
    return this.coll.collectionName;
  }

  find(filter: Filter<T> = {}, options: FindOptions = {}) {
    return this.coll.find(this.filter(filter), { ...options, session: this.session });
  }

  findOne(filter: Filter<T> = {}, options: FindOptions = {}) {
    return this.coll.findOne(this.filter(filter), { ...options, session: this.session });
  }

  countDocuments(filter: Filter<T> = {}, options: CountDocumentsOptions = {}) {
    return this.coll.countDocuments(this.filter(filter), { ...options, session: this.session });
  }

  distinct(key: string, filter: Filter<T> = {}) {
    return this.coll.distinct(key as never, this.filter(filter), { session: this.session });
  }

  aggregate<R extends Document = Document>(pipeline: Document[] = [], options: AggregateOptions = {}) {
    return this.coll.aggregate<R>([{ $match: { [this.field]: this.value } }, ...scopePipeline(pipeline, this.scope)], {
      ...options,
      session: this.session,
    });
  }

  insertOne(doc: OptionalUnlessRequiredId<T>, options: InsertOneOptions = {}) {
    this.assertWritable();
    return this.coll.insertOne(this.stamp(doc), { ...options, session: this.session });
  }

  insertMany(docs: OptionalUnlessRequiredId<T>[]) {
    this.assertWritable();
    return this.coll.insertMany(docs.map((d) => this.stamp(d)), { session: this.session, ordered: true });
  }

  updateOne(filter: Filter<T>, update: UpdateFilter<T> | Document[], options: UpdateOptions = {}) {
    this.assertWritable();
    return this.coll.updateOne(this.filter(filter), this.update(update), { ...options, session: this.session });
  }

  updateMany(filter: Filter<T>, update: UpdateFilter<T> | Document[], options: UpdateOptions = {}) {
    this.assertWritable();
    return this.coll.updateMany(this.filter(filter), this.update(update), { ...options, session: this.session });
  }

  findOneAndUpdate(filter: Filter<T>, update: UpdateFilter<T> | Document[], options: FindOneAndUpdateOptions = {}) {
    this.assertWritable();
    return this.coll.findOneAndUpdate(this.filter(filter), this.update(update), { returnDocument: 'after', ...options, session: this.session });
  }

  replaceOne(filter: Filter<T>, replacement: WithoutId<T>, options: ReplaceOptions = {}) {
    this.assertWritable();
    return this.coll.replaceOne(this.filter(filter), this.stamp(replacement as never) as WithoutId<T>, { ...options, session: this.session });
  }

  deleteOne(filter: Filter<T>, options: DeleteOptions = {}) {
    this.assertWritable();
    return this.coll.deleteOne(this.filter(filter), { ...options, session: this.session });
  }

  deleteMany(filter: Filter<T>, options: DeleteOptions = {}) {
    this.assertWritable();
    return this.coll.deleteMany(this.filter(filter), { ...options, session: this.session });
  }

  findOneAndDelete(filter: Filter<T>, options: FindOneAndDeleteOptions = {}) {
    this.assertWritable();
    return this.coll.findOneAndDelete(this.filter(filter), { ...options, session: this.session });
  }

  private assertWritable() {
    if (!this.writable) throw new ScopeViolationError(`${this.coll.collectionName} is read-only from this transaction`);
  }

  private filter(filter: Filter<T>): Filter<T> {
    const given = (filter as Document)[this.field];
    if (given !== undefined && given !== this.value) {
      throw new ScopeViolationError(`${this.coll.collectionName}: filter names a different ${this.field}`);
    }
    return { ...filter, [this.field]: this.value } as Filter<T>;
  }

  private stamp<D>(doc: D): D {
    const given = (doc as Document)[this.field];
    if (given !== undefined && given !== this.value) {
      throw new ScopeViolationError(`${this.coll.collectionName}: document belongs to a different ${this.field}`);
    }
    return { ...doc, [this.field]: this.value };
  }

  private update(update: UpdateFilter<T> | Document[]): UpdateFilter<T> | Document[] {
    if (Array.isArray(update)) {
      // Pipeline updates may compute anything; allow only the stages that cannot read other collections, and
      // never one that sets the scope field.
      for (const stage of update) {
        const [name] = Object.keys(stage);
        if (!name || !['$set', '$addFields', '$unset', '$project', '$replaceRoot', '$replaceWith'].includes(name)) {
          throw new ScopeViolationError(`Update pipeline stage ${name} is not allowed`);
        }
        if (name === '$replaceRoot' || name === '$replaceWith') throw new ScopeViolationError(`${name} could change ${this.field}`);
        const body = stage[name];
        const fields = name === '$unset' ? ([] as string[]).concat(body) : Object.keys(body ?? {});
        if (fields.some((f) => f === this.field || f.startsWith(`${this.field}.`))) {
          throw new ScopeViolationError(`Updates cannot change ${this.field}`);
        }
      }
      return update;
    }
    for (const key of Object.keys(update)) {
      if (!key.startsWith('$')) throw new ScopeViolationError('Use replaceOne to replace a whole document');
    }
    for (const op of UPDATE_OPERATORS_TOUCHING_FIELDS) {
      const body = (update as Document)[op];
      if (!body) continue;
      const fields = Object.keys(body).concat(op === '$rename' ? Object.values(body as Record<string, string>) : []);
      if (fields.some((f) => f === this.field || f.startsWith(`${this.field}.`))) {
        if (op === '$setOnInsert' && body[this.field] === this.value) continue;
        throw new ScopeViolationError(`Updates cannot change ${this.field}`);
      }
    }
    return update;
  }
}

/**
 * Rewrites a pipeline so every stage that reads another collection reads only what this scope may see: tenant
 * collections get the tenant filter, shared collections are read as they are, anything else is refused.
 */
export function scopePipeline(pipeline: Document[], scope: Scope): Document[] {
  return pipeline.map((stage) => {
    const keys = Object.keys(stage);
    if (keys.length !== 1) throw new ScopeViolationError('Each pipeline stage must have exactly one operator');
    const name = keys[0]!;
    if (!ALLOWED_STAGES.has(name)) throw new ScopeViolationError(`Pipeline stage ${name} is not allowed`);
    const body = stage[name];
    switch (name) {
      case '$lookup': {
        const match = foreignMatch(body.from, scope);
        const inner = scopePipeline(body.pipeline ?? [], scope);
        return { $lookup: { ...body, pipeline: match ? [{ $match: match }, ...inner] : inner } };
      }
      case '$graphLookup': {
        const match = foreignMatch(body.from, scope);
        if (!match) return stage;
        const restrict = body.restrictSearchWithMatch ? { $and: [body.restrictSearchWithMatch, match] } : match;
        return { $graphLookup: { ...body, restrictSearchWithMatch: restrict } };
      }
      case '$facet': {
        const out: Document = {};
        for (const [k, sub] of Object.entries(body as Record<string, Document[]>)) out[k] = scopePipeline(sub, scope);
        return { $facet: out };
      }
      default:
        return stage;
    }
  });
}

/** The filter a pipeline must apply when it reads `from`, or null for shared reference data. */
function foreignMatch(from: unknown, scope: Scope): Document | null {
  if (typeof from !== 'string') throw new ScopeViolationError('Pipeline stages must name the collection they read');
  const f = scopeFilter(from, scope);
  return f ? { [f.field]: f.value } : null;
}
