import type { Document } from 'mongodb';
import type { ColumnType, TableSpec } from './schema';

/**
 * PostgreSQL CHECK constraints compiled to MongoDB aggregation expressions, so the collection validator enforces
 * them on the server for every insert and update, exactly as the database did before.
 *
 * Only the SQL the schema uses is understood: comparisons, AND / OR / NOT, IS [NOT] NULL, casts, length(),
 * cardinality(), jsonb_typeof(), jsonb_array_length(), lower(), POSITION(.. IN ..), regular expressions (~),
 * = ANY (ARRAY[..]), <@ ARRAY[..], + and -, and date arithmetic. Anything else is refused when the validator is
 * built, so a new CHECK the compiler cannot read is noticed at deploy time instead of being silently skipped.
 *
 * SQL's three-valued logic is kept: an expression evaluates to true, false or null (unknown), and a CHECK fails
 * only when it is false. So `geofence_radius_m >= 25` holds for a location without a geofence, as in PostgreSQL.
 */

type Kind = 'bool' | 'num' | 'str' | 'date' | 'arr' | 'json' | 'any';
interface Val { e: unknown; k: Kind; col?: string }

type Tok = { t: 'id' | 'num' | 'str' | 'op'; v: string };

export class CheckSyntaxError extends Error {
  constructor(table: string, check: string, why: string) {
    super(`Cannot enforce ${table} ${check}: ${why}`);
    this.name = 'CheckSyntaxError';
  }
}

function tokenize(src: string, fail: (why: string) => never): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "'") {
      let s = '';
      i += 1;
      for (;;) {
        if (i >= src.length) fail('unterminated string');
        if (src[i] === "'") {
          if (src[i + 1] === "'") { s += "'"; i += 2; continue; }
          i += 1;
          break;
        }
        s += src[i];
        i += 1;
      }
      out.push({ t: 'str', v: s });
      continue;
    }
    if (c === '"') {
      const j = src.indexOf('"', i + 1);
      if (j < 0) fail('unterminated identifier');
      out.push({ t: 'id', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    const op = /^(::|<=|>=|<>|<@|!=|[=<>~(),[\]+-])/.exec(src.slice(i));
    if (op) { out.push({ t: 'op', v: op[0] }); i += op[0].length; continue; }
    fail(`unexpected "${c}"`);
  }
  return out;
}

const KIND: Record<ColumnType, Kind> = {
  uuid: 'str', string: 'str', citext: 'str', int: 'num', decimal: 'num', bool: 'bool', json: 'json', date: 'date', time: 'str', timestamp: 'any',
  bytes: 'any', 'string[]': 'arr', 'uuid[]': 'arr', 'int[]': 'arr',
};

const isNull = (e: unknown) => ({ $eq: [e, null] });
/** null when any argument is null, otherwise `e`. */
const strict = (args: unknown[], e: unknown) => ({ $cond: [{ $in: [null, args] }, null, e] });

class Compiler {
  private i = 0;
  private readonly toks: Tok[];

  constructor(private readonly table: string, private readonly spec: TableSpec, private readonly src: string) {
    this.toks = tokenize(src, (why) => this.fail(why));
  }

  fail(why: string): never {
    throw new CheckSyntaxError(this.table, this.src, why);
  }

  compile(): unknown {
    if (!this.word('CHECK')) this.fail('expected CHECK');
    const v = this.expr();
    if (this.i !== this.toks.length) this.fail(`unexpected "${this.peek()?.v}"`);
    return v.e;
  }

  private peek(o = 0) { return this.toks[this.i + o]; }
  private op(v: string) {
    const t = this.peek();
    if (t?.t === 'op' && t.v === v) { this.i += 1; return true; }
    return false;
  }
  private word(v: string) {
    const t = this.peek();
    if (t?.t === 'id' && t.v.toUpperCase() === v) { this.i += 1; return true; }
    return false;
  }
  private need(v: string) {
    if (!this.op(v)) this.fail(`expected "${v}" at "${this.peek()?.v ?? 'end'}"`);
  }

  private expr(): Val { return this.or(); }

  private or(): Val {
    let l = this.and();
    while (this.word('OR')) {
      const r = this.and();
      l = { k: 'bool', e: { $cond: [{ $in: [true, [l.e, r.e]] }, true, { $cond: [{ $in: [null, [l.e, r.e]] }, null, false] }] } };
    }
    return l;
  }

  private and(): Val {
    let l = this.not();
    while (this.word('AND')) {
      const r = this.not();
      l = { k: 'bool', e: { $cond: [{ $in: [false, [l.e, r.e]] }, false, { $cond: [{ $in: [null, [l.e, r.e]] }, null, true] }] } };
    }
    return l;
  }

  private not(): Val {
    if (this.word('NOT')) {
      const v = this.not();
      return { k: 'bool', e: strict([v.e], { $not: [v.e] }) };
    }
    return this.cmp();
  }

  private cmp(): Val {
    const l = this.add();
    if (this.word('IS')) {
      const negate = this.word('NOT');
      if (!this.word('NULL')) this.fail('expected NULL');
      return { k: 'bool', e: negate ? { $ne: [l.e, null] } : isNull(l.e) };
    }
    const t = this.peek();
    if (t?.t !== 'op') return l;
    const ops: Record<string, string> = { '=': '$eq', '<>': '$ne', '!=': '$ne', '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' };
    if (ops[t.v]) {
      this.i += 1;
      if (t.v === '=' && this.word('ANY')) {
        this.need('(');
        const list = this.add();
        this.need(')');
        return { k: 'bool', e: strict([l.e], { $in: [l.e, list.e] }) };
      }
      const r = this.add();
      return { k: 'bool', e: strict([l.e, r.e], { [ops[t.v]!]: [l.e, r.e] }) };
    }
    if (t.v === '~') {
      this.i += 1;
      const r = this.add();
      if (typeof r.e !== 'object' || r.e === null || !('$literal' in r.e)) this.fail('a regular expression must be a literal');
      const pattern = (r.e as { $literal: string }).$literal;
      const fold = !!l.col && this.spec.columns[l.col]?.type === 'citext';
      return {
        k: 'bool',
        e: { $cond: [{ $eq: [{ $type: l.e }, 'string'] }, { $regexMatch: { input: l.e, regex: pattern, ...(fold ? { options: 'i' } : {}) } }, null] },
      };
    }
    if (t.v === '<@') {
      this.i += 1;
      const r = this.add();
      return { k: 'bool', e: { $cond: [{ $isArray: [l.e] }, { $setIsSubset: [l.e, r.e] }, null] } };
    }
    return l;
  }

  private add(): Val {
    let l = this.unary();
    for (;;) {
      if (this.op('+')) {
        const r = this.unary();
        l = { k: 'num', e: strict([l.e, r.e], { $add: [l.e, r.e] }) };
      } else if (this.op('-')) {
        const r = this.unary();
        l = this.minus(l, r);
      } else return l;
    }
  }

  private minus(l: Val, r: Val): Val {
    const day = (s: unknown) => ({ $dateFromString: { dateString: s, format: '%Y-%m-%d' } });
    if (l.k === 'date' && r.k === 'date') {
      return { k: 'num', e: strict([l.e, r.e], { $dateDiff: { startDate: day(r.e), endDate: day(l.e), unit: 'day' } }) };
    }
    if (l.k === 'date' && r.k === 'num') {
      return {
        k: 'date',
        e: strict([l.e, r.e], { $dateToString: { date: { $dateSubtract: { startDate: day(l.e), unit: 'day', amount: r.e } }, format: '%Y-%m-%d' } }),
      };
    }
    return { k: 'num', e: strict([l.e, r.e], { $subtract: [l.e, r.e] }) };
  }

  private unary(): Val {
    if (this.op('-')) {
      const v = this.unary();
      return { k: 'num', e: strict([v.e], { $multiply: [-1, v.e] }) };
    }
    let v = this.primary();
    while (this.op('::')) v = this.cast(v);
    return v;
  }

  private cast(v: Val): Val {
    const t = this.peek();
    if (t?.t !== 'id') this.fail('expected a type');
    this.i += 1;
    const type = t.v.toLowerCase();
    const lit = typeof v.e === 'object' && v.e !== null && '$literal' in v.e ? (v.e as { $literal: unknown }).$literal : undefined;
    if (['integer', 'numeric', 'smallint', 'bigint'].includes(type)) {
      if (typeof lit === 'string' && /^-?\d+(\.\d+)?$/.test(lit)) return { k: 'num', e: { $literal: Number(lit) } };
      return { ...v, k: 'num' };
    }
    if (['text', 'citext', 'uuid'].includes(type)) return { ...v, k: v.k === 'any' ? 'str' : v.k };
    if (type === 'date') return { ...v, k: 'date' };
    return this.fail(`unknown type ${type}`);
  }

  private list(): unknown[] {
    const items: unknown[] = [];
    if (this.op(']')) return items;
    do {
      const v = this.add();
      items.push(typeof v.e === 'object' && v.e !== null && '$literal' in v.e ? (v.e as { $literal: unknown }).$literal : this.fail('array items must be literals'));
    } while (this.op(','));
    this.need(']');
    return items;
  }

  private primary(): Val {
    const t = this.peek();
    if (!t) this.fail('unexpected end');
    if (t.t === 'num') { this.i += 1; return { k: 'num', e: { $literal: Number(t.v) } }; }
    if (t.t === 'str') { this.i += 1; return { k: 'str', e: { $literal: t.v } }; }
    if (this.op('(')) {
      const v = this.expr();
      this.need(')');
      return v;
    }
    if (t.t !== 'id') this.fail(`unexpected "${t.v}"`);
    const name = t.v;
    const upper = name.toUpperCase();
    if (upper === 'ARRAY') {
      this.i += 1;
      this.need('[');
      return { k: 'arr', e: { $literal: this.list() } };
    }
    if (upper === 'POSITION' && this.peek(1)?.v === '(') {
      this.i += 2;
      const needle = this.add();
      if (!this.word('IN')) this.fail('expected IN');
      const hay = this.add();
      this.need(')');
      // SQL counts from 1 and answers 0 when the text is absent; $indexOfCP counts from 0 and answers -1.
      return { k: 'num', e: strict([needle.e, hay.e], { $add: [{ $indexOfCP: [hay.e, needle.e] }, 1] }) };
    }
    if (this.peek(1)?.t === 'op' && this.peek(1)?.v === '(') {
      this.i += 2;
      const arg = this.expr();
      this.need(')');
      return this.call(name.toLowerCase(), arg);
    }
    this.i += 1;
    const cs = this.spec.columns[name];
    if (!cs) this.fail(`unknown column ${name}`);
    const field = name === 'id' ? '$_id' : `$${name}`;
    return { k: KIND[cs.type], e: { $ifNull: [field, null] }, col: name };
  }

  private call(fn: string, a: Val): Val {
    switch (fn) {
      case 'length':
        return { k: 'num', e: { $cond: [{ $eq: [{ $type: a.e }, 'string'] }, { $strLenCP: a.e }, null] } };
      case 'lower':
        return { k: 'str', e: strict([a.e], { $toLower: a.e }) };
      case 'cardinality':
      case 'jsonb_array_length':
        return { k: 'num', e: { $cond: [{ $isArray: [a.e] }, { $size: a.e }, null] } };
      case 'jsonb_typeof':
        return {
          k: 'str',
          e: {
            $switch: {
              branches: [
                { case: isNull(a.e), then: null },
                { case: { $isArray: [a.e] }, then: 'array' },
                { case: { $eq: [{ $type: a.e }, 'object'] }, then: 'object' },
                { case: { $eq: [{ $type: a.e }, 'string'] }, then: 'string' },
                { case: { $eq: [{ $type: a.e }, 'bool'] }, then: 'boolean' },
              ],
              default: 'number',
            },
          },
        };
      default:
        return this.fail(`unknown function ${fn}()`);
    }
  }
}

/** One CHECK constraint as an aggregation expression that is true, false or null. */
export function compileCheck(table: string, spec: TableSpec, check: string): unknown {
  return new Compiler(table, spec, check).compile();
}

/** The `$expr` part of a collection validator: every CHECK of the table must not be false. Null when it has none. */
export function checksValidator(table: string, spec: TableSpec): Document | null {
  if (!spec.checks.length) return null;
  const parts = spec.checks.map((c) => ({ $ne: [compileCheck(table, spec, c), false] }));
  return { $expr: parts.length === 1 ? parts[0] : { $and: parts } };
}
