import { mongo } from '@crew/db';
import { Decimal128, type Db, type Document, type MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The PostgreSQL CHECK constraints, compiled by packages/db/src/mongo/checks.ts into the collection validators.
 * Each expression is evaluated by the MongoDB server itself (a $documents pipeline), so this tests what the server
 * enforces, with SQL's rule that only a false CHECK fails and an unknown (null) one passes.
 */
describe('CHECK constraints in MongoDB', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = mongo.createMongoClient({ url: process.env.MONGODB_URL!, appName: 'crew-test-checks' });
    await client.connect();
    db = client.db(mongo.databaseName(process.env.MONGODB_URL!));
  });

  afterAll(async () => {
    await db.collection('t_checked').drop().catch(() => undefined);
    await client.close();
  });

  /** Whether `doc` passes the given CHECK of `table` (false when the server rejects it). */
  const passes = async (table: string, check: string, doc: Document) => {
    const spec = mongo.TABLES[table]!;
    const c = spec.checks.find((x) => x.includes(check));
    if (!c) throw new Error(`${table} has no CHECK containing ${check}`);
    const expr = mongo.compileCheck(table, spec, c);
    const [r] = await db.aggregate([{ $documents: [doc] }, { $project: { _id: 0, ok: { $ne: [expr, false] } } }]).toArray();
    return r!.ok as boolean;
  };

  it('compiles every CHECK in the schema', () => {
    let n = 0;
    for (const [table, spec] of Object.entries(mongo.TABLES)) {
      for (const c of spec.checks) {
        expect(() => mongo.compileCheck(table, spec, c)).not.toThrow();
        n += 1;
      }
    }
    expect(n).toBeGreaterThan(300);
  });

  it('refuses SQL it cannot read instead of skipping it', () => {
    const spec = { ...mongo.TABLES.locations!, checks: ['CHECK ((name SIMILAR TO \'x\'))'] };
    expect(() => mongo.checksValidator('locations', spec)).toThrow(/Cannot enforce locations/);
  });

  it('ranges and cross-field rules, with null passing as in SQL', async () => {
    expect(await passes('locations', 'geofence_radius_m >= 25', { geofence_radius_m: 100 })).toBe(true);
    expect(await passes('locations', 'geofence_radius_m >= 25', { geofence_radius_m: 10 })).toBe(false);
    expect(await passes('locations', 'geofence_radius_m >= 25', {})).toBe(true);
    expect(await passes('locations', 'geofence_radius_m IS NULL) OR', { geofence_radius_m: 100 })).toBe(false);
    expect(await passes('locations', 'geofence_radius_m IS NULL) OR', { geofence_radius_m: 100, latitude: Decimal128.fromString('18.5') })).toBe(true);
    expect(await passes('locations', 'latitude IS NULL) = (longitude IS NULL', { latitude: Decimal128.fromString('18.5') })).toBe(false);
    expect(await passes('locations', "latitude >= ('-90'", { latitude: Decimal128.fromString('-91') })).toBe(false);
    expect(await passes('locations', "latitude >= ('-90'", { latitude: Decimal128.fromString('-90') })).toBe(true);
    expect(await passes('locations', 'length(name) >= 1', { name: '' })).toBe(false);
    expect(await passes('locations', 'length(name) >= 1', { name: 'Pune' })).toBe(true);
  });

  it('regular expressions, case-insensitive on citext columns', async () => {
    expect(await passes('locations', 'country_code ~', { country_code: 'IN' })).toBe(true);
    expect(await passes('locations', 'country_code ~', { country_code: 'in' })).toBe(false);
    expect(await passes('sso_domains', 'domain ~', { domain: 'Example.COM' })).toBe(true);
    expect(await passes('sso_domains', 'domain ~', { domain: 'not a domain' })).toBe(false);
  });

  it('date arithmetic on stored dates', async () => {
    expect(await passes('payroll_runs', 'period_end - period_start', { period_start: '2026-01-01', period_end: '2026-01-31' })).toBe(true);
    expect(await passes('payroll_runs', 'period_end - period_start', { period_start: '2026-01-01', period_end: '2026-02-01' })).toBe(false);
    expect(await passes('payroll_runs', 'period_end - period_start', { period_start: '2026-01-10', period_end: '2026-01-09' })).toBe(false);
    expect(await passes('offers', 'joining_date - 365', { joining_date: '2027-03-01', expires_on: '2026-03-01' })).toBe(true);
    expect(await passes('offers', 'joining_date - 365', { joining_date: '2027-03-01', expires_on: '2026-02-28' })).toBe(false);
  });

  it('arrays, sums, POSITION and = ANY', async () => {
    expect(await passes('attendance_events', 'risk_flags <@', { risk_flags: ['offline', 'mock_location'] })).toBe(true);
    expect(await passes('attendance_events', 'risk_flags <@', { risk_flags: ['offline', 'teleported'] })).toBe(false);
    expect(await passes('invoices', 'total = (subtotal', { subtotal: Decimal128.fromString('100.00'), tax: Decimal128.fromString('18.00'), total: Decimal128.fromString('118.00') })).toBe(true);
    expect(await passes('invoices', 'total = (subtotal', { subtotal: Decimal128.fromString('100.00'), tax: Decimal128.fromString('18.00'), total: Decimal128.fromString('117.99') })).toBe(false);
    const email = Object.entries(mongo.TABLES).find(([, s]) => s.checks.some((c) => c === "CHECK ((POSITION(('@'::text) IN (email)) > 1))"))![0];
    expect(await passes(email, "POSITION(('@'", { email: 'a@b.test' })).toBe(true);
    expect(await passes(email, "POSITION(('@'", { email: '@b.test' })).toBe(false);
    expect(await passes(email, "POSITION(('@'", { email: 'nobody' })).toBe(false);
    expect(await passes('attendance_devices', "vendor = ANY", { protocol: 'push_http', vendor: 'zkteco' })).toBe(true);
    expect(await passes('attendance_devices', "vendor = ANY", { protocol: 'push_http', vendor: 'suprema' })).toBe(false);
  });

  it('the collection validator rejects a document that breaks a CHECK, on insert and on update', async () => {
    const spec: mongo.TableSpec = {
      access: 'platform', grants: [], unique: [], fks: [], indexes: [],
      columns: { id: { type: 'string', required: true }, low: { type: 'int' }, high: { type: 'int' } },
      checks: ['CHECK (((low IS NULL) OR (high IS NULL) OR (low <= high)))'],
    };
    await db.collection('t_checked').drop().catch(() => undefined);
    await db.createCollection('t_checked', { validator: mongo.validatorFor(spec, 't_checked'), validationLevel: 'strict', validationAction: 'error' });
    const c = db.collection<{ _id: string; low?: number; high?: number }>('t_checked');
    await c.insertOne({ _id: 'a', low: 1, high: 5 });
    await c.insertOne({ _id: 'b', low: 9 });
    await expect(c.insertOne({ _id: 'c', low: 9, high: 5 })).rejects.toMatchObject({ code: 121 });
    await expect(c.updateOne({ _id: 'b' }, { $set: { high: 1 } })).rejects.toMatchObject({ code: 121 });
    await c.updateOne({ _id: 'b' }, { $set: { high: 10 } });
  });
});
