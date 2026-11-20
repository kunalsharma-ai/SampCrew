import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  BGV_CHECK_LABEL,
  BGV_SECRET_DETAILS,
  BGV_STATUS_LABEL,
  type BgvAgencyInput,
  type bgvAgencyFindingsInput,
  type BgvCaseInput,
  type bgvCaseUpdateInput,
  type bgvCheckInput,
  type bgvCheckUpdateInput,
  type bgvDecisionInput,
  type bgvListQuery,
  type bgvShareInput,
  type BgvStatus,
  caseProgress,
  maskIdentifier,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, encryptField } from '../../platform/auth/crypto';
import { AuthzService, loadSubject, permissionHolderIds } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor, type ResourceAttributes } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { ilike, MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { StorageService } from '../../platform/storage/storage.service';
import { storeUpload, type UploadedFile } from '../../platform/storage/uploads';
import { EMPLOYEE_FIELDS, employeeAttrs } from '../employees/employee-attrs';
import { displayName } from '../employees/employee-view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const actorMembership = () => {
  const a = requestContext.get()?.actor;
  return a?.kind === 'user' ? a.membershipId : null;
};
const FINAL = new Set(['verified', 'failed', 'cancelled']);

/**
 * Background verification. Every read and change is checked against the case's employee (bgv:* permissions at
 * department, entity or workspace scope); nobody has them by default except the Workspace Owner and HR Admin. Each
 * change is written to the case history and to the hash-chained audit trail. Identifiers (ID, roll and document
 * numbers) are stored encrypted and shown masked to people who may only view.
 */
@Injectable()
export class BgvService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------------------------------------------

  private async employee(tx: TenantTx, employeeId: string) {
    const e = await tx.collection('employees').findOne({ id: employeeId });
    if (!e) throw Errors.notFound('Employee');
    const attrs = employeeAttrs({ id: e.id, membershipId: e.membership_id ?? null, legalEntityId: e.current_legal_entity_id ?? null, departmentId: e.current_department_id ?? null, locationId: e.current_location_id ?? null });
    return { e, attrs };
  }

  private async covers(tx: TenantTx, perm: string, attrs: ResourceAttributes) {
    const s = await this.authz.subject(tx);
    return grantsFor(s, perm).some((g) => grantCovers(s, g, attrs));
  }

  /** Loads a case the member may see, and requires `perm` over its employee. Out of scope reads as not found. */
  private async caseFor(tx: TenantTx, id: string, perm = 'bgv:view') {
    const c = await tx.collection('bgv_cases').findOne({ id });
    if (!c) throw Errors.notFound('Verification case');
    const { e, attrs } = await this.employee(tx, c.employee_id);
    await this.authz.require('bgv:view', attrs, tx);
    if (perm !== 'bgv:view') await this.authz.require(perm, attrs, tx);
    return { c, e, attrs };
  }

  private async event(tx: TenantTx, caseId: string, action: string, extra: { checkId?: string | null; from?: string | null; to?: string | null; note?: string | null; actorLabel?: string } = {}) {
    await tx.collection('bgv_events').insert({
      case_id: caseId, check_id: extra.checkId ?? null, action, from_status: extra.from ?? null, to_status: extra.to ?? null, note: extra.note ?? null,
      actor_membership_id: extra.actorLabel ? null : actorMembership(), actor_label: extra.actorLabel ?? null,
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Agencies
  // ---------------------------------------------------------------------------------------------------------

  private agencyView(a: Doc) {
    return {
      id: a.id as string, name: a.name as string, contactName: a.contact_name ?? null, email: a.email as string, phone: a.phone ?? null, website: a.website ?? null,
      address: a.address ?? null, services: (a.services ?? []) as string[], turnaroundDays: a.turnaround_days ?? null, notes: a.notes ?? null, active: !!a.active, createdAt: a.created_at,
    };
  }

  async agencies() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('bgv:view', undefined, tx);
      const rows = await tx.collection('bgv_agencies').find({}, { sort: { active: -1, name: 1 } });
      const open = await tx.collection('bgv_cases').aggregate<{ _id: string; n: number }>([
        { $match: { agency_id: { $in: rows.map((r) => r.id) }, status: { $nin: ['verified', 'failed', 'cancelled'] } } },
        { $group: { _id: '$agency_id', n: { $sum: 1 } } },
      ]);
      const counts = new Map(open.map((o) => [o._id, o.n]));
      return rows.map((r) => ({ ...this.agencyView(r), openCases: counts.get(r.id) ?? 0 }));
    });
  }

  async createAgency(input: BgvAgencyInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('bgv:manage', undefined, tx);
      if (await tx.collection('bgv_agencies').exists({ name: { $regex: `^${input.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } })) throw Errors.conflict('agency_exists', 'An agency with this name already exists');
      const row = await tx.collection('bgv_agencies').insert({
        name: input.name, contact_name: input.contactName ?? null, email: input.email, phone: input.phone ?? null, website: input.website ?? null, address: input.address ?? null,
        services: input.services, turnaround_days: input.turnaroundDays ?? null, notes: input.notes ?? null, active: input.active, created_by_membership_id: actorMembership(),
      });
      await this.audit.record(tx, { action: 'bgv.agency_created', resourceType: 'bgv_agency', resourceId: row.id, changes: { name: input.name, email: input.email, services: input.services } });
      return this.agencyView(row);
    });
  }

  async updateAgency(id: string, input: BgvAgencyInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('bgv:manage', undefined, tx);
      const before = await tx.collection('bgv_agencies').findOne({ id });
      if (!before) throw Errors.notFound('Agency');
      const set = {
        name: input.name, contact_name: input.contactName ?? null, email: input.email, phone: input.phone ?? null, website: input.website ?? null, address: input.address ?? null,
        services: input.services, turnaround_days: input.turnaroundDays ?? null, notes: input.notes ?? null, active: input.active,
      };
      const after = await tx.collection('bgv_agencies').updateAndGet({ id }, { $set: set });
      await this.audit.record(tx, { action: 'bgv.agency_updated', resourceType: 'bgv_agency', resourceId: id, changes: { name: { from: before.name, to: input.name }, active: { from: before.active, to: input.active } } });
      return this.agencyView(after!);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Cases
  // ---------------------------------------------------------------------------------------------------------

  private splitDetails(type: string, details: Record<string, string>) {
    const shown: Record<string, string> = {};
    const secret: Record<string, string> = {};
    for (const [k, v] of Object.entries(details)) {
      if (!v) continue;
      if (BGV_SECRET_DETAILS.has(k)) {
        secret[k] = encryptField(v, this.config.fieldKeys);
        shown[k] = maskIdentifier(v);
      } else shown[k] = v;
    }
    void type;
    return { details: shown, secret_details: secret };
  }

  private async validateDocuments(tx: TenantTx, employeeId: string, ids: string[]) {
    if (!ids.length) return;
    const found = await tx.collection('employee_documents').count({ id: { $in: ids }, employee_id: employeeId, archived_at: null });
    if (found !== new Set(ids).size) throw Errors.badRequest('invalid_document', 'One of the linked documents is not one of this employee\'s documents');
  }

  private async nextReference(tx: TenantTx) {
    const year = new Date().getUTCFullYear();
    const prefix = `BGV-${year}-`;
    const last = await tx.collection('bgv_cases').find({ reference: { $regex: `^${prefix}` } }, { sort: { reference: -1 }, limit: 1, projection: { reference: 1 } });
    const n = last[0] ? Number(String(last[0].reference).slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(n).padStart(4, '0')}`;
  }

  private async requireVerifier(tx: TenantTx, membershipId: string, attrs: ResourceAttributes) {
    const m = await tx.collection('memberships').findOne({ id: membershipId, status: 'active' });
    if (!m) throw Errors.badRequest('invalid_assignee', 'The verifier is not an active member of this workspace');
    // The verifier must be able to work on this employee's checks, or they could not open the case.
    const s = await loadSubject(tx, membershipId, m.user_id, true);
    if (!grantsFor(s, 'bgv:edit').some((g) => grantCovers(s, g, attrs))) throw Errors.badRequest('assignee_cannot_verify', 'The verifier needs the background verification Edit permission for this employee');
  }

  async create(input: BgvCaseInput) {
    return this.db.tenant(async (tx) => {
      const { e, attrs } = await this.employee(tx, input.employeeId);
      await this.authz.require('bgv:create', attrs, tx);
      let agency: Doc | undefined;
      if (input.method === 'external') {
        agency = await tx.collection('bgv_agencies').findOne({ id: input.agencyId, active: true });
        if (!agency) throw Errors.badRequest('invalid_agency', 'Choose an active agency');
      }
      if (input.assigneeMembershipId) await this.requireVerifier(tx, input.assigneeMembershipId, attrs);
      for (const ch of input.checks) await this.validateDocuments(tx, e.id, ch.documentIds);
      const reference = await this.nextReference(tx);
      const c = await tx.collection('bgv_cases').insert({
        employee_id: e.id, method: input.method, agency_id: agency?.id ?? null, status: 'pending', reference, due_date: input.dueDate ?? null,
        assignee_membership_id: input.assigneeMembershipId ?? null, notes: input.notes ?? null, created_by_membership_id: actorMembership(),
      });
      await tx.collection('bgv_checks').insertMany(input.checks.map((ch, i) => ({ case_id: c.id, type: ch.type, document_ids: ch.documentIds, position: i, ...this.splitDetails(ch.type, ch.details) })));
      await this.event(tx, c.id, 'created', { to: 'pending', note: `${input.method === 'internal' ? 'Internal' : `External (${agency!.name})`} verification of ${input.checks.map((x) => BGV_CHECK_LABEL[x.type]).join(', ')}` });
      await this.audit.record(tx, { action: 'bgv.case_created', resourceType: 'bgv_case', resourceId: c.id, changes: { employeeId: e.id, reference, method: input.method, agencyId: agency?.id ?? null, checks: input.checks.map((x) => x.type) } });
      if (input.assigneeMembershipId && input.assigneeMembershipId !== actorMembership()) {
        await this.notifications.notify(tx, {
          membershipIds: [input.assigneeMembershipId], kind: 'bgv.assigned', title: `Background verification ${reference} assigned to you`,
          body: `Verify ${displayName(e as never)}: ${input.checks.map((x) => BGV_CHECK_LABEL[x.type]).join(', ')}.${input.dueDate ? ` Due ${input.dueDate}.` : ''}`, link: `/verification/${c.id}`,
        });
      }
      return this.view(tx, c.id);
    });
  }

  async list(q: z.infer<typeof bgvListQuery>) {
    return this.db.tenant(async (tx) => {
      const scope = await this.authz.filter('bgv:view', EMPLOYEE_FIELDS, tx);
      const employees = await tx.collection('employees').find(
        { ...scope, ...(q.employeeId ? { id: q.employeeId } : {}), ...(q.q ? { $or: [{ first_name: ilike(q.q) }, { last_name: ilike(q.q) }, { employee_code: ilike(q.q) }] } : {}) },
        { projection: { id: 1, first_name: 1, last_name: 1, preferred_name: 1, employee_code: 1, current_department_id: 1 } },
      );
      const byId = new Map(employees.map((x) => [x.id as string, x]));
      const filter: Doc = { employee_id: { $in: [...byId.keys()] } };
      if (q.q && /^BGV-/i.test(q.q)) { delete filter.employee_id; filter.reference = ilike(q.q); }
      if (q.status === 'open') filter.status = { $in: ['pending', 'in_progress', 'on_hold'] };
      else if (q.status) filter.status = q.status;
      if (q.method) filter.method = q.method;
      if (q.agencyId) filter.agency_id = q.agencyId;
      const cases = await tx.collection('bgv_cases').find(filter, { sort: { created_at: -1 }, limit: q.limit });
      // A reference search can find a case outside the member's scope: drop those.
      const missing = cases.filter((c) => !byId.has(c.employee_id)).map((c) => c.employee_id);
      if (missing.length) {
        for (const x of await tx.collection('employees').find({ ...scope, id: { $in: missing } })) byId.set(x.id, x);
      }
      const visible = cases.filter((c) => byId.has(c.employee_id));
      return this.summaries(tx, visible, byId);
    });
  }

  private async summaries(tx: TenantTx, cases: Doc[], employees: Map<string, Doc>) {
    const checks = await tx.collection('bgv_checks').find({ case_id: { $in: cases.map((c) => c.id) } }, { projection: { case_id: 1, status: 1, type: 1 } });
    const agencies = new Map((await tx.collection('bgv_agencies').find({ id: { $in: cases.map((c) => c.agency_id).filter(Boolean) } })).map((a) => [a.id as string, a.name as string]));
    const names = await membershipUserNames(tx, cases.map((c) => c.assignee_membership_id));
    const depts = new Map((await tx.collection('departments').find({ id: { $in: [...employees.values()].map((e) => e.current_department_id).filter(Boolean) } })).map((d) => [d.id as string, d.name as string]));
    return cases.map((c) => {
      const own = checks.filter((x) => x.case_id === c.id);
      const e = employees.get(c.employee_id);
      return {
        id: c.id as string, reference: c.reference as string, employeeId: c.employee_id as string, employeeName: e ? displayName(e as never) : null, employeeCode: e?.employee_code ?? null,
        department: e?.current_department_id ? depts.get(e.current_department_id) ?? null : null,
        method: c.method as string, agencyName: c.agency_id ? agencies.get(c.agency_id) ?? null : null, status: c.status as string,
        checks: { total: own.length, done: own.filter((x) => x.status === 'verified' || x.status === 'failed').length, failed: own.filter((x) => x.status === 'failed').length, types: own.map((x) => x.type as string) },
        dueDate: c.due_date ?? null, overdue: !!c.due_date && c.due_date < today() && !FINAL.has(c.status), completedOn: c.completed_on ?? null,
        assignee: c.assignee_membership_id ? names.get(c.assignee_membership_id) ?? null : null, createdAt: c.created_at,
      };
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      await this.caseFor(tx, id);
      return this.view(tx, id);
    });
  }

  private async view(tx: TenantTx, id: string) {
    const c = (await tx.collection('bgv_cases').findOne({ id }))!;
    const { e, attrs } = await this.employee(tx, c.employee_id);
    const canEdit = await this.covers(tx, 'bgv:edit', attrs);
    const canApprove = await this.covers(tx, 'bgv:approve', attrs);
    const canDelete = await this.covers(tx, 'bgv:delete', attrs);
    const checks = await tx.collection('bgv_checks').find({ case_id: id }, { sort: { position: 1 } });
    const files = await tx.collection('bgv_files').find({ case_id: id, removed_at: null }, { sort: { created_at: 1 } });
    const events = await tx.collection('bgv_events').find({ case_id: id }, { sort: { created_at: 1 } });
    const links = await tx.collection('bgv_agency_links').find({ case_id: id }, { sort: { created_at: -1 } });
    const agency = c.agency_id ? await tx.collection('bgv_agencies').findOne({ id: c.agency_id }) : undefined;
    const docIds = [...new Set(checks.flatMap((x) => x.document_ids ?? []))];
    const docs = new Map((await tx.collection('employee_documents').find({ id: { $in: docIds } }, { projection: { title: 1, category: 1, archived_at: 1 } })).map((d) => [d.id as string, d]));
    const names = await membershipUserNames(tx, [c.assignee_membership_id, c.created_by_membership_id, c.decided_by_membership_id, ...checks.map((x) => x.verified_by_membership_id), ...files.map((f) => f.uploaded_by_membership_id), ...events.map((x) => x.actor_membership_id)]);
    const dept = e.current_department_id ? await tx.collection('departments').findOne({ id: e.current_department_id }, { projection: { name: 1 } }) : undefined;
    const desig = e.current_designation_id ? await tx.collection('designations').findOne({ id: e.current_designation_id }, { projection: { name: 1 } }) : undefined;
    const now = new Date();
    return {
      id: c.id as string, reference: c.reference as string, method: c.method as string, status: c.status as string,
      employee: { id: e.id as string, name: displayName(e as never), code: e.employee_code ?? null, department: dept?.name ?? null, designation: desig?.name ?? null, dateOfJoining: e.date_of_joining ?? null },
      agency: agency ? this.agencyView(agency) : null, agencyReference: c.agency_reference ?? null, sentToAgencyAt: c.sent_to_agency_at ?? null,
      dueDate: c.due_date ?? null, completedOn: c.completed_on ?? null, notes: c.notes ?? null,
      assignee: c.assignee_membership_id ? { membershipId: c.assignee_membership_id as string, name: names.get(c.assignee_membership_id) ?? null } : null,
      decision: c.decided_at ? { remarks: c.decision_remarks ?? null, by: names.get(c.decided_by_membership_id) ?? null, at: c.decided_at } : null,
      cancelledReason: c.cancelled_reason ?? null, createdBy: names.get(c.created_by_membership_id) ?? null, createdAt: c.created_at,
      checks: checks.map((x) => ({
        id: x.id as string, type: x.type as string, label: BGV_CHECK_LABEL[x.type as keyof typeof BGV_CHECK_LABEL], status: x.status as string,
        details: canEdit ? { ...x.details, ...this.reveal(x.secret_details) } : x.details,
        documents: (x.document_ids ?? []).map((d: string) => ({ id: d, title: docs.get(d)?.title ?? 'Document', archived: !!docs.get(d)?.archived_at })),
        remarks: x.remarks ?? null, agencyFeedback: x.agency_feedback ?? null,
        verifiedBy: x.verified_by_membership_id ? names.get(x.verified_by_membership_id) ?? null : null, verifiedAt: x.verified_at ?? null,
      })),
      files: files.map((f) => ({
        id: f.id as string, title: f.title as string, kind: f.kind as string, checkId: f.check_id ?? null, fileName: f.file_name as string, sizeBytes: f.size_bytes as number,
        sharedWithAgency: !!f.shared_with_agency, uploadedBy: f.uploaded_by_agency ? `${f.uploaded_by_agency} (agency)` : names.get(f.uploaded_by_membership_id) ?? null, createdAt: f.created_at,
      })),
      history: events.map((x) => ({
        id: x.id as string, action: x.action as string, checkId: x.check_id ?? null, from: x.from_status ?? null, to: x.to_status ?? null, note: x.note ?? null,
        by: x.actor_label ?? (x.actor_membership_id ? names.get(x.actor_membership_id) ?? null : null), at: x.created_at,
      })),
      agencyLinks: links.map((l) => ({
        id: l.id as string, expiresAt: l.expires_at, active: !l.revoked_at && l.expires_at > now, revokedAt: l.revoked_at ?? null, lastUsedAt: l.last_used_at ?? null, submittedAt: l.submitted_at ?? null,
      })),
      can: { edit: canEdit && !FINAL.has(c.status), approve: canApprove && c.status !== 'cancelled', delete: canDelete && !FINAL.has(c.status) },
    };
  }

  private reveal(secret: Record<string, string> | undefined) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(secret ?? {})) {
      try { out[k] = decryptField(v, this.config.fieldKeys); } catch { out[k] = '(cannot be read)'; }
    }
    return out;
  }

  async forEmployee(employeeId: string) {
    return this.db.tenant(async (tx) => {
      const { e, attrs } = await this.employee(tx, employeeId);
      await this.authz.require('bgv:view', attrs, tx);
      const cases = await tx.collection('bgv_cases').find({ employee_id: employeeId }, { sort: { created_at: -1 } });
      return this.summaries(tx, cases, new Map([[e.id as string, e]]));
    });
  }

  private assertOpen(c: Doc) {
    if (FINAL.has(c.status)) throw Errors.conflict('case_closed', `This case is ${BGV_STATUS_LABEL[c.status as BgvStatus | 'cancelled'].toLowerCase()} and can no longer change. Start a new case to verify again.`);
  }

  async update(id: string, input: z.infer<typeof bgvCaseUpdateInput>) {
    return this.db.tenant(async (tx) => {
      const { c, attrs } = await this.caseFor(tx, id, 'bgv:edit');
      this.assertOpen(c);
      if (input.assigneeMembershipId) await this.requireVerifier(tx, input.assigneeMembershipId, attrs);
      const set: Doc = {};
      if (input.dueDate !== undefined) set.due_date = input.dueDate;
      if (input.assigneeMembershipId !== undefined) set.assignee_membership_id = input.assigneeMembershipId;
      if (input.notes !== undefined) set.notes = input.notes;
      if (input.agencyReference !== undefined) set.agency_reference = input.agencyReference;
      if (Object.keys(set).length) await tx.collection('bgv_cases').updateOne({ id }, { $set: set });
      await this.event(tx, id, 'updated', { note: Object.keys(set).map((k) => k.replace(/_/g, ' ')).join(', ') });
      await this.audit.record(tx, { action: 'bgv.case_updated', resourceType: 'bgv_case', resourceId: id, changes: input });
      if (input.assigneeMembershipId && input.assigneeMembershipId !== c.assignee_membership_id && input.assigneeMembershipId !== actorMembership()) {
        await this.notifications.notify(tx, { membershipIds: [input.assigneeMembershipId], kind: 'bgv.assigned', title: `Background verification ${c.reference} assigned to you`, link: `/verification/${id}` });
      }
      return this.view(tx, id);
    });
  }

  async addCheck(id: string, input: z.infer<typeof bgvCheckInput>) {
    return this.db.tenant(async (tx) => {
      const { c } = await this.caseFor(tx, id, 'bgv:edit');
      this.assertOpen(c);
      await this.validateDocuments(tx, c.employee_id, input.documentIds);
      const position = await tx.collection('bgv_checks').count({ case_id: id });
      const ch = await tx.collection('bgv_checks').insert({ case_id: id, type: input.type, document_ids: input.documentIds, position, ...this.splitDetails(input.type, input.details) });
      await this.event(tx, id, 'check_added', { checkId: ch.id, to: 'pending', note: BGV_CHECK_LABEL[input.type] });
      await this.audit.record(tx, { action: 'bgv.check_added', resourceType: 'bgv_case', resourceId: id, changes: { checkId: ch.id, type: input.type } });
      if (c.status !== 'pending' && c.status !== 'in_progress') await this.setStatus(tx, c, 'in_progress', 'A check was added');
      return this.view(tx, id);
    });
  }

  private async setStatus(tx: TenantTx, c: Doc, to: string, note: string) {
    if (c.status === to) return;
    await tx.collection('bgv_cases').updateOne({ id: c.id }, { $set: { status: to } });
    await this.event(tx, c.id, 'status_changed', { from: c.status, to, note });
    c.status = to;
  }

  async updateCheck(caseId: string, checkId: string, input: z.infer<typeof bgvCheckUpdateInput>) {
    return this.db.tenant(async (tx) => {
      const { c } = await this.caseFor(tx, caseId, 'bgv:edit');
      this.assertOpen(c);
      const ch = await tx.collection('bgv_checks').findOne({ id: checkId, case_id: caseId });
      if (!ch) throw Errors.notFound('Check');
      const set: Doc = {};
      if (input.details) {
        const split = this.splitDetails(ch.type, input.details);
        // A masked value sent back unchanged keeps the stored identifier.
        for (const k of Object.keys(input.details)) {
          if (BGV_SECRET_DETAILS.has(k) && input.details[k]?.includes('•') && ch.secret_details?.[k]) {
            split.secret_details[k] = ch.secret_details[k];
            split.details[k] = ch.details?.[k];
          }
        }
        Object.assign(set, split);
      }
      if (input.documentIds) {
        await this.validateDocuments(tx, c.employee_id, input.documentIds);
        set.document_ids = input.documentIds;
      }
      if (input.remarks !== undefined) set.remarks = input.remarks;
      if (input.agencyFeedback !== undefined) set.agency_feedback = input.agencyFeedback;
      if (input.status && input.status !== ch.status) {
        set.status = input.status;
        if (input.status === 'verified' || input.status === 'failed') {
          set.verified_by_membership_id = actorMembership();
          set.verified_at = new Date();
        } else {
          set.verified_by_membership_id = null;
          set.verified_at = null;
        }
      }
      await tx.collection('bgv_checks').updateOne({ id: checkId }, { $set: set });
      const label = BGV_CHECK_LABEL[ch.type as keyof typeof BGV_CHECK_LABEL];
      if (set.status) await this.event(tx, caseId, 'check_status', { checkId, from: ch.status, to: set.status, note: input.remarks ? `${label}: ${input.remarks}` : label });
      else if (input.remarks !== undefined) await this.event(tx, caseId, 'remark', { checkId, note: `${label}: ${input.remarks ?? '(cleared)'}` });
      if (input.details || input.documentIds) await this.event(tx, caseId, 'check_updated', { checkId, note: `${label} details` });
      if (input.agencyFeedback !== undefined) await this.event(tx, caseId, 'agency_feedback', { checkId, note: `${label}: ${input.agencyFeedback ?? '(cleared)'}` });
      await this.audit.record(tx, { action: 'bgv.check_updated', resourceType: 'bgv_case', resourceId: caseId, changes: { checkId, type: ch.type, status: set.status ? { from: ch.status, to: set.status } : undefined, remarks: input.remarks !== undefined ? 'changed' : undefined, details: input.details ? Object.keys(input.details) : undefined } });
      if (c.status === 'pending') {
        const all = await tx.collection<{ status: BgvStatus }>('bgv_checks').find({ case_id: caseId }, { projection: { status: 1 } });
        if (caseProgress(all) === 'in_progress') await this.setStatus(tx, c, 'in_progress', 'Work on the checks started');
      }
      return this.view(tx, caseId);
    });
  }

  async decide(id: string, input: z.infer<typeof bgvDecisionInput>) {
    return this.db.tenant(async (tx) => {
      const { c, e } = await this.caseFor(tx, id, 'bgv:approve');
      if (c.status === 'cancelled') throw Errors.conflict('case_closed', 'This case was cancelled');
      if (c.status === input.status) throw Errors.conflict('same_status', `The case is already ${BGV_STATUS_LABEL[input.status].toLowerCase()}`);
      const checks = await tx.collection('bgv_checks').find({ case_id: id }, { projection: { status: 1 } });
      if (input.status === 'verified' && checks.some((x) => x.status !== 'verified')) {
        throw Errors.conflict('checks_open', 'Every check must be verified before the case can be marked verified. Mark a check failed, or put the case on hold.');
      }
      const final = input.status === 'verified' || input.status === 'failed';
      if (final && input.completedOn && input.completedOn > today()) throw Errors.validation([{ path: 'completedOn', message: 'The completion date cannot be in the future' }]);
      await tx.collection('bgv_cases').updateOne({ id }, { $set: {
        status: input.status, decision_remarks: input.remarks, decided_by_membership_id: actorMembership(), decided_at: new Date(),
        completed_on: final ? input.completedOn ?? today() : null,
      } });
      await this.event(tx, id, final ? 'decided' : 'status_changed', { from: c.status, to: input.status, note: input.remarks });
      await this.audit.record(tx, { action: final ? 'bgv.case_decided' : 'bgv.case_status_changed', resourceType: 'bgv_case', resourceId: id, changes: { status: { from: c.status, to: input.status }, completedOn: final ? input.completedOn ?? today() : null } });
      const to = [c.created_by_membership_id, c.assignee_membership_id].filter((m) => m && m !== actorMembership());
      await this.notifications.notify(tx, {
        membershipIds: to, kind: final ? 'bgv.completed' : 'bgv.status_changed', title: `${c.reference}: ${displayName(e as never)} is ${BGV_STATUS_LABEL[input.status].toLowerCase()}`,
        body: input.remarks, link: `/verification/${id}`,
      });
      return this.view(tx, id);
    });
  }

  async cancel(id: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const { c } = await this.caseFor(tx, id, 'bgv:delete');
      this.assertOpen(c);
      await tx.collection('bgv_cases').updateOne({ id }, { $set: { status: 'cancelled', cancelled_reason: reason } });
      await tx.collection('bgv_agency_links').update({ case_id: id, revoked_at: null }, { $set: { revoked_at: new Date() } });
      await this.event(tx, id, 'cancelled', { from: c.status, to: 'cancelled', note: reason });
      await this.audit.record(tx, { action: 'bgv.case_cancelled', resourceType: 'bgv_case', resourceId: id, changes: { reason } });
      return this.view(tx, id);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------------------------------------

  async upload(caseId: string, meta: { title: string; checkId?: string; shared?: boolean }, file: UploadedFile | undefined) {
    const actor = requestContext.tenantActor();
    // Check access before storing anything.
    await this.db.tenant(async (tx) => {
      const { c } = await this.caseFor(tx, caseId, 'bgv:edit');
      this.assertOpen(c);
    });
    const stored = await storeUpload(this.storage, actor.tenantId, file);
    return this.db.tenant(async (tx) => {
      const { c } = await this.caseFor(tx, caseId, 'bgv:edit');
      if (meta.checkId && !(await tx.collection('bgv_checks').exists({ id: meta.checkId, case_id: caseId }))) throw Errors.badRequest('invalid_check', 'That check is not part of this case');
      const f = await tx.collection('bgv_files').insert({ case_id: caseId, check_id: meta.checkId ?? null, kind: 'supporting', title: meta.title, shared_with_agency: !!meta.shared, uploaded_by_membership_id: actor.membershipId, ...stored });
      await this.event(tx, caseId, 'file_uploaded', { checkId: meta.checkId ?? null, note: `${meta.title}${meta.shared ? ' (shared with the agency)' : ''}` });
      await this.audit.record(tx, { action: 'bgv.file_uploaded', resourceType: 'bgv_case', resourceId: caseId, metadata: { fileId: f.id, title: meta.title, sha256: stored.sha256, shared: !!meta.shared } });
      void c;
      return this.view(tx, caseId);
    });
  }

  async setFileShared(fileId: string, shared: boolean) {
    return this.db.tenant(async (tx) => {
      const f = await tx.collection('bgv_files').findOne({ id: fileId, removed_at: null });
      if (!f) throw Errors.notFound('File');
      const { c } = await this.caseFor(tx, f.case_id, 'bgv:edit');
      this.assertOpen(c);
      await tx.collection('bgv_files').updateOne({ id: fileId }, { $set: { shared_with_agency: shared } });
      await this.event(tx, f.case_id, shared ? 'file_shared' : 'file_unshared', { note: f.title });
      await this.audit.record(tx, { action: shared ? 'bgv.file_shared' : 'bgv.file_unshared', resourceType: 'bgv_case', resourceId: f.case_id, metadata: { fileId } });
      return this.view(tx, f.case_id);
    });
  }

  async removeFile(fileId: string) {
    return this.db.tenant(async (tx) => {
      const f = await tx.collection('bgv_files').findOne({ id: fileId, removed_at: null });
      if (!f) throw Errors.notFound('File');
      await this.caseFor(tx, f.case_id, 'bgv:delete');
      // The file itself is kept (verification history); it is only taken off the case.
      await tx.collection('bgv_files').updateOne({ id: fileId }, { $set: { removed_at: new Date(), shared_with_agency: false } });
      await this.event(tx, f.case_id, 'file_removed', { note: f.title });
      await this.audit.record(tx, { action: 'bgv.file_removed', resourceType: 'bgv_case', resourceId: f.case_id, metadata: { fileId, title: f.title } });
      return this.view(tx, f.case_id);
    });
  }

  async fileLink(fileId: string) {
    return this.db.tenant(async (tx) => {
      const f = await tx.collection('bgv_files').findOne({ id: fileId, removed_at: null });
      if (!f) throw Errors.notFound('File');
      await this.caseFor(tx, f.case_id);
      await this.audit.record(tx, { action: 'bgv.file_downloaded', resourceType: 'bgv_case', resourceId: f.case_id, metadata: { fileId, title: f.title } });
      return this.storage.sign(fileId, 300, 'bgv');
    });
  }

  async openFile(fileId: string, exp: number, sig: string) {
    if (!this.storage.verify(fileId, exp, sig, 'bgv')) throw Errors.notFound('File');
    const f = await this.db.platform((tx) => tx.collection('bgv_files').findOne({ id: fileId, removed_at: null }));
    if (!f) throw Errors.notFound('File');
    return { ...(await this.storage.open(f.storage_key)), fileName: f.file_name as string, contentType: f.content_type as string };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Sharing with an agency
  // ---------------------------------------------------------------------------------------------------------

  async share(caseId: string, input: z.infer<typeof bgvShareInput>) {
    return this.db.tenant(async (tx) => {
      const { c, e } = await this.caseFor(tx, caseId, 'bgv:edit');
      this.assertOpen(c);
      const agency = await tx.collection('bgv_agencies').findOne({ id: input.agencyId, active: true });
      if (!agency) throw Errors.badRequest('invalid_agency', 'Choose an active agency');
      // One live link per case: a new one replaces the last.
      await tx.collection('bgv_agency_links').update({ case_id: caseId, revoked_at: null }, { $set: { revoked_at: new Date() } });
      const token = randomBytes(32).toString('base64url');
      const expires = new Date(Date.now() + input.expiresInDays * 86400_000);
      const link = await tx.collection('bgv_agency_links').insert({ case_id: caseId, agency_id: agency.id, token_hash: sha256(token), expires_at: expires, created_by_membership_id: actorMembership() });
      await tx.collection('bgv_cases').updateOne({ id: caseId }, { $set: { method: 'external', agency_id: agency.id, sent_to_agency_at: new Date() } });
      const shared = await tx.collection('bgv_files').count({ case_id: caseId, removed_at: null, shared_with_agency: true });
      const tenant = await tx.collection('tenants').findOne({});
      const url = `${this.config.WEB_PUBLIC_URL}/verify/${token}`;
      await this.notifications.queueEmail(tx, tenant?.id ?? null, agency.email, `Background verification request ${c.reference} from ${tenant?.name ?? 'SampCrew'}`,
        `Hello${agency.contact_name ? ` ${agency.contact_name}` : ''},\n\n${tenant?.name ?? 'A SampCrew workspace'} has asked you to verify ${displayName(e as never)} (case ${c.reference}).${input.message ? `\n\n${input.message}` : ''}\n\nOpen the request, read the ${shared} shared document${shared === 1 ? '' : 's'} and send your findings and report here (the link works until ${expires.toISOString().slice(0, 10)}):\n${url}\n\nPlease do not forward this link.`,
        'bgv.agency_request', `Sent by SampCrew on behalf of ${tenant?.name ?? 'a SampCrew workspace'}.`);
      await this.event(tx, caseId, 'sent_to_agency', { note: `${agency.name}, link valid until ${expires.toISOString().slice(0, 10)}, ${shared} shared file${shared === 1 ? '' : 's'}` });
      await this.audit.record(tx, { action: 'bgv.sent_to_agency', resourceType: 'bgv_case', resourceId: caseId, metadata: { agencyId: agency.id, linkId: link.id, expiresAt: expires.toISOString(), sharedFiles: shared } });
      if (c.status === 'pending') await this.setStatus(tx, c, 'in_progress', `Sent to ${agency.name}`);
      return { case: await this.view(tx, caseId), url, expiresAt: expires.toISOString() };
    });
  }

  async revokeLink(caseId: string, linkId: string) {
    return this.db.tenant(async (tx) => {
      await this.caseFor(tx, caseId, 'bgv:edit');
      const n = await tx.collection('bgv_agency_links').updateOne({ id: linkId, case_id: caseId, revoked_at: null }, { $set: { revoked_at: new Date() } });
      if (!n) throw Errors.notFound('Link');
      await this.event(tx, caseId, 'link_revoked', { note: 'The agency link was switched off' });
      await this.audit.record(tx, { action: 'bgv.agency_link_revoked', resourceType: 'bgv_case', resourceId: caseId, metadata: { linkId } });
      return this.view(tx, caseId);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // The agency's side (no SampCrew account: the private link is the key)
  // ---------------------------------------------------------------------------------------------------------

  private async linkByToken(token: string) {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw Errors.notFound('Verification request');
    const l = await this.db.platform(async (tx) => {
      const d = await tx.collection('bgv_agency_links').findOne({ token_hash: sha256(token) });
      if (!d || d.revoked_at || d.expires_at < new Date()) return undefined;
      if (!(await tx.collection('tenants').exists({ id: d.tenant_id, status: 'active' }))) return undefined;
      return d;
    });
    if (!l) throw Errors.notFound('Verification request');
    // The link stops working when the workspace no longer has background verification (plan, or switched off).
    const e = await this.db.tenant((tx) => loadEntitlements(tx), { tenantId: l.tenant_id });
    if (!e.features.has('background_verification')) throw Errors.notFound('Verification request');
    return l;
  }

  async portal(token: string) {
    const l = await this.linkByToken(token);
    return this.db.tenant(async (tx) => {
      const c = await tx.collection('bgv_cases').findOne({ id: l.case_id });
      if (!c || c.status === 'cancelled') throw Errors.notFound('Verification request');
      const e = (await tx.collection('employees').findOne({ id: c.employee_id }))!;
      const tenant = await tx.collection('tenants').findOne({});
      const agency = await tx.collection('bgv_agencies').findOne({ id: l.agency_id });
      const checks = await tx.collection('bgv_checks').find({ case_id: c.id }, { sort: { position: 1 } });
      const files = await tx.collection('bgv_files').find({ case_id: c.id, removed_at: null, $or: [{ shared_with_agency: true }, { kind: 'agency_report' }] }, { sort: { created_at: 1 } });
      await tx.collection('bgv_agency_links').updateOne({ id: l.id }, { $set: { last_used_at: new Date() } });
      return {
        workspace: tenant?.name ?? null, agency: agency?.name ?? null, reference: c.reference as string, status: c.status as string, closed: FINAL.has(c.status),
        employee: { name: displayName(e as never), dateOfJoining: e.date_of_joining ?? null },
        dueDate: c.due_date ?? null, expiresAt: l.expires_at, submittedAt: l.submitted_at ?? null,
        checks: checks.map((x) => ({ id: x.id as string, type: x.type as string, label: BGV_CHECK_LABEL[x.type as keyof typeof BGV_CHECK_LABEL], status: x.status as string, details: { ...x.details, ...this.reveal(x.secret_details) }, agencyFeedback: x.agency_feedback ?? null })),
        files: files.map((f) => ({ id: f.id as string, title: f.title as string, kind: f.kind as string, fileName: f.file_name as string, sizeBytes: f.size_bytes as number })),
      };
    }, { tenantId: l.tenant_id });
  }

  async portalFile(token: string, fileId: string) {
    const l = await this.linkByToken(token);
    const f = await this.db.tenant(async (tx) => {
      const d = await tx.collection('bgv_files').findOne({ id: fileId, case_id: l.case_id, removed_at: null, $or: [{ shared_with_agency: true }, { kind: 'agency_report' }] });
      if (!d) throw Errors.notFound('File');
      await this.event(tx, l.case_id, 'agency_downloaded', { note: d.title, actorLabel: 'Agency' });
      await this.audit.record(tx, { action: 'bgv.agency_downloaded', resourceType: 'bgv_case', resourceId: l.case_id, metadata: { fileId, linkId: l.id }, tenantId: l.tenant_id, actorLabel: 'verification agency (private link)' });
      return d;
    }, { tenantId: l.tenant_id });
    return { ...(await this.storage.open(f.storage_key)), fileName: f.file_name as string, contentType: f.content_type as string };
  }

  async portalFindings(token: string, input: z.infer<typeof bgvAgencyFindingsInput>) {
    const l = await this.linkByToken(token);
    await this.db.tenant(async (tx) => {
      const c = await tx.collection('bgv_cases').findOne({ id: l.case_id });
      if (!c || FINAL.has(c.status)) throw Errors.conflict('case_closed', 'This verification is closed and no longer takes findings');
      const agency = await tx.collection('bgv_agencies').findOne({ id: l.agency_id });
      const who = `${input.reporterName} (${agency?.name ?? 'agency'})`;
      const checks = new Map((await tx.collection('bgv_checks').find({ case_id: c.id })).map((x) => [x.id as string, x]));
      for (const f of input.checks) {
        const ch = checks.get(f.checkId);
        if (!ch) throw Errors.badRequest('invalid_check', 'One of the checks is not part of this request');
        await tx.collection('bgv_checks').updateOne({ id: ch.id }, { $set: { status: f.status, agency_feedback: f.feedback ?? ch.agency_feedback ?? null, ...(f.status === 'verified' || f.status === 'failed' ? { verified_at: new Date(), verified_by_membership_id: null } : {}) } });
        await this.event(tx, c.id, 'agency_feedback', { checkId: ch.id, from: ch.status, to: f.status, note: `${BGV_CHECK_LABEL[ch.type as keyof typeof BGV_CHECK_LABEL]}${f.feedback ? `: ${f.feedback}` : ''}`, actorLabel: who });
      }
      const set: Doc = {};
      if (input.completedOn) set.completed_on = input.completedOn;
      if (c.status === 'pending') set.status = 'in_progress';
      if (Object.keys(set).length) await tx.collection('bgv_cases').updateOne({ id: c.id }, { $set: set });
      await tx.collection('bgv_agency_links').updateOne({ id: l.id }, { $set: { submitted_at: new Date(), last_used_at: new Date() } });
      await this.event(tx, c.id, 'agency_submitted', { note: input.summary ?? `${input.checks.length} finding${input.checks.length === 1 ? '' : 's'}${input.completedOn ? `, completed ${input.completedOn}` : ''}`, actorLabel: who });
      await this.audit.record(tx, { action: 'bgv.agency_findings', resourceType: 'bgv_case', resourceId: c.id, changes: { checks: input.checks.map((x) => ({ checkId: x.checkId, status: x.status })), completedOn: input.completedOn ?? null }, tenantId: l.tenant_id, actorLabel: `verification agency: ${who}` });
      await this.notifications.notify(tx, {
        membershipIds: [c.created_by_membership_id, c.assignee_membership_id], kind: 'bgv.agency_report', title: `${agency?.name ?? 'The agency'} sent findings for ${c.reference}`,
        body: input.summary ?? 'Review the findings and set the final result.', link: `/verification/${c.id}`,
      });
    }, { tenantId: l.tenant_id });
    return this.portal(token);
  }

  async portalReport(token: string, title: string, file: UploadedFile | undefined) {
    const l = await this.linkByToken(token);
    const open = await this.db.tenant(async (tx) => tx.collection('bgv_cases').findOne({ id: l.case_id }), { tenantId: l.tenant_id });
    if (!open || FINAL.has(open.status)) throw Errors.conflict('case_closed', 'This verification is closed and no longer takes reports');
    const stored = await storeUpload(this.storage, l.tenant_id, file);
    await this.db.tenant(async (tx) => {
      const agency = await tx.collection('bgv_agencies').findOne({ id: l.agency_id });
      const f = await tx.collection('bgv_files').insert({ case_id: l.case_id, kind: 'agency_report', title, uploaded_by_agency: agency?.name ?? 'Agency', shared_with_agency: false, ...stored });
      await this.event(tx, l.case_id, 'agency_report', { note: title, actorLabel: agency?.name ?? 'Agency' });
      await this.audit.record(tx, { action: 'bgv.agency_report_uploaded', resourceType: 'bgv_case', resourceId: l.case_id, metadata: { fileId: f.id, sha256: stored.sha256 }, tenantId: l.tenant_id, actorLabel: `verification agency: ${agency?.name ?? ''}` });
    }, { tenantId: l.tenant_id });
    return this.portal(token);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------------------------------------

  async exportRows(q: z.infer<typeof bgvListQuery>) {
    const rows = await this.list({ ...q, limit: 500 });
    return this.db.tenant(async (tx) => {
      await this.authz.require('bgv:export', undefined, tx);
      // Export only what the member may export: bgv:export can be narrower than bgv:view.
      const scope = await this.authz.filter('bgv:export', EMPLOYEE_FIELDS, tx);
      const allowed = new Set((await tx.collection('employees').find({ ...scope, id: { $in: rows.map((r) => r.employeeId) } }, { projection: { _id: 1 } })).map((e) => e.id as string));
      await this.audit.record(tx, { action: 'bgv.exported', resourceType: 'bgv_case', metadata: { rows: rows.length, filters: q } });
      return [
        ['Reference', 'Employee', 'Employee ID', 'Department', 'Method', 'Agency', 'Status', 'Checks', 'Checks done', 'Checks failed', 'Due', 'Completed', 'Verifier', 'Started'],
        ...rows.filter((r) => allowed.has(r.employeeId)).map((r) => [
          r.reference, r.employeeName, r.employeeCode, r.department, r.method, r.agencyName, BGV_STATUS_LABEL[r.status as BgvStatus | 'cancelled'] ?? r.status,
          r.checks.types.map((t) => BGV_CHECK_LABEL[t as keyof typeof BGV_CHECK_LABEL]).join(', '), r.checks.done, r.checks.failed, r.dueDate, r.completedOn, r.assignee,
          new Date(r.createdAt as Date).toISOString().slice(0, 10),
        ]),
      ];
    });
  }

  /** Members who can be given cases: active members holding bgv:edit (for the verifier list). */
  async verifiers() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('bgv:create', undefined, tx);
      const active = (await permissionHolderIds(tx, 'bgv:edit')).map((id) => ({ id }));
      const names = await membershipUserNames(tx, active.map((m) => m.id));
      return active.map((m) => ({ membershipId: m.id as string, name: names.get(m.id) ?? 'Member' })).sort((a, b) => a.name.localeCompare(b.name));
    });
  }
}
