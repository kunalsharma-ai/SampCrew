import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  acknowledgementText,
  ASSET_CONDITION_LABEL,
  ASSET_MOVES,
  ASSET_REPORT_LABEL,
  ASSET_STATUS_LABEL,
  type AssetAssignInput,
  type assetAcknowledgeInput,
  type assetCategoryInput,
  type assetCategoryUpdate,
  type AssetCondition,
  type AssetInput,
  type assetListQuery,
  type AssetReport,
  type assetReportQuery,
  type assetReturnInput,
  type AssetStatus,
  type assetStatusInput,
  type assetUpdate,
  DEFAULT_ASSET_CATEGORIES,
  nextAssetCode,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor, type ResourceAttributes } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { ilike, MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { StorageService } from '../../platform/storage/storage.service';
import { storeUpload, type UploadedFile } from '../../platform/storage/uploads';
import type { Cell } from '../../platform/export/tabular';
import { EMPLOYEE_FIELDS, employeeAttrs } from '../employees/employee-attrs';
import { displayName } from '../employees/employee-view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const today = () => new Date().toISOString().slice(0, 10);
const actorMembership = () => {
  const a = requestContext.get()?.actor;
  return a?.kind === 'user' ? a.membershipId : null;
};
const WIDE = new Set(['entity', 'tenant']);
const cond = (c: string | null | undefined) => (c ? ASSET_CONDITION_LABEL[c as AssetCondition] ?? c : null);

/**
 * Company assets: the inventory, who holds what (with the employee's typed acknowledgement as the digital
 * acceptance record), returns, maintenance, write-offs and reports. Inventory work needs the asset permission at
 * entity or workspace scope; assigning and returning also accept department scope over the employee concerned.
 * Every employee sees, and acknowledges, what they hold (assets:view own).
 */
@Injectable()
export class AssetsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ---------------------------------------------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------------------------------------------

  private async wide(tx: TenantTx, perm: string) {
    const s = await this.authz.subject(tx);
    return grantsFor(s, perm).some((g) => WIDE.has(g.scope));
  }

  /** The permission over the whole inventory (entity or workspace scope), or 403. */
  private async requireWide(tx: TenantTx, perm: string) {
    await this.authz.require(perm, undefined, tx);
    if (!(await this.wide(tx, perm))) throw Errors.forbidden('This needs the asset permission for the whole organisation, not only a department');
  }

  private async employee(tx: TenantTx, id: string) {
    const e = await tx.collection('employees').findOne({ id });
    if (!e) throw Errors.notFound('Employee');
    const attrs: ResourceAttributes = employeeAttrs({ id: e.id, membershipId: e.membership_id ?? null, legalEntityId: e.current_legal_entity_id ?? null, departmentId: e.current_department_id ?? null, locationId: e.current_location_id ?? null });
    return { e, attrs };
  }

  private async covers(tx: TenantTx, perm: string, attrs: ResourceAttributes) {
    const s = await this.authz.subject(tx);
    return grantsFor(s, perm).some((g) => grantCovers(s, g, attrs));
  }

  /** Requires `perm` over the asset: the whole inventory, or the employee who holds it. */
  private async requireAsset(tx: TenantTx, a: Doc, perm: string) {
    if (await this.wide(tx, perm)) return;
    const holder = a.current_assignment_id ? await tx.collection('asset_assignments').findOne({ id: a.current_assignment_id }) : undefined;
    if (holder) {
      const { attrs } = await this.employee(tx, holder.employee_id);
      if (await this.covers(tx, perm, attrs)) return;
    }
    await this.authz.require(perm, undefined, tx);
    throw Errors.notFound('Asset');
  }

  private async load(tx: TenantTx, id: string, perm = 'assets:view') {
    const a = await tx.collection('assets').findOne({ id });
    if (!a) throw Errors.notFound('Asset');
    await this.requireAsset(tx, a, 'assets:view');
    if (perm !== 'assets:view') await this.requireAsset(tx, a, perm);
    return a;
  }

  private async event(tx: TenantTx, assetId: string, kind: string, extra: { assignmentId?: string | null; from?: string | null; to?: string | null; note?: string | null; vendor?: string | null; cost?: string | null } = {}) {
    await tx.collection('asset_events').insert({
      asset_id: assetId, assignment_id: extra.assignmentId ?? null, kind, from_status: extra.from ?? null, to_status: extra.to ?? null, note: extra.note ?? null,
      vendor: extra.vendor ?? null, cost: extra.cost ?? null, actor_membership_id: actorMembership(),
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Categories
  // ---------------------------------------------------------------------------------------------------------

  /** The default categories, added the first time a workspace opens assets. */
  private async ensureCategories(tx: TenantTx) {
    if (await tx.collection('asset_categories').exists({})) return;
    await tx.collection('asset_categories').insertMany(DEFAULT_ASSET_CATEGORIES.map((c) => ({ code: c.code, name: c.name, is_default: true })));
  }

  async categories() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('assets:view', undefined, tx);
      await this.ensureCategories(tx);
      const rows = await tx.collection('asset_categories').find({}, { sort: { archived_at: 1, name: 1 } });
      const counts = new Map((await tx.collection('assets').aggregate<{ _id: string; n: number }>([{ $group: { _id: '$category_id', n: { $sum: 1 } } }])).map((x) => [x._id, x.n]));
      return rows.map((c) => ({ id: c.id as string, name: c.name as string, code: c.code as string, description: c.description ?? null, isDefault: !!c.is_default, archived: !!c.archived_at, assetCount: counts.get(c.id) ?? 0 }));
    });
  }

  async createCategory(input: z.infer<typeof assetCategoryInput>) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('assets:manage', undefined, tx);
      await this.ensureCategories(tx);
      if (await tx.collection('asset_categories').exists({ code: input.code })) throw Errors.conflict('category_code_taken', `The code ${input.code} is already used by another category`);
      if (await tx.collection('asset_categories').exists({ name: { $regex: `^${input.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } })) throw Errors.conflict('category_exists', 'A category with this name already exists');
      const row = await tx.collection('asset_categories').insert({ name: input.name, code: input.code, description: input.description ?? null });
      await this.audit.record(tx, { action: 'asset.category_created', resourceType: 'asset_category', resourceId: row.id, changes: input });
      return { id: row.id as string };
    });
  }

  async updateCategory(id: string, input: z.infer<typeof assetCategoryUpdate>) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('assets:manage', undefined, tx);
      const before = await tx.collection('asset_categories').findOne({ id });
      if (!before) throw Errors.notFound('Category');
      if (input.code && input.code !== before.code && (await tx.collection('asset_categories').exists({ code: input.code }))) throw Errors.conflict('category_code_taken', `The code ${input.code} is already used by another category`);
      const set: Doc = {};
      if (input.name) set.name = input.name;
      if (input.code) set.code = input.code;
      if (input.description !== undefined) set.description = input.description ?? null;
      if (input.archived !== undefined) set.archived_at = input.archived ? before.archived_at ?? new Date() : null;
      await tx.collection('asset_categories').updateOne({ id }, { $set: set });
      await this.audit.record(tx, { action: input.archived ? 'asset.category_archived' : 'asset.category_updated', resourceType: 'asset_category', resourceId: id, changes: { before: { name: before.name, code: before.code, archived: !!before.archived_at }, after: input } });
      return { id };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------------------------------------------

  private async nextCode(tx: TenantTx, categoryId: string) {
    const cat = await tx.collection('asset_categories').findOne({ id: categoryId });
    const codes = await tx.collection('assets').distinct<string>('asset_code', { asset_code: { $regex: `^${String(cat!.code).toLowerCase()}-` } });
    return nextAssetCode(cat!.code, codes.map((c) => c.toUpperCase()));
  }

  async create(input: AssetInput) {
    return this.db.tenant(async (tx) => {
      await this.requireWide(tx, 'assets:create');
      await this.ensureCategories(tx);
      const cat = await tx.collection('asset_categories').findOne({ id: input.categoryId, archived_at: null });
      if (!cat) throw Errors.validation([{ path: 'categoryId', message: 'Choose a category' }]);
      const code = input.assetCode ?? (await this.nextCode(tx, cat.id));
      if (await tx.collection('assets').exists({ asset_code: code })) throw Errors.validation([{ path: 'assetCode', message: `The asset ID ${code} is already used` }]);
      if (input.serialNumber && (await tx.collection('assets').exists({ serial_number: input.serialNumber, category_id: cat.id }))) {
        throw Errors.validation([{ path: 'serialNumber', message: 'Another asset in this category has this serial number' }]);
      }
      const tenant = await tx.collection('tenants').findOne({});
      const row = await tx.collection('assets').insert({
        asset_code: code, name: input.name, category_id: cat.id, brand: input.brand ?? null, model: input.model ?? null, serial_number: input.serialNumber ?? null,
        purchase_date: input.purchaseDate ?? null, purchase_price: input.purchasePrice ?? null, currency: input.purchasePrice ? input.currency ?? tenant?.currency ?? null : null,
        vendor: input.vendor ?? null, warranty_expiry: input.warrantyExpiry ?? null, condition: input.condition, status: 'available', location: input.location ?? null,
        description: input.description ?? null, remarks: input.remarks ?? null, created_by_membership_id: actorMembership(),
      });
      await this.event(tx, row.id, 'registered', { to: 'available', note: `${cat.name}${input.purchaseDate ? `, bought ${input.purchaseDate}` : ''}`, vendor: input.vendor ?? null, cost: input.purchasePrice ?? null });
      await this.audit.record(tx, { action: 'asset.registered', resourceType: 'asset', resourceId: row.id, changes: { assetCode: code, name: input.name, categoryId: cat.id, serialNumber: input.serialNumber ?? null } });
      return this.view(tx, row.id);
    });
  }

  async update(id: string, input: z.infer<typeof assetUpdate>) {
    return this.db.tenant(async (tx) => {
      const a = await this.load(tx, id);
      await this.requireWide(tx, 'assets:edit');
      if (a.status === 'retired') throw Errors.conflict('asset_retired', 'A retired asset can no longer change');
      const set: Doc = {};
      const map: Record<string, string> = { name: 'name', assetCode: 'asset_code', categoryId: 'category_id', brand: 'brand', model: 'model', serialNumber: 'serial_number', purchaseDate: 'purchase_date', purchasePrice: 'purchase_price', currency: 'currency', vendor: 'vendor', warrantyExpiry: 'warranty_expiry', condition: 'condition', location: 'location', description: 'description', remarks: 'remarks' };
      for (const [k, col] of Object.entries(map)) if ((input as Doc)[k] !== undefined) set[col] = (input as Doc)[k];
      if (set.asset_code && set.asset_code.toLowerCase() !== String(a.asset_code).toLowerCase() && (await tx.collection('assets').exists({ asset_code: set.asset_code }))) throw Errors.validation([{ path: 'assetCode', message: `The asset ID ${set.asset_code} is already used` }]);
      if (set.category_id && !(await tx.collection('asset_categories').exists({ id: set.category_id, archived_at: null }))) throw Errors.validation([{ path: 'categoryId', message: 'Choose a category' }]);
      const purchase = set.purchase_date !== undefined ? set.purchase_date : a.purchase_date;
      const warranty = set.warranty_expiry !== undefined ? set.warranty_expiry : a.warranty_expiry;
      if (purchase && warranty && warranty < purchase) throw Errors.validation([{ path: 'warrantyExpiry', message: 'The warranty ends before the purchase date' }]);
      await tx.collection('assets').updateOne({ id }, { $set: set });
      const changed = Object.keys(set).filter((k) => JSON.stringify(set[k] ?? null) !== JSON.stringify(a[k] ?? null));
      if (changed.length) {
        await this.event(tx, id, 'updated', { note: changed.map((k) => k.replace(/_/g, ' ')).join(', ') });
        await this.audit.record(tx, { action: 'asset.updated', resourceType: 'asset', resourceId: id, changes: Object.fromEntries(changed.map((k) => [k, { from: a[k] ?? null, to: set[k] ?? null }])) });
      }
      return this.view(tx, id);
    });
  }

  async remove(id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.load(tx, id);
      await this.requireWide(tx, 'assets:delete');
      if (await tx.collection('asset_assignments').exists({ asset_id: id })) throw Errors.conflict('asset_has_history', 'This asset has been assigned before, so it is kept for its history. Retire it instead.');
      await tx.collection('asset_files').delete({ asset_id: id });
      await tx.collection('asset_events').delete({ asset_id: id });
      await tx.collection('custom_field_values').delete({ entity: 'asset', record_id: id });
      await tx.collection('assets').deleteOne({ id });
      await this.audit.record(tx, { action: 'asset.deleted', resourceType: 'asset', resourceId: id, changes: { assetCode: a.asset_code, name: a.name } });
    });
  }

  async list(q: z.infer<typeof assetListQuery>) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('assets:view', undefined, tx);
      await this.ensureCategories(tx);
      const filter: Doc = {};
      if (!(await this.wide(tx, 'assets:view'))) {
        // Narrow scope: only assets held by people in scope.
        const scope = await this.authz.filter('assets:view', EMPLOYEE_FIELDS, tx);
        const ids = (await tx.collection('employees').find(scope, { projection: { _id: 1 } })).map((e) => e.id);
        const held = await tx.collection('asset_assignments').find({ employee_id: { $in: ids }, status: 'active' }, { projection: { asset_id: 1 } });
        filter.id = { $in: held.map((h) => h.asset_id) };
      }
      if (q.status) filter.status = q.status;
      if (q.categoryId) filter.category_id = q.categoryId;
      if (q.employeeId) {
        const held = await tx.collection('asset_assignments').find({ employee_id: q.employeeId, status: 'active' }, { projection: { asset_id: 1 } });
        const ids = held.map((h) => h.asset_id);
        filter.id = filter.id ? { $in: ids.filter((x) => (filter.id.$in as string[]).includes(x)) } : { $in: ids };
      }
      if (q.q) filter.$or = [{ name: ilike(q.q) }, { asset_code: ilike(q.q.toLowerCase()) }, { serial_number: ilike(q.q) }, { brand: ilike(q.q) }, { model: ilike(q.q) }];
      const rows = await tx.collection('assets').find(filter, { sort: { asset_code: 1 }, limit: q.limit });
      const assignments = new Map((await tx.collection('asset_assignments').find({ id: { $in: rows.map((r) => r.current_assignment_id).filter(Boolean) } })).map((x) => [x.id as string, x]));
      const employees = new Map((await tx.collection('employees').find({ id: { $in: [...assignments.values()].map((x) => x.employee_id) } })).map((e) => [e.id as string, e]));
      const cats = new Map((await tx.collection('asset_categories').find({})).map((c) => [c.id as string, c.name as string]));
      const counts = await tx.collection('assets').aggregate<{ _id: string; n: number }>([{ $match: filter.id ? { id: filter.id } : {} }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
      return {
        items: rows.map((r) => {
          const as = r.current_assignment_id ? assignments.get(r.current_assignment_id) : undefined;
          const e = as ? employees.get(as.employee_id) : undefined;
          return {
            id: r.id as string, assetCode: String(r.asset_code).toUpperCase(), name: r.name as string, category: cats.get(r.category_id) ?? null, categoryId: r.category_id as string,
            brand: r.brand ?? null, model: r.model ?? null, serialNumber: r.serial_number ?? null, status: r.status as string, condition: r.condition as string, location: r.location ?? null,
            warrantyExpiry: r.warranty_expiry ?? null, warrantyExpired: !!r.warranty_expiry && r.warranty_expiry < today(),
            holder: as && e ? { employeeId: e.id as string, name: displayName(e as never), code: e.employee_code ?? null, since: as.assigned_on, acknowledged: !!as.acknowledged_at, expectedReturnOn: as.expected_return_on ?? null } : null,
          };
        }),
        counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
        canCreate: await this.wide(tx, 'assets:create'),
        canExport: (await this.authz.subject(tx)).grants.some((g) => g.permission === 'assets:export'),
      };
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      await this.load(tx, id);
      return this.view(tx, id);
    });
  }

  private async view(tx: TenantTx, id: string) {
    const a = (await tx.collection('assets').findOne({ id }))!;
    const cat = await tx.collection('asset_categories').findOne({ id: a.category_id });
    const assignments = await tx.collection('asset_assignments').find({ asset_id: id }, { sort: { assigned_on: -1, created_at: -1 } });
    const employees = new Map((await tx.collection('employees').find({ id: { $in: assignments.map((x) => x.employee_id) } })).map((e) => [e.id as string, e]));
    const events = await tx.collection('asset_events').find({ asset_id: id }, { sort: { created_at: -1 } });
    const files = await tx.collection('asset_files').find({ asset_id: id, removed_at: null }, { sort: { created_at: 1 } });
    const names = await membershipUserNames(tx, [...assignments.flatMap((x) => [x.assigned_by_membership_id, x.received_by_membership_id]), ...events.map((x) => x.actor_membership_id), ...files.map((f) => f.uploaded_by_membership_id)]);
    const wideEdit = await this.wide(tx, 'assets:edit');
    const current = assignments.find((x) => x.status === 'active');
    const holderAttrs = current ? (await this.employee(tx, current.employee_id)).attrs : null;
    const canEditHolder = holderAttrs ? await this.covers(tx, 'assets:edit', holderAttrs) : false;
    return {
      id: a.id as string, assetCode: String(a.asset_code).toUpperCase(), name: a.name as string, categoryId: a.category_id as string, category: cat?.name ?? null,
      brand: a.brand ?? null, model: a.model ?? null, serialNumber: a.serial_number ?? null, purchaseDate: a.purchase_date ?? null, purchasePrice: a.purchase_price ?? null,
      currency: a.currency ?? null, vendor: a.vendor ?? null, warrantyExpiry: a.warranty_expiry ?? null, condition: a.condition as string, status: a.status as string,
      location: a.location ?? null, description: a.description ?? null, remarks: a.remarks ?? null, createdAt: a.created_at,
      assignments: assignments.map((x) => {
        const e = employees.get(x.employee_id);
        return {
          id: x.id as string, employeeId: x.employee_id as string, employeeName: e ? displayName(e as never) : null, employeeCode: e?.employee_code ?? null,
          department: x.department_name ?? null, designation: x.designation_name ?? null, status: x.status as string, assignedOn: x.assigned_on, expectedReturnOn: x.expected_return_on ?? null,
          conditionAtAssignment: x.condition_at_assignment, assignedBy: names.get(x.assigned_by_membership_id) ?? null, notes: x.notes ?? null,
          requiresAcknowledgement: !!x.requires_acknowledgement,
          acknowledgement: x.acknowledged_at ? { at: x.acknowledged_at, name: x.acknowledged_name, text: x.acknowledged_text, sha256: x.acknowledged_text_sha256, ip: x.acknowledged_ip ?? null, comment: x.acknowledged_comment ?? null } : null,
          returnedOn: x.returned_on ?? null, conditionAtReturn: x.condition_at_return ?? null, returnNotes: x.return_notes ?? null, receivedBy: names.get(x.received_by_membership_id) ?? null,
        };
      }),
      history: events.map((x) => ({ id: x.id as string, kind: x.kind as string, from: x.from_status ?? null, to: x.to_status ?? null, note: x.note ?? null, vendor: x.vendor ?? null, cost: x.cost ?? null, by: names.get(x.actor_membership_id) ?? null, at: x.created_at })),
      files: files.map((f) => ({ id: f.id as string, title: f.title as string, fileName: f.file_name as string, sizeBytes: f.size_bytes as number, uploadedBy: names.get(f.uploaded_by_membership_id) ?? null, createdAt: f.created_at })),
      can: {
        edit: wideEdit && a.status !== 'retired',
        assign: a.status === 'available' && (await this.authz.subject(tx)).grants.some((g) => g.permission === 'assets:create'),
        return: !!current && (wideEdit || canEditHolder),
        moves: (ASSET_MOVES[a.status as AssetStatus] ?? []).filter(() => wideEdit),
        writeOff: await this.wide(tx, 'assets:approve'),
        delete: (await this.wide(tx, 'assets:delete')) && !assignments.length,
      },
    };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Assignment, acknowledgement, return
  // ---------------------------------------------------------------------------------------------------------

  async assign(id: string, input: AssetAssignInput) {
    return this.db.tenant(async (tx) => {
      const a = await tx.collection('assets').findOne({ id });
      if (!a) throw Errors.notFound('Asset');
      const { e, attrs } = await this.employee(tx, input.employeeId);
      await this.authz.require('assets:create', attrs, tx);
      if (a.status !== 'available') throw Errors.conflict('asset_not_available', `${a.name} is ${ASSET_STATUS_LABEL[a.status as AssetStatus].toLowerCase()}, so it cannot be assigned`);
      if (e.status === 'exited') throw Errors.badRequest('employee_exited', 'This person has left the organisation');
      if (input.assignedOn > today()) throw Errors.validation([{ path: 'assignedOn', message: 'The assignment date cannot be in the future' }]);
      return this.assignIn(tx, a, e, input);
    });
  }

  /**
   * Hands assets to someone being added (the hire form or the bulk import), inside the hire's own transaction, so a
   * failed hire leaves the assets available. They are asked to acknowledge each one.
   */
  async assignAtHire(tx: TenantTx, employeeId: string, assetIds: string[], note: string) {
    if (!assetIds.length) return;
    if (!(await this.entitlements.current(tx)).features.has('asset_management')) throw Errors.featureNotInPlan('Asset management');
    const { e, attrs } = await this.employee(tx, employeeId);
    await this.authz.require('assets:create', attrs, tx);
    for (const id of [...new Set(assetIds)]) {
      const a = await tx.collection('assets').findOne({ id });
      if (!a) throw Errors.notFound('Asset');
      if (a.status !== 'available') throw Errors.conflict('asset_not_available', `${a.name} (${String(a.asset_code).toUpperCase()}) is no longer available`);
      await this.assignIn(tx, a, e, { employeeId, assignedOn: today(), condition: (a.condition ?? 'good') as AssetAssignInput['condition'], notes: note, requireAcknowledgement: true });
    }
  }

  /** Assigns an available asset (also used by the existing-employee form and the bulk import). */
  async assignIn(tx: TenantTx, a: Doc, e: Doc, input: AssetAssignInput) {
    const dept = e.current_department_id ? await tx.collection('departments').findOne({ id: e.current_department_id }, { projection: { name: 1 } }) : undefined;
    const desig = e.current_designation_id ? await tx.collection('designations').findOne({ id: e.current_designation_id }, { projection: { name: 1 } }) : undefined;
    const as = await tx.collection('asset_assignments').insert({
      asset_id: a.id, employee_id: e.id, department_id: e.current_department_id ?? null, department_name: dept?.name ?? null, designation_name: desig?.name ?? null,
      assigned_on: input.assignedOn, expected_return_on: input.expectedReturnOn ?? null, condition_at_assignment: input.condition, assigned_by_membership_id: actorMembership(),
      notes: input.notes ?? null, requires_acknowledgement: input.requireAcknowledgement, status: 'active',
    });
    await tx.collection('assets').updateOne({ id: a.id }, { $set: { status: 'assigned', current_assignment_id: as.id, condition: input.condition } });
    await this.event(tx, a.id, 'assigned', { assignmentId: as.id, from: a.status, to: 'assigned', note: `To ${displayName(e as never)}${e.employee_code ? ` (${e.employee_code})` : ''} on ${input.assignedOn}, ${cond(input.condition)?.toLowerCase()} condition` });
    await this.audit.record(tx, { action: 'asset.assigned', resourceType: 'asset', resourceId: a.id, changes: { employeeId: e.id, assignedOn: input.assignedOn, condition: input.condition, expectedReturnOn: input.expectedReturnOn ?? null } });
    if (e.membership_id) {
      await this.notifications.notify(tx, {
        membershipIds: [e.membership_id], kind: 'asset.assigned', title: `${a.name} (${String(a.asset_code).toUpperCase()}) has been assigned to you`,
        body: input.requireAcknowledgement ? 'Check it and acknowledge that you received it.' : undefined, link: '/assets/mine', email: input.requireAcknowledgement,
      });
    }
    return this.view(tx, a.id);
  }

  async returnAsset(id: string, input: z.infer<typeof assetReturnInput>) {
    return this.db.tenant(async (tx) => {
      const a = await this.load(tx, id, 'assets:edit');
      const as = a.current_assignment_id ? await tx.collection('asset_assignments').findOne({ id: a.current_assignment_id, status: 'active' }) : undefined;
      if (!as) throw Errors.conflict('asset_not_assigned', 'This asset is not assigned to anyone');
      if (input.returnedOn < as.assigned_on) throw Errors.validation([{ path: 'returnedOn', message: `It was assigned on ${as.assigned_on}` }]);
      if (input.returnedOn > today()) throw Errors.validation([{ path: 'returnedOn', message: 'The return date cannot be in the future' }]);
      const next = input.condition === 'damaged' && input.nextStatus === 'available' ? 'damaged' : input.nextStatus;
      if (next === 'damaged' && !(await this.wide(tx, 'assets:approve')) && input.nextStatus === 'damaged') throw Errors.forbidden('Recording an asset as damaged needs the asset Approve permission');
      await tx.collection('asset_assignments').updateOne({ id: as.id }, { $set: { status: 'returned', returned_on: input.returnedOn, condition_at_return: input.condition, return_notes: input.notes ?? null, received_by_membership_id: actorMembership() } });
      await tx.collection('assets').updateOne({ id }, { $set: { status: next, current_assignment_id: null, condition: input.condition } });
      const e = await tx.collection('employees').findOne({ id: as.employee_id });
      await this.event(tx, id, 'returned', { assignmentId: as.id, from: 'assigned', to: next, note: `From ${e ? displayName(e as never) : 'employee'} on ${input.returnedOn}, ${cond(input.condition)?.toLowerCase()} condition${input.notes ? `. ${input.notes}` : ''}` });
      if (next === 'under_maintenance') await this.event(tx, id, 'maintenance_started', { from: 'assigned', to: 'under_maintenance', note: 'Sent for repair on return' });
      await this.audit.record(tx, { action: 'asset.returned', resourceType: 'asset', resourceId: id, changes: { employeeId: as.employee_id, returnedOn: input.returnedOn, condition: input.condition, nextStatus: next } });
      if (e?.membership_id) await this.notifications.notify(tx, { membershipIds: [e.membership_id], kind: 'asset.returned', title: `Return of ${a.name} (${String(a.asset_code).toUpperCase()}) recorded`, body: `Received on ${input.returnedOn}.`, link: '/assets/mine' });
      return this.view(tx, id);
    });
  }

  async setStatus(id: string, input: z.infer<typeof assetStatusInput>) {
    return this.db.tenant(async (tx) => {
      const a = await this.load(tx, id);
      const from = a.status as AssetStatus;
      if (!ASSET_MOVES[from].includes(input.status)) throw Errors.conflict('invalid_status_change', `An asset that is ${ASSET_STATUS_LABEL[from].toLowerCase()} cannot become ${ASSET_STATUS_LABEL[input.status].toLowerCase()}`);
      const writeOff = input.status === 'lost' || input.status === 'damaged';
      if (writeOff) await this.requireWide(tx, 'assets:approve');
      else if (input.status === 'retired') await this.requireWide(tx, 'assets:delete');
      else await this.requireWide(tx, 'assets:edit');
      // Lost or damaged while assigned: the assignment ends as it is.
      if (a.current_assignment_id) {
        await tx.collection('asset_assignments').updateOne({ id: a.current_assignment_id, status: 'active' }, { $set: { status: 'returned', returned_on: today(), condition_at_return: input.status === 'damaged' ? 'damaged' : null, return_notes: `${ASSET_STATUS_LABEL[input.status]}: ${input.note}`, received_by_membership_id: actorMembership() } });
      }
      await tx.collection('assets').updateOne({ id }, { $set: { status: input.status, current_assignment_id: null, ...(input.status === 'damaged' ? { condition: 'damaged' } : {}) } });
      const kind = input.status === 'under_maintenance' ? 'maintenance_started' : from === 'under_maintenance' && input.status === 'available' ? 'maintenance_finished' : input.status === 'retired' ? 'retired' : writeOff ? `written_off_${input.status}` : 'status_changed';
      await this.event(tx, id, kind, { assignmentId: a.current_assignment_id ?? null, from, to: input.status, note: input.note, vendor: input.vendor ?? null, cost: input.cost ?? null });
      await this.audit.record(tx, { action: `asset.${kind}`, resourceType: 'asset', resourceId: id, changes: { status: { from, to: input.status }, note: input.note, cost: input.cost ?? null } });
      return this.view(tx, id);
    });
  }

  async mine() {
    return this.db.tenant(async (tx) => {
      const actor = requestContext.tenantActor();
      const m = await tx.collection('memberships').findOne({ id: actor.membershipId });
      if (!m?.employee_id) return { employeeName: null, items: [] };
      const e = (await tx.collection('employees').findOne({ id: m.employee_id }))!;
      const assignments = await tx.collection('asset_assignments').find({ employee_id: e.id }, { sort: { status: 1, assigned_on: -1 } });
      const assets = new Map((await tx.collection('assets').find({ id: { $in: assignments.map((x) => x.asset_id) } })).map((a) => [a.id as string, a]));
      const cats = new Map((await tx.collection('asset_categories').find({})).map((c) => [c.id as string, c.name as string]));
      return {
        employeeName: displayName(e as never),
        items: assignments.map((x) => {
          const a = assets.get(x.asset_id)!;
          return {
            assignmentId: x.id as string, assetId: a.id as string, assetCode: String(a.asset_code).toUpperCase(), name: a.name as string, category: cats.get(a.category_id) ?? null,
            brand: a.brand ?? null, model: a.model ?? null, serialNumber: a.serial_number ?? null, status: x.status as string, assignedOn: x.assigned_on, expectedReturnOn: x.expected_return_on ?? null,
            condition: x.condition_at_assignment as string, notes: x.notes ?? null, returnedOn: x.returned_on ?? null,
            needsAcknowledgement: x.status === 'active' && !!x.requires_acknowledgement && !x.acknowledged_at,
            acknowledgedAt: x.acknowledged_at ?? null,
            acceptanceText: acknowledgementText({ assetCode: String(a.asset_code).toUpperCase(), name: a.name, serialNumber: a.serial_number, condition: (cond(x.condition_at_assignment) ?? '').toLowerCase(), assignedOn: x.assigned_on, employeeName: displayName(e as never) }),
          };
        }),
      };
    });
  }

  async acknowledge(assignmentId: string, input: z.infer<typeof assetAcknowledgeInput>, client: { ip: string | null; userAgent: string | null }) {
    return this.db.tenant(async (tx) => {
      const actor = requestContext.tenantActor();
      const m = await tx.collection('memberships').findOne({ id: actor.membershipId });
      const x = await tx.collection('asset_assignments').findOne({ id: assignmentId });
      // Only the person who holds it can acknowledge it.
      if (!x || !m?.employee_id || x.employee_id !== m.employee_id) throw Errors.notFound('Assignment');
      if (x.status !== 'active') throw Errors.conflict('assignment_closed', 'This asset has been returned');
      if (x.acknowledged_at) throw Errors.conflict('already_acknowledged', 'You have already acknowledged this asset');
      const e = (await tx.collection('employees').findOne({ id: x.employee_id }))!;
      const a = (await tx.collection('assets').findOne({ id: x.asset_id }))!;
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const legal = `${e.first_name} ${e.last_name ?? ''}`;
      if (norm(input.fullName) !== norm(displayName(e as never)) && norm(input.fullName) !== norm(legal)) throw Errors.validation([{ path: 'fullName', message: `Type your name as it is on your profile: ${displayName(e as never)}` }]);
      const text = acknowledgementText({ assetCode: String(a.asset_code).toUpperCase(), name: a.name, serialNumber: a.serial_number, condition: (cond(x.condition_at_assignment) ?? '').toLowerCase(), assignedOn: x.assigned_on, employeeName: displayName(e as never) });
      const sha = createHash('sha256').update(`${text}\n${input.fullName}\n${new Date().toISOString().slice(0, 10)}`).digest('hex');
      await tx.collection('asset_assignments').updateOne({ id: x.id }, { $set: {
        acknowledged_at: new Date(), acknowledged_name: input.fullName, acknowledged_text: text, acknowledged_text_sha256: sha, acknowledged_ip: client.ip, acknowledged_user_agent: client.userAgent?.slice(0, 300) ?? null, acknowledged_comment: input.comment ?? null,
      } });
      await this.event(tx, a.id, 'acknowledged', { assignmentId: x.id, note: `By ${input.fullName}${input.comment ? `: ${input.comment}` : ''}` });
      await this.audit.record(tx, { action: 'asset.acknowledged', resourceType: 'asset', resourceId: a.id, metadata: { assignmentId: x.id, sha256: sha } });
      if (x.assigned_by_membership_id && x.assigned_by_membership_id !== actor.membershipId) {
        await this.notifications.notify(tx, { membershipIds: [x.assigned_by_membership_id], kind: 'asset.acknowledged', title: `${displayName(e as never)} acknowledged ${a.name} (${String(a.asset_code).toUpperCase()})`, body: input.comment ?? undefined, link: `/assets/${a.id}` });
      }
      return { ok: true, acknowledgedAt: new Date().toISOString(), sha256: sha };
    });
  }

  async forEmployee(employeeId: string) {
    return this.db.tenant(async (tx) => {
      const { attrs } = await this.employee(tx, employeeId);
      await this.authz.require('assets:view', attrs, tx);
      const assignments = await tx.collection('asset_assignments').find({ employee_id: employeeId }, { sort: { status: 1, assigned_on: -1 } });
      const assets = new Map((await tx.collection('assets').find({ id: { $in: assignments.map((x) => x.asset_id) } })).map((a) => [a.id as string, a]));
      return assignments.map((x) => {
        const a = assets.get(x.asset_id)!;
        return { assignmentId: x.id as string, assetId: a.id as string, assetCode: String(a.asset_code).toUpperCase(), name: a.name as string, status: x.status as string, assignedOn: x.assigned_on, returnedOn: x.returned_on ?? null, acknowledged: !!x.acknowledged_at, requiresAcknowledgement: !!x.requires_acknowledgement };
      });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------------------------------------

  async upload(id: string, title: string, file: UploadedFile | undefined) {
    const actor = requestContext.tenantActor();
    await this.db.tenant(async (tx) => { await this.load(tx, id); await this.requireWide(tx, 'assets:edit'); });
    const stored = await storeUpload(this.storage, actor.tenantId, file);
    return this.db.tenant(async (tx) => {
      const f = await tx.collection('asset_files').insert({ asset_id: id, title, uploaded_by_membership_id: actor.membershipId, ...stored });
      await this.event(tx, id, 'file_added', { note: title });
      await this.audit.record(tx, { action: 'asset.file_uploaded', resourceType: 'asset', resourceId: id, metadata: { fileId: f.id, sha256: stored.sha256 } });
      return this.view(tx, id);
    });
  }

  async removeFile(fileId: string) {
    return this.db.tenant(async (tx) => {
      const f = await tx.collection('asset_files').findOne({ id: fileId, removed_at: null });
      if (!f) throw Errors.notFound('File');
      await this.load(tx, f.asset_id);
      await this.requireWide(tx, 'assets:edit');
      await tx.collection('asset_files').updateOne({ id: fileId }, { $set: { removed_at: new Date() } });
      await this.event(tx, f.asset_id, 'file_removed', { note: f.title });
      await this.audit.record(tx, { action: 'asset.file_removed', resourceType: 'asset', resourceId: f.asset_id, metadata: { fileId } });
      return this.view(tx, f.asset_id);
    });
  }

  async fileLink(fileId: string) {
    return this.db.tenant(async (tx) => {
      const f = await tx.collection('asset_files').findOne({ id: fileId, removed_at: null });
      if (!f) throw Errors.notFound('File');
      await this.load(tx, f.asset_id);
      return this.storage.sign(fileId, 300, 'assets');
    });
  }

  async openFile(fileId: string, exp: number, sig: string) {
    if (!this.storage.verify(fileId, exp, sig, 'assets')) throw Errors.notFound('File');
    const f = await this.db.platform((tx) => tx.collection('asset_files').findOne({ id: fileId, removed_at: null }));
    if (!f) throw Errors.notFound('File');
    return { ...(await this.storage.open(f.storage_key)), fileName: f.file_name as string, contentType: f.content_type as string };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------------------------------------

  async report(kind: AssetReport, q: z.infer<typeof assetReportQuery>): Promise<{ title: string; subtitle: string; rows: Cell[][] }> {
    return this.db.tenant(async (tx) => {
      await this.authz.require('assets:export', undefined, tx);
      const wide = await this.wide(tx, 'assets:export');
      const scope = wide ? null : new Set((await tx.collection('employees').find(await this.authz.filter('assets:export', EMPLOYEE_FIELDS, tx), { projection: { _id: 1 } })).map((e) => e.id as string));
      const inScope = (employeeId: string | null | undefined) => !scope || (!!employeeId && scope.has(employeeId));
      if (!wide && !['employee', 'department', 'assigned', 'returned'].includes(kind)) throw Errors.forbidden('This report covers the whole inventory, so it needs the asset Export permission for the whole organisation');
      const catFilter = q.categoryId ? { category_id: q.categoryId } : {};
      const assets = await tx.collection('assets').find(catFilter, { sort: { asset_code: 1 } });
      const byId = new Map(assets.map((a) => [a.id as string, a]));
      const cats = new Map((await tx.collection('asset_categories').find({})).map((c) => [c.id as string, c.name as string]));
      const inRange = (d: string | null | undefined) => !!d && (!q.from || d >= q.from) && (!q.to || d <= q.to);
      const assignments = await tx.collection('asset_assignments').find({ asset_id: { $in: [...byId.keys()] } }, { sort: { assigned_on: -1 } });
      const employees = new Map((await tx.collection('employees').find({ id: { $in: assignments.map((x) => x.employee_id) } })).map((e) => [e.id as string, e]));
      const depts = new Map((await tx.collection('departments').find({})).map((d) => [d.id as string, d.name as string]));
      const emp = (id: string) => employees.get(id);
      const code = (a: Doc) => String(a.asset_code).toUpperCase();
      const tenant = await tx.collection('tenants').findOne({});
      const range = q.from || q.to ? `, ${q.from ?? 'start'} to ${q.to ?? 'today'}` : '';
      const subtitle = `${tenant?.name ?? ''}${q.categoryId ? `, ${cats.get(q.categoryId) ?? ''}` : ''}${range}. Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
      let rows: Cell[][];
      const active = assignments.filter((x) => x.status === 'active' && inScope(x.employee_id));
      switch (kind) {
        case 'employee':
          rows = [['Employee', 'Employee ID', 'Department', 'Designation', 'Asset ID', 'Asset', 'Category', 'Serial number', 'Assigned on', 'Expected return', 'Condition', 'Acknowledged']];
          for (const x of [...active].sort((a, b) => (emp(a.employee_id)?.first_name ?? '').localeCompare(emp(b.employee_id)?.first_name ?? ''))) {
            const a = byId.get(x.asset_id)!;
            const e = emp(x.employee_id);
            rows.push([e ? displayName(e as never) : '', e?.employee_code ?? '', x.department_name ?? '', x.designation_name ?? '', code(a), a.name, cats.get(a.category_id) ?? '', a.serial_number ?? '', x.assigned_on, x.expected_return_on ?? '', cond(x.condition_at_assignment), x.acknowledged_at ? new Date(x.acknowledged_at).toISOString().slice(0, 10) : x.requires_acknowledgement ? 'Not yet' : 'Not needed']);
          }
          break;
        case 'department': {
          rows = [['Department', 'Employees holding assets', 'Assets assigned', 'Not acknowledged', 'Categories']];
          const groups = new Map<string, Doc[]>();
          for (const x of active) {
            const e = emp(x.employee_id);
            const d = (e?.current_department_id && depts.get(e.current_department_id)) || x.department_name || 'No department';
            groups.set(d, [...(groups.get(d) ?? []), x]);
          }
          for (const [d, xs] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            const catCounts = new Map<string, number>();
            for (const x of xs) { const c = cats.get(byId.get(x.asset_id)!.category_id) ?? 'Other'; catCounts.set(c, (catCounts.get(c) ?? 0) + 1); }
            rows.push([d, new Set(xs.map((x) => x.employee_id)).size, xs.length, xs.filter((x) => x.requires_acknowledgement && !x.acknowledged_at).length, [...catCounts.entries()].map(([c, n]) => `${c} ${n}`).join(', ')]);
          }
          break;
        }
        case 'available':
          rows = [['Asset ID', 'Asset', 'Category', 'Brand', 'Model', 'Serial number', 'Condition', 'Location', 'Warranty until', 'Purchase price']];
          for (const a of assets.filter((x) => x.status === 'available')) rows.push([code(a), a.name, cats.get(a.category_id) ?? '', a.brand ?? '', a.model ?? '', a.serial_number ?? '', cond(a.condition), a.location ?? '', a.warranty_expiry ?? '', a.purchase_price ? `${a.currency ?? ''} ${a.purchase_price}`.trim() : '']);
          break;
        case 'assigned':
          rows = [['Asset ID', 'Asset', 'Category', 'Serial number', 'Held by', 'Employee ID', 'Department', 'Since', 'Expected return', 'Acknowledged']];
          for (const x of active) {
            const a = byId.get(x.asset_id)!;
            const e = emp(x.employee_id);
            rows.push([code(a), a.name, cats.get(a.category_id) ?? '', a.serial_number ?? '', e ? displayName(e as never) : '', e?.employee_code ?? '', x.department_name ?? '', x.assigned_on, x.expected_return_on ?? '', x.acknowledged_at ? 'Yes' : x.requires_acknowledgement ? 'Not yet' : 'Not needed']);
          }
          break;
        case 'returned':
          rows = [['Asset ID', 'Asset', 'Category', 'Returned by', 'Employee ID', 'Assigned on', 'Returned on', 'Condition given', 'Condition returned', 'Notes']];
          for (const x of assignments.filter((y) => y.status === 'returned' && inScope(y.employee_id) && (!q.from && !q.to ? true : inRange(y.returned_on)))) {
            const a = byId.get(x.asset_id)!;
            const e = emp(x.employee_id);
            rows.push([code(a), a.name, cats.get(a.category_id) ?? '', e ? displayName(e as never) : '', e?.employee_code ?? '', x.assigned_on, x.returned_on ?? '', cond(x.condition_at_assignment), cond(x.condition_at_return) ?? '', x.return_notes ?? '']);
          }
          break;
        case 'damaged_lost': {
          rows = [['Asset ID', 'Asset', 'Category', 'Status', 'Since', 'Last held by', 'Reason', 'Purchase price']];
          const events = await tx.collection('asset_events').find({ asset_id: { $in: assets.filter((a) => a.status === 'damaged' || a.status === 'lost').map((a) => a.id) }, to_status: { $in: ['damaged', 'lost'] } }, { sort: { created_at: -1 } });
          for (const a of assets.filter((x) => x.status === 'damaged' || x.status === 'lost')) {
            const ev = events.find((x) => x.asset_id === a.id);
            const last = assignments.find((x) => x.asset_id === a.id);
            const e = last ? emp(last.employee_id) : undefined;
            rows.push([code(a), a.name, cats.get(a.category_id) ?? '', ASSET_STATUS_LABEL[a.status as AssetStatus], ev ? new Date(ev.created_at).toISOString().slice(0, 10) : '', e ? displayName(e as never) : '', ev?.note ?? '', a.purchase_price ? `${a.currency ?? ''} ${a.purchase_price}`.trim() : '']);
          }
          break;
        }
        case 'purchases':
          rows = [['Purchase date', 'Asset ID', 'Asset', 'Category', 'Brand', 'Model', 'Serial number', 'Vendor', 'Price', 'Currency', 'Warranty until', 'Status']];
          for (const a of assets.filter((x) => (!q.from && !q.to) || inRange(x.purchase_date)).sort((x, y) => String(y.purchase_date ?? '').localeCompare(String(x.purchase_date ?? '')))) {
            rows.push([a.purchase_date ?? '', code(a), a.name, cats.get(a.category_id) ?? '', a.brand ?? '', a.model ?? '', a.serial_number ?? '', a.vendor ?? '', a.purchase_price ?? '', a.currency ?? '', a.warranty_expiry ?? '', ASSET_STATUS_LABEL[a.status as AssetStatus]]);
          }
          break;
        case 'maintenance': {
          rows = [['Date', 'Asset ID', 'Asset', 'Event', 'Repairer', 'Cost', 'Note', 'By']];
          const events = await tx.collection('asset_events').find({ asset_id: { $in: [...byId.keys()] }, kind: { $in: ['maintenance_started', 'maintenance_finished'] } }, { sort: { created_at: -1 } });
          const names = await membershipUserNames(tx, events.map((x) => x.actor_membership_id));
          for (const ev of events.filter((x) => (!q.from && !q.to) || inRange(new Date(x.created_at).toISOString().slice(0, 10)))) {
            const a = byId.get(ev.asset_id)!;
            rows.push([new Date(ev.created_at).toISOString().slice(0, 10), code(a), a.name, ev.kind === 'maintenance_started' ? 'Sent for maintenance' : 'Back from maintenance', ev.vendor ?? '', ev.cost ?? '', ev.note ?? '', names.get(ev.actor_membership_id) ?? '']);
          }
          break;
        }
      }
      await this.audit.record(tx, { action: 'asset.report_exported', resourceType: 'asset', metadata: { report: kind, rows: rows.length - 1, filters: q } });
      return { title: ASSET_REPORT_LABEL[kind], subtitle, rows };
    });
  }
}
