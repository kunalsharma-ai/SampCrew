import { Injectable } from '@nestjs/common';
import type { DepartmentInput, LegalEntityInput } from '@crew/contracts';
import { AuditService, diff } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { countBy, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';

type Row = Record<string, unknown>;

/** Maps camelCase API fields to snake_case columns for the org tables. */
const COLUMNS: Record<string, Record<string, string>> = {
  legal_entities: { name: 'name', legalName: 'legal_name', countryCode: 'country_code', currency: 'currency', timezone: 'timezone', registrationNumber: 'registration_number', taxId: 'tax_id', fiscalYearStartMonth: 'fiscal_year_start_month', address: 'address' },
  business_units: { name: 'name', code: 'code', description: 'description' },
  locations: {
    name: 'name', code: 'code', legalEntityId: 'legal_entity_id', kind: 'kind', timezone: 'timezone', addressLine: 'address_line', city: 'city',
    region: 'region', countryCode: 'country_code', postalCode: 'postal_code', latitude: 'latitude', longitude: 'longitude', geofenceRadiusM: 'geofence_radius_m',
  },
  departments: { name: 'name', code: 'code', parentId: 'parent_id', legalEntityId: 'legal_entity_id', businessUnitId: 'business_unit_id', headMembershipId: 'head_membership_id' },
};

/** A stored row as the API shows it: the mapped fields in camelCase, plus id, archivedAt and createdAt. */
function view(table: OrgTable, row: Row, memberCount?: number): Row {
  const out: Row = { id: row.id };
  for (const [field, col] of Object.entries(COLUMNS[table]!)) out[field] = row[col] ?? null;
  if (table === 'locations') {
    out.latitude = row.latitude == null ? null : Number(row.latitude);
    out.longitude = row.longitude == null ? null : Number(row.longitude);
  }
  out.archivedAt = row.archived_at ?? null;
  out.createdAt = row.created_at;
  if (table === 'departments') out.memberCount = memberCount ?? 0;
  return out;
}

async function views(tx: TenantTx, table: OrgTable, rows: Row[]): Promise<Row[]> {
  const counts = table === 'departments' ? await countBy(tx, 'memberships', 'department_id', rows.map((r) => r.id as string), { status: { $ne: 'suspended' } }) : new Map<string, number>();
  return rows.map((r) => view(table, r, counts.get(r.id as string)));
}

export type OrgTable = 'legal_entities' | 'business_units' | 'locations' | 'departments';

const RESOURCE: Record<OrgTable, string> = { legal_entities: 'legal_entity', business_units: 'business_unit', locations: 'location', departments: 'department' };

@Injectable()
export class OrganizationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly entitlements: EntitlementsService,
  ) {}

  list(table: OrgTable, includeArchived = false) {
    return this.db.tenant(async (tx) => views(tx, table, await tx.collection(table).find(includeArchived ? {} : { archived_at: null }, { sort: { name: 1 } })));
  }

  async get(table: OrgTable, id: string) {
    const row = await this.db.tenant(async (tx) => {
      const found = await tx.collection(table).findOne({ id });
      return found && (await views(tx, table, [found]))[0];
    });
    if (!row) throw Errors.notFound(RESOURCE[table].replace('_', ' '));
    return row;
  }

  async create(table: OrgTable, input: Row) {
    return this.db.tenant(async (tx) => {
      if (table === 'legal_entities') {
        const count = await tx.collection('legal_entities').count({ archived_at: null });
        // A second legal entity needs the multi-entity module as well as room under the plan's entity limit.
        await this.entitlements.requireWithinLimit('max_legal_entities', count, tx);
        if (count >= 1) await this.entitlements.requireFeature('multi_entity', tx);
      }
      if (table === 'departments') await this.checkDepartmentRefs(tx, input as DepartmentInput);
      const cols = COLUMNS[table]!;
      const entries = Object.entries(input).filter(([k, v]) => cols[k] && v !== undefined);
      const row = await tx.collection(table).insert(Object.fromEntries(entries.map(([k, v]) => [cols[k]!, v])));
      await this.audit.record(tx, { action: `${RESOURCE[table]}.created`, resourceType: RESOURCE[table], resourceId: row.id, changes: input });
      await this.outbox.publish(tx, requestTenant(), `org.${RESOURCE[table]}.created`, { id: row.id });
      return (await views(tx, table, [row]))[0];
    });
  }

  async update(table: OrgTable, id: string, input: Row) {
    return this.db.tenant(async (tx) => {
      const stored = await tx.collection(table).findOne({ id });
      if (!stored) throw Errors.notFound(RESOURCE[table].replace('_', ' '));
      const before = (await views(tx, table, [stored]))[0]!;
      if (table === 'departments') await this.checkDepartmentRefs(tx, input as DepartmentInput, id);
      const cols = COLUMNS[table]!;
      const entries = Object.entries(input).filter(([k, v]) => cols[k] && v !== undefined);
      if (entries.length) {
        await tx.collection(table).updateOne({ id }, { $set: Object.fromEntries(entries.map(([k, v]) => [cols[k]!, v])) });
      }
      const after = (await views(tx, table, [(await tx.collection(table).findOne({ id }))!]))[0]!;
      const changes = diff(before, Object.fromEntries(entries.map(([k]) => [k, after[k]])));
      if (Object.keys(changes).length) {
        await this.audit.record(tx, { action: `${RESOURCE[table]}.updated`, resourceType: RESOURCE[table], resourceId: id, changes });
        await this.outbox.publish(tx, requestTenant(), `org.${RESOURCE[table]}.changed`, { id, fields: Object.keys(changes) });
      }
      return after;
    });
  }

  /** Records are archived, never hard-deleted, because employees, payroll and audit history reference them. */
  async archive(table: OrgTable, id: string) {
    return this.db.tenant(async (tx) => {
      const row = await tx.collection(table).findOne({ id });
      if (!row) throw Errors.notFound(RESOURCE[table].replace('_', ' '));
      if (row.archived_at) return;
      if (table === 'departments') {
        const busy = (await tx.collection('departments').count({ parent_id: id, archived_at: null })) + (await tx.collection('memberships').count({ department_id: id, status: { $ne: 'suspended' } }));
        if (busy > 0) throw Errors.conflict('department_in_use', 'Move its members and sub-departments first');
      }
      if (table === 'legal_entities') {
        const n = await tx.collection('legal_entities').count({ archived_at: null });
        if (n <= 1) throw Errors.conflict('last_legal_entity', 'A workspace needs at least one legal entity');
        const used = await tx.collection('memberships').exists({ legal_entity_id: id, status: { $ne: 'suspended' } });
        if (used) throw Errors.conflict('legal_entity_in_use', 'Move its members to another legal entity first');
      }
      await tx.collection(table).updateOne({ id }, { $set: { archived_at: new Date() } });
      await this.audit.record(tx, { action: `${RESOURCE[table]}.archived`, resourceType: RESOURCE[table], resourceId: id });
    });
  }

  /** Department tree with member counts, for the org chart view. */
  async departmentTree() {
    const rows = await this.list('departments');
    type Node = Row & { children: Node[] };
    const byId = new Map<string, Node>(rows.map((r) => [r.id as string, { ...r, children: [] }]));
    const roots: Node[] = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId as string) : undefined;
      (parent ? parent.children : roots).push(node);
    }
    return roots;
  }

  async overview() {
    return this.db.tenant(async (tx) => ({
      legalEntities: await tx.collection('legal_entities').count({ archived_at: null }),
      businessUnits: await tx.collection('business_units').count({ archived_at: null }),
      locations: await tx.collection('locations').count({ archived_at: null }),
      departments: await tx.collection('departments').count({ archived_at: null }),
      activeMembers: await tx.collection('memberships').count({ status: 'active' }),
      pendingInvites: await tx.collection('memberships').count({ status: 'invited' }),
      countries: (await tx.collection('legal_entities').distinct('country_code', { archived_at: null })).length,
    }));
  }

  /**
   * The parent must be a current department, and (the departments_no_cycle trigger in PostgreSQL) a department cannot
   * be moved under itself or one of its own sub-departments.
   */
  private async checkDepartmentRefs(tx: TenantTx, input: Partial<DepartmentInput>, id?: string) {
    if (!input.parentId) return;
    if (!(await tx.collection('departments').exists({ id: input.parentId, archived_at: null }))) throw Errors.badRequest('invalid_parent', 'Parent department not found');
    if (!id) return;
    const parents = new Map((await tx.collection('departments').find({}, { projection: { parent_id: 1 } })).map((d) => [d.id as string, (d.parent_id as string | null) ?? null]));
    for (let at: string | null = input.parentId, steps = 0; at && steps <= parents.size; at = parents.get(at) ?? null, steps++) {
      if (at === id) throw Errors.badRequest('department_cycle', 'A department cannot be placed under itself or one of its sub-departments');
    }
  }
}

export function requestTenant(): string {
  return requestContext.tenantActor().tenantId;
}

export type { LegalEntityInput };
