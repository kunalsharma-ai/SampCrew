import { Injectable } from '@nestjs/common';
import type { DepartmentInput, LegalEntityInput } from '@crew/contracts';
import { AuditService, diff } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
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

const SELECT: Record<string, string> = {
  legal_entities: `id, name, legal_name as "legalName", country_code as "countryCode", currency, timezone, registration_number as "registrationNumber",
    tax_id as "taxId", fiscal_year_start_month as "fiscalYearStartMonth", address, archived_at as "archivedAt", created_at as "createdAt"`,
  business_units: `id, name, code, description, archived_at as "archivedAt", created_at as "createdAt"`,
  locations: `id, name, code, kind, legal_entity_id as "legalEntityId", timezone, address_line as "addressLine", city, region, country_code as "countryCode",
    postal_code as "postalCode", latitude::float8 as latitude, longitude::float8 as longitude, geofence_radius_m as "geofenceRadiusM", archived_at as "archivedAt", created_at as "createdAt"`,
  departments: `id, name, code, parent_id as "parentId", legal_entity_id as "legalEntityId", business_unit_id as "businessUnitId",
    head_membership_id as "headMembershipId", archived_at as "archivedAt", created_at as "createdAt",
    (select count(*)::int from memberships m where m.department_id = departments.id and m.status <> 'suspended') as "memberCount"`,
};

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
    return this.db.tenant((tx) => many(tx, `select ${SELECT[table]} from ${table} ${includeArchived ? '' : 'where archived_at is null'} order by name`));
  }

  async get(table: OrgTable, id: string) {
    const row = await this.db.tenant((tx) => one(tx, `select ${SELECT[table]} from ${table} where id = $1`, [id]));
    if (!row) throw Errors.notFound(RESOURCE[table].replace('_', ' '));
    return row;
  }

  async create(table: OrgTable, input: Row) {
    return this.db.tenant(async (tx) => {
      if (table === 'legal_entities') {
        const { count } = (await one<{ count: number }>(tx, 'select count(*)::int as count from legal_entities where archived_at is null'))!;
        await this.entitlements.requireWithinLimit('max_legal_entities', count, tx);
      }
      if (table === 'departments') await this.checkDepartmentRefs(tx, input as DepartmentInput);
      const cols = COLUMNS[table]!;
      const entries = Object.entries(input).filter(([k, v]) => cols[k] && v !== undefined);
      const names = ['tenant_id', ...entries.map(([k]) => cols[k]!)];
      const values = [requestTenant(), ...entries.map(([, v]) => v)];
      const row = (await one<{ id: string }>(
        tx,
        `insert into ${table} (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
        values,
      ))!;
      await this.audit.record(tx, { action: `${RESOURCE[table]}.created`, resourceType: RESOURCE[table], resourceId: row.id, changes: input });
      await this.outbox.publish(tx, requestTenant(), `org.${RESOURCE[table]}.created`, { id: row.id });
      return one(tx, `select ${SELECT[table]} from ${table} where id = $1`, [row.id]);
    });
  }

  async update(table: OrgTable, id: string, input: Row) {
    return this.db.tenant(async (tx) => {
      const before = await one<Row>(tx, `select ${SELECT[table]} from ${table} where id = $1 for update`, [id]);
      if (!before) throw Errors.notFound(RESOURCE[table].replace('_', ' '));
      if (table === 'departments') await this.checkDepartmentRefs(tx, input as DepartmentInput);
      const cols = COLUMNS[table]!;
      const entries = Object.entries(input).filter(([k, v]) => cols[k] && v !== undefined);
      if (entries.length) {
        await tx.query(`update ${table} set ${entries.map(([k], i) => `${cols[k]} = $${i + 2}`).join(', ')} where id = $1`, [id, ...entries.map(([, v]) => v)]);
      }
      const after = (await one<Row>(tx, `select ${SELECT[table]} from ${table} where id = $1`, [id]))!;
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
      const row = await one<{ archived_at: Date | null }>(tx, `select archived_at from ${table} where id = $1 for update`, [id]);
      if (!row) throw Errors.notFound(RESOURCE[table].replace('_', ' '));
      if (row.archived_at) return;
      if (table === 'departments') {
        const busy = await one<{ n: number }>(
          tx,
          `select (select count(*) from departments where parent_id = $1 and archived_at is null) + (select count(*) from memberships where department_id = $1 and status <> 'suspended') as n`,
          [id],
        );
        if (Number(busy!.n) > 0) throw Errors.conflict('department_in_use', 'Move its members and sub-departments first');
      }
      if (table === 'legal_entities') {
        const { n } = (await one<{ n: number }>(tx, 'select count(*)::int as n from legal_entities where archived_at is null'))!;
        if (n <= 1) throw Errors.conflict('last_legal_entity', 'A workspace needs at least one legal entity');
        const used = await one(tx, `select 1 from memberships where legal_entity_id = $1 and status <> 'suspended' limit 1`, [id]);
        if (used) throw Errors.conflict('legal_entity_in_use', 'Move its members to another legal entity first');
      }
      await tx.query(`update ${table} set archived_at = now() where id = $1`, [id]);
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
    return this.db.tenant(async (tx) =>
      one(
        tx,
        `select (select count(*)::int from legal_entities where archived_at is null) as "legalEntities",
                (select count(*)::int from business_units where archived_at is null) as "businessUnits",
                (select count(*)::int from locations where archived_at is null) as "locations",
                (select count(*)::int from departments where archived_at is null) as "departments",
                (select count(*)::int from memberships where status = 'active') as "activeMembers",
                (select count(*)::int from memberships where status = 'invited') as "pendingInvites",
                (select count(distinct country_code)::int from legal_entities where archived_at is null) as "countries"`,
      ),
    );
  }

  private async checkDepartmentRefs(tx: Tx, input: Partial<DepartmentInput>) {
    if (input.parentId) {
      const p = await one(tx, 'select 1 from departments where id = $1 and archived_at is null', [input.parentId]);
      if (!p) throw Errors.badRequest('invalid_parent', 'Parent department not found');
    }
  }
}

export function requestTenant(): string {
  return requestContext.tenantActor().tenantId;
}

export type { LegalEntityInput };
