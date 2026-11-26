import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  builtInType, checklistProgress, DEFAULT_LIBRARY_CATEGORIES, DEFAULT_LIBRARY_ITEMS, DEFAULT_TEMPLATES, mayRequireDocument, ONBOARDING_DOC_STATUS_LABEL, ONBOARDING_REQUIREMENT_LABEL,
  onboardingDocStatus, REQUEST_FILE_LABEL, type AssignChecklistInput, type DocumentRequestStatus, type libraryCategoryInput, type LibraryItemInput, type libraryRequestDecision,
  type libraryRequestInput, type LibraryTemplateInput, type OnboardingRequirement, type RequestFileFormat,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { ilike, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { superWorkspaceMembers } from '../communication/identity';
import { displayName, fieldById } from '../employees/employee-view';
import { DocumentCenterService } from './document-center.service';
import { accessFor, CENTRAL, type Doc, hrCovers, hrWorkspaceAdmins, type Viewer } from './document-access';

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : (d as string | null | undefined) ?? null);
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const SEEDED = 'onboarding_library';

/**
 * Onboarding documents (issue #89): the Super Workspace's document library and checklist templates, the checklist HR
 * assigns to a new joiner, and its progress. Each assigned document is a document request (checklist_id set), so the
 * employee's My Tasks, the HR approval queue, Approvals and the document repository read the same record, and a
 * document counts as done only when HR approves it. A checklist whose mandatory documents are all approved is
 * completed and archived (kept in the employee's onboarding history, never deleted).
 */
@Injectable()
export class OnboardingDocumentsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly center: DocumentCenterService,
  ) {}

  onModuleInit() {
    this.center.onRequestChanged((tx, r) => this.recompute(tx, r.checklist_id as string, r));
  }

  // Library ------------------------------------------------------------------------------------------------------

  /** The default library, written once per company the first time anyone opens it; the Super Workspace edits it from there. */
  async ensureLibrary(tx: TenantTx) {
    if (await tx.collection('form_settings').exists({ form_key: SEEDED })) return;
    const cats = new Map<string, string>();
    for (const [n, c] of DEFAULT_LIBRARY_CATEGORIES.entries()) {
      const row = await tx.collection('onboarding_doc_categories').upsert({ key: c.key }, { key: c.key, name: `${c.letter}. ${c.name}`, description: c.description, sort: n, built_in: true });
      cats.set(c.key, row.id as string);
    }
    const items = new Map<string, string>();
    for (const [n, it] of DEFAULT_LIBRARY_ITEMS.entries()) {
      const row = await tx.collection('onboarding_doc_items').upsert({ key: it.key }, {
        key: it.key, category_id: cats.get(it.category)!, name: it.name, requirement: it.requirement, description: it.description || null, instructions: it.instructions || null,
        formats: it.formats, max_mb: it.maxMb, multiple: it.multiple, max_files: it.maxFiles, verification: it.verification || null, type_key: it.typeKey, sensitive: it.sensitive,
        active: true, sort: n, built_in: true,
      });
      items.set(it.key, row.id as string);
    }
    const byKey = new Map(DEFAULT_LIBRARY_ITEMS.map((x) => [x.key, x]));
    for (const t of DEFAULT_TEMPLATES) {
      await tx.collection('onboarding_doc_templates').upsert({ key: t.key }, {
        key: t.key, name: t.name, description: t.description, employment_types: t.employmentTypes, department_ids: [], is_default: !!t.isDefault, active: true, built_in: true,
        // In a template a document is required when the library marks it mandatory; the rest can be left out by HR.
        items: [...new Set(t.items)].map((k) => ({ itemId: items.get(k)!, required: byKey.get(k)!.requirement === 'mandatory' })),
      });
    }
    await tx.collection('form_settings').upsert({ form_key: SEEDED }, { form_key: SEEDED, settings: { seededAt: new Date().toISOString(), items: DEFAULT_LIBRARY_ITEMS.length } });
  }

  /** May this person change the library: the Super Workspace, or HR it gave the permission to (per HR Workspace). */
  private mayManage(v: Viewer): boolean {
    if (v.isSuper) return true;
    if (!v.hr) return false;
    if (v.hr.companyWide) return v.book.get(null).manage_onboarding_library;
    return v.hr.workspaceIds.some((w) => v.book.get(w).manage_onboarding_library);
  }

  private async requireManage(tx: TenantTx) {
    const v = await this.center.viewerIn(tx);
    if (!this.mayManage(v)) throw Errors.forbidden('Only the Super Workspace manages the onboarding document library, unless it gives your HR Workspace that permission');
    return v;
  }

  private async requireHrOrSuper(tx: TenantTx) {
    const v = await this.center.viewerIn(tx);
    if (!v.isSuper && !v.hr) throw Errors.forbidden('Onboarding documents are managed by the Super Workspace and HR Workspaces');
    return v;
  }

  /** Tells the Super Workspace when HR changed the library ("checklist configuration changed"). */
  private async configChanged(tx: TenantTx, v: Viewer, what: string) {
    if (v.isSuper) return;
    const supers = (await superWorkspaceMembers(tx)).filter((m) => m !== v.s.membershipId);
    await this.notifications.notify(tx, { membershipIds: supers, kind: 'onboarding.library_changed', title: 'Onboarding checklist configuration changed', body: `${what} (by HR Workspace).`, link: '/settings/onboarding-documents' });
  }

  async library() {
    return this.db.tenant(async (tx) => {
      const v = await this.requireHrOrSuper(tx);
      await this.ensureLibrary(tx);
      const categories = await tx.collection('onboarding_doc_categories').find({ archived_at: null }, { sort: { sort: 1, name: 1 } });
      const items = await tx.collection('onboarding_doc_items').find({ archived_at: null }, { sort: { sort: 1, name: 1 } });
      const templates = await tx.collection('onboarding_doc_templates').find({ archived_at: null }, { sort: { is_default: -1, name: 1 } });
      const depts = await fieldById(tx, 'departments', templates.flatMap((t) => t.department_ids ?? []));
      const requests = await tx.collection('onboarding_library_requests').find(v.isSuper ? {} : { requested_by_membership_id: v.s.membershipId }, { sort: { created_at: -1 }, limit: 50 });
      const names = await fieldById(tx, 'hr_workspaces', requests.map((r) => r.hr_workspace_id));
      return {
        level: v.isSuper ? 'super' as const : 'hr' as const,
        canManage: this.mayManage(v),
        categories: categories.map((c) => ({ id: c.id as string, key: c.key as string, name: c.name as string, description: (c.description ?? null) as string | null, builtIn: !!c.built_in, items: items.filter((i) => i.category_id === c.id).length })),
        items: items.map((i) => itemView(i)),
        templates: templates.map((t) => ({
          id: t.id as string, key: t.key as string, name: t.name as string, description: (t.description ?? null) as string | null, isDefault: !!t.is_default, active: !!t.active, builtIn: !!t.built_in,
          items: (t.items ?? []) as { itemId: string; required: boolean }[], employmentTypes: (t.employment_types ?? []) as string[],
          departments: ((t.department_ids ?? []) as string[]).map((d) => ({ id: d, name: depts.get(d) ?? null })),
        })),
        requests: requests.map((r) => ({
          id: r.id as string, kind: r.kind as 'document' | 'permission', name: (r.name ?? null) as string | null, reason: r.reason as string, status: r.status as string, requirement: (r.requirement ?? null) as string | null,
          hrWorkspace: r.hr_workspace_id ? names.get(r.hr_workspace_id) ?? null : null, decisionNote: (r.decision_note ?? null) as string | null, createdAt: iso(r.created_at)!, decidedAt: iso(r.decided_at),
        })),
      };
    });
  }

  async addCategory(input: z.infer<typeof libraryCategoryInput>) {
    return this.db.tenant(async (tx) => {
      const v = await this.requireManage(tx);
      await this.ensureLibrary(tx);
      const key = `${slug(input.name)}_${Date.now().toString(36)}`;
      const max = await tx.collection('onboarding_doc_categories').find({}, { sort: { sort: -1 }, limit: 1 });
      const row = await tx.collection('onboarding_doc_categories').insert({ key, name: input.name, description: input.description ?? null, sort: input.sort ?? ((max[0]?.sort as number | undefined) ?? 0) + 1, created_by_membership_id: v.s.membershipId });
      await this.audit.record(tx, { action: 'onboarding_library.category_added', resourceType: 'onboarding_doc_category', resourceId: row.id, metadata: { name: input.name } });
      await this.configChanged(tx, v, `Category added: ${input.name}`);
      return { id: row.id as string };
    });
  }

  async updateCategory(id: string, input: z.infer<typeof libraryCategoryInput>) {
    return this.db.tenant(async (tx) => {
      const v = await this.requireManage(tx);
      const c = await tx.collection('onboarding_doc_categories').findOne({ id, archived_at: null });
      if (!c) throw Errors.notFound('Category');
      await tx.collection('onboarding_doc_categories').updateOne({ id }, { $set: { name: input.name, description: input.description ?? null, ...(input.sort !== undefined ? { sort: input.sort } : {}) } });
      await this.audit.record(tx, { action: 'onboarding_library.category_changed', resourceType: 'onboarding_doc_category', resourceId: id, changes: { name: { from: c.name, to: input.name } } });
      await this.configChanged(tx, v, `Category changed: ${input.name}`);
      return { id };
    });
  }

  /** Removes a category from the library (kept, archived). Only an empty one: move or remove its documents first. */
  async archiveCategory(id: string) {
    return this.db.tenant(async (tx) => {
      const v = await this.requireManage(tx);
      const c = await tx.collection('onboarding_doc_categories').findOne({ id, archived_at: null });
      if (!c) throw Errors.notFound('Category');
      if (await tx.collection('onboarding_doc_items').exists({ category_id: id, archived_at: null })) throw Errors.conflict('category_not_empty', 'Move or remove the documents in this category first');
      await tx.collection('onboarding_doc_categories').updateOne({ id }, { $set: { archived_at: new Date() } });
      await this.audit.record(tx, { action: 'onboarding_library.category_removed', resourceType: 'onboarding_doc_category', resourceId: id, metadata: { name: c.name } });
      await this.configChanged(tx, v, `Category removed: ${c.name as string}`);
      return { ok: true };
    });
  }

  private checkRequirement(v: Viewer, input: Pick<LibraryItemInput, 'requirement' | 'sensitive'>) {
    if (input.requirement === 'mandatory' && !mayRequireDocument(v.isSuper ? 'super' : 'hr', input, this.mayManage(v))) {
      throw Errors.forbidden('Only the Super Workspace can make a sensitive document (identity numbers, bank or medical details) mandatory');
    }
  }

  async addItem(input: LibraryItemInput) {
    return this.db.tenant(async (tx) => {
      const v = await this.requireManage(tx);
      await this.ensureLibrary(tx);
      this.checkRequirement(v, input);
      if (!(await tx.collection('onboarding_doc_categories').exists({ id: input.categoryId, archived_at: null }))) throw Errors.badRequest('unknown_category', 'Choose a category');
      const row = await tx.collection('onboarding_doc_items').insert({ key: `${slug(input.name)}_${Date.now().toString(36)}`, ...itemRow(input), type_key: 'custom', sort: 1000, created_by_membership_id: v.s.membershipId, updated_by_membership_id: v.s.membershipId });
      await this.audit.record(tx, { action: 'onboarding_library.document_added', resourceType: 'onboarding_doc_item', resourceId: row.id, metadata: { name: input.name, requirement: input.requirement } });
      await this.configChanged(tx, v, `Document added: ${input.name} (${ONBOARDING_REQUIREMENT_LABEL[input.requirement]})`);
      return itemView(row);
    });
  }

  async updateItem(id: string, input: LibraryItemInput) {
    return this.db.tenant(async (tx) => {
      const v = await this.requireManage(tx);
      const it = await tx.collection('onboarding_doc_items').findOne({ id, archived_at: null });
      if (!it) throw Errors.notFound('Document');
      // HR may not loosen what the Super Workspace made mandatory for a sensitive document either.
      this.checkRequirement(v, input);
      if (!v.isSuper && it.sensitive && !input.sensitive) throw Errors.forbidden('Only the Super Workspace can change whether a document is sensitive');
      if (!(await tx.collection('onboarding_doc_categories').exists({ id: input.categoryId, archived_at: null }))) throw Errors.badRequest('unknown_category', 'Choose a category');
      const set = { ...itemRow(input), updated_by_membership_id: v.s.membershipId };
      await tx.collection('onboarding_doc_items').updateOne({ id }, { $set: set });
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [k, val] of Object.entries(set)) if (k !== 'updated_by_membership_id' && JSON.stringify(it[k] ?? null) !== JSON.stringify(val ?? null)) changes[k] = { from: it[k] ?? null, to: val ?? null };
      await this.audit.record(tx, { action: 'onboarding_library.document_changed', resourceType: 'onboarding_doc_item', resourceId: id, changes });
      await this.configChanged(tx, v, `Document changed: ${input.name}`);
      return itemView((await tx.collection('onboarding_doc_items').findOne({ id }))!);
    });
  }

  /** Removes a document from the library. Documents already asked of people keep their requests and history. */
  async archiveItem(id: string) {
    return this.db.tenant(async (tx) => {
      const v = await this.requireManage(tx);
      const it = await tx.collection('onboarding_doc_items').findOne({ id, archived_at: null });
      if (!it) throw Errors.notFound('Document');
      await tx.collection('onboarding_doc_items').updateOne({ id }, { $set: { archived_at: new Date(), active: false, updated_by_membership_id: v.s.membershipId } });
      for (const t of await tx.collection('onboarding_doc_templates').find({ 'items.itemId': id })) {
        await tx.collection('onboarding_doc_templates').updateOne({ id: t.id }, { $set: { items: ((t.items ?? []) as { itemId: string }[]).filter((x) => x.itemId !== id) } });
      }
      await this.audit.record(tx, { action: 'onboarding_library.document_removed', resourceType: 'onboarding_doc_item', resourceId: id, metadata: { name: it.name } });
      await this.configChanged(tx, v, `Document removed: ${it.name as string}`);
      return { ok: true };
    });
  }

  private async checkTemplate(tx: TenantTx, v: Viewer, input: LibraryTemplateInput) {
    const items = await tx.collection('onboarding_doc_items').find({ id: { $in: input.items.map((x) => x.itemId) }, archived_at: null });
    if (items.length !== input.items.length) throw Errors.badRequest('unknown_document', 'A document in the template is not in the library');
    for (const x of input.items) {
      const it = items.find((i) => i.id === x.itemId)!;
      if (x.required && !mayRequireDocument(v.isSuper ? 'super' : 'hr', { sensitive: !!it.sensitive }, this.mayManage(v))) {
        throw Errors.forbidden(`Only the Super Workspace can make ${it.name as string} required`);
      }
    }
  }

  async addTemplate(input: LibraryTemplateInput) {
    return this.db.tenant(async (tx) => {
      const v = await this.requireManage(tx);
      await this.ensureLibrary(tx);
      await this.checkTemplate(tx, v, input);
      if (input.isDefault) await tx.collection('onboarding_doc_templates').update({ is_default: true }, { $set: { is_default: false } });
      const row = await tx.collection('onboarding_doc_templates').insert({ key: `${slug(input.name)}_${Date.now().toString(36)}`, ...templateRow(input), created_by_membership_id: v.s.membershipId, updated_by_membership_id: v.s.membershipId });
      await this.audit.record(tx, { action: 'onboarding_library.template_added', resourceType: 'onboarding_doc_template', resourceId: row.id, metadata: { name: input.name, documents: input.items.length } });
      await this.configChanged(tx, v, `Template added: ${input.name}`);
      return { id: row.id as string };
    });
  }

  async updateTemplate(id: string, input: LibraryTemplateInput) {
    return this.db.tenant(async (tx) => {
      const v = await this.requireManage(tx);
      const t = await tx.collection('onboarding_doc_templates').findOne({ id, archived_at: null });
      if (!t) throw Errors.notFound('Template');
      await this.checkTemplate(tx, v, input);
      if (input.isDefault) await tx.collection('onboarding_doc_templates').update({ is_default: true, id: { $ne: id } }, { $set: { is_default: false } });
      await tx.collection('onboarding_doc_templates').updateOne({ id }, { $set: { ...templateRow(input), updated_by_membership_id: v.s.membershipId } });
      await this.audit.record(tx, { action: 'onboarding_library.template_changed', resourceType: 'onboarding_doc_template', resourceId: id, changes: { name: { from: t.name, to: input.name }, documents: { from: (t.items ?? []).length, to: input.items.length } } });
      await this.configChanged(tx, v, `Template changed: ${input.name}`);
      return { id };
    });
  }

  async archiveTemplate(id: string) {
    return this.db.tenant(async (tx) => {
      const v = await this.requireManage(tx);
      const t = await tx.collection('onboarding_doc_templates').findOne({ id, archived_at: null });
      if (!t) throw Errors.notFound('Template');
      await tx.collection('onboarding_doc_templates').updateOne({ id }, { $set: { archived_at: new Date(), active: false, is_default: false } });
      await this.audit.record(tx, { action: 'onboarding_library.template_removed', resourceType: 'onboarding_doc_template', resourceId: id, metadata: { name: t.name } });
      await this.configChanged(tx, v, `Template removed: ${t.name as string}`);
      return { ok: true };
    });
  }

  // Requests to the Super Workspace ---------------------------------------------------------------------------------

  async requestToSuper(input: z.infer<typeof libraryRequestInput>) {
    return this.db.tenant(async (tx) => {
      const v = await this.center.viewerIn(tx);
      if (!v.hr || v.isSuper) throw Errors.forbidden('HR Workspace asks the Super Workspace; the Super Workspace changes the library itself');
      if (input.kind === 'permission' && this.mayManage(v)) throw Errors.conflict('already_allowed', 'Your HR Workspace can already manage the library');
      if (await tx.collection('onboarding_library_requests').exists({ requested_by_membership_id: v.s.membershipId, status: 'open', kind: input.kind, ...(input.kind === 'document' ? { name: input.name } : {}) })) {
        throw Errors.conflict('already_requested', 'You already asked for this; the Super Workspace has not answered yet');
      }
      const ws = v.hr.companyWide ? null : v.hr.workspaceIds[0] ?? null;
      const row = await tx.collection('onboarding_library_requests').insert({
        kind: input.kind, name: input.name ?? null, category_id: input.categoryId ?? null, requirement: input.requirement ?? null, reason: input.reason, hr_workspace_id: ws, requested_by_membership_id: v.s.membershipId,
      });
      await this.audit.record(tx, { action: `onboarding_library.${input.kind}_requested`, resourceType: 'onboarding_library_request', resourceId: row.id, metadata: { name: input.name ?? null, reason: input.reason } });
      const supers = await superWorkspaceMembers(tx);
      await this.notifications.notify(tx, {
        membershipIds: supers, kind: input.kind === 'document' ? 'onboarding.document_requested' : 'onboarding.permission_requested',
        title: input.kind === 'document' ? `HR asked for a new onboarding document: ${input.name}` : 'HR asked for permission to manage onboarding checklists',
        body: input.reason, link: '/settings/onboarding-documents?tab=requests', email: true, resource: { type: 'onboarding_library_request', id: row.id as string },
      });
      return { id: row.id as string };
    });
  }

  /** The Super Workspace answers: a document is added to the library (optional unless it says otherwise), or HR gets the permission. */
  async decideRequest(id: string, input: z.infer<typeof libraryRequestDecision>) {
    return this.db.tenant(async (tx) => {
      const v = await this.center.viewerIn(tx);
      if (!v.isSuper) throw Errors.forbidden('Only the Super Workspace answers these requests');
      const r = await tx.collection('onboarding_library_requests').findOne({ id });
      if (!r) throw Errors.notFound('Request');
      if (r.status !== 'open') throw Errors.conflict('already_decided', 'This request was already answered');
      let itemId: string | null = null;
      if (input.decision === 'approve' && r.kind === 'document') {
        await this.ensureLibrary(tx);
        const cat = (r.category_id ? await tx.collection('onboarding_doc_categories').findOne({ id: r.category_id, archived_at: null }) : undefined)
          ?? (await tx.collection('onboarding_doc_categories').findOne({ key: 'additional' })) ?? (await tx.collection('onboarding_doc_categories').find({ archived_at: null }, { limit: 1 }))[0];
        if (!cat) throw Errors.badRequest('no_category', 'Add a category to the library first');
        const row = await tx.collection('onboarding_doc_items').insert({
          key: `${slug(r.name as string)}_${Date.now().toString(36)}`, category_id: cat.id, name: r.name, requirement: (r.requirement as OnboardingRequirement | null) ?? 'optional',
          description: r.reason, instructions: 'Upload a clear, complete and readable copy.', formats: ['pdf', 'image'], max_mb: 5, multiple: false, max_files: 1, type_key: 'custom', sort: 1000,
          created_by_membership_id: v.s.membershipId, updated_by_membership_id: v.s.membershipId,
        });
        itemId = row.id as string;
        await this.audit.record(tx, { action: 'onboarding_library.document_added', resourceType: 'onboarding_doc_item', resourceId: itemId, metadata: { name: r.name, fromRequest: id } });
      }
      if (input.decision === 'approve' && r.kind === 'permission') await this.setPermission(tx, v, r.hr_workspace_id ?? null, true);
      await tx.collection('onboarding_library_requests').updateOne({ id }, { $set: { status: input.decision === 'approve' ? 'approved' : 'declined', decided_by_membership_id: v.s.membershipId, decision_note: input.note ?? null, decided_at: new Date(), item_id: itemId } });
      await this.audit.record(tx, { action: `onboarding_library.request_${input.decision === 'approve' ? 'approved' : 'declined'}`, resourceType: 'onboarding_library_request', resourceId: id, metadata: { kind: r.kind, name: r.name ?? null, note: input.note ?? null } });
      await this.notifications.notify(tx, {
        membershipIds: [r.requested_by_membership_id], kind: 'onboarding.request_decided',
        title: input.decision === 'approve' ? (r.kind === 'document' ? `${r.name as string} was added to the onboarding library` : 'You can now manage onboarding checklists') : `Your onboarding ${r.kind === 'document' ? 'document' : 'permission'} request was declined`,
        body: input.note ?? undefined, link: '/settings/onboarding-documents',
      });
      return { ok: true, itemId };
    });
  }

  /** Gives or takes HR's permission to manage the library (the document access switch for that HR Workspace), audited. */
  private async setPermission(tx: TenantTx, v: Viewer, hrWorkspaceId: string | null, on: boolean) {
    const scope = hrWorkspaceId ?? CENTRAL;
    const row = await tx.collection('document_access_settings').findOne({ scope_key: scope });
    const before = v.book.get(hrWorkspaceId);
    const switches = { ...before, ...(row?.switches ?? {}), manage_onboarding_library: on };
    if (row) await tx.collection('document_access_settings').updateOne({ id: row.id }, { $set: { switches, updated_by_membership_id: v.s.membershipId }, $inc: { version: 1 } });
    else await tx.collection('document_access_settings').insert({ scope_key: scope, hr_workspace_id: hrWorkspaceId, switches, updated_by_membership_id: v.s.membershipId });
    await this.audit.record(tx, { action: 'document_access.changed', resourceType: 'hr_workspace', resourceId: hrWorkspaceId ?? scope, changes: { manage_onboarding_library: { from: before.manage_onboarding_library, to: on } } });
  }

  // Assigning a checklist ---------------------------------------------------------------------------------------------

  /** What HR picks from when adding someone: the templates (one suggested for the type and department) and the library. */
  async assignOptions(q: { employmentType?: string; departmentId?: string }) {
    return this.db.tenant(async (tx) => {
      await this.requireHrOrSuper(tx);
      await this.ensureLibrary(tx);
      const items = await tx.collection('onboarding_doc_items').find({ archived_at: null, active: true }, { sort: { sort: 1, name: 1 } });
      const cats = await tx.collection('onboarding_doc_categories').find({ archived_at: null }, { sort: { sort: 1 } });
      const templates = (await tx.collection('onboarding_doc_templates').find({ archived_at: null, active: true }, { sort: { is_default: -1, name: 1 } }));
      const live = new Set(items.map((i) => i.id as string));
      const score = (t: Doc) => (q.departmentId && (t.department_ids ?? []).includes(q.departmentId) ? 2 : 0) + (q.employmentType && (t.employment_types ?? []).includes(q.employmentType) ? 1 : 0);
      const best = [...templates].sort((a, b) => score(b) - score(a))[0];
      const suggested = best && score(best) > 0 ? best : templates.find((t) => t.is_default) ?? templates[0];
      return {
        suggestedTemplateId: (suggested?.id ?? null) as string | null,
        categories: cats.map((c) => ({ id: c.id as string, name: c.name as string })),
        items: items.map(itemView),
        templates: templates.map((t) => ({ id: t.id as string, name: t.name as string, description: (t.description ?? null) as string | null, isDefault: !!t.is_default, departmentIds: (t.department_ids ?? []) as string[], employmentTypes: (t.employment_types ?? []) as string[], items: ((t.items ?? []) as { itemId: string; required: boolean }[]).filter((x) => live.has(x.itemId)) })),
      };
    });
  }

  /** Assigns (or adds to) an employee's checklist outside the hire form, e.g. for someone added before. */
  async assign(employeeId: string, input: AssignChecklistInput) {
    return this.db.tenant(async (tx) => {
      const id = await this.assignInTx(tx, employeeId, input);
      return this.checklistView(tx, await this.center.viewerIn(tx), (await tx.collection('onboarding_checklists').findOne({ id }))!);
    });
  }

  /**
   * Creates the employee's checklist, or adds documents to the one they have, in the caller's transaction (the hire
   * form calls this inside the employee's own transaction, so both are created or neither is). A document already on
   * the checklist is never asked for twice.
   */
  async assignInTx(tx: TenantTx, employeeId: string, input: AssignChecklistInput, opts: { atHire?: boolean } = {}): Promise<string> {
    const v = await this.center.viewerIn(tx);
    const actor = requestContext.tenantActor();
    const e = await tx.collection('employees').findOne({ id: employeeId });
    if (!e) throw Errors.notFound('Employee');
    if (e.status === 'exited') throw Errors.badRequest('employee_exited', 'This person has left');
    if (!v.isSuper) {
      // At hire the hire rules already checked this person may add the employee (to their HR Workspace).
      if (!opts.atHire && (!v.hr || !hrCovers(v, e, 'documents:manage'))) throw Errors.notFound('Employee');
      const a = v.hr ? (v.hr.companyWide ? v.book.get(null) : v.book.get((e.hr_workspace_id as string | null) ?? null)) : null;
      if (!a?.enabled || !a.request) throw Errors.forbidden('Super Workspace has not allowed your HR Workspace to request employee documents');
    }
    if (e.id === v.s.employeeId) throw Errors.badRequest('self_request', 'You cannot assign onboarding documents to yourself');
    await this.ensureLibrary(tx);
    const tpl = input.templateId ? await tx.collection('onboarding_doc_templates').findOne({ id: input.templateId, archived_at: null, active: true }) : undefined;
    if (input.templateId && !tpl) throw Errors.badRequest('unknown_template', 'Choose one of the onboarding templates');
    const items = await tx.collection('onboarding_doc_items').find({ id: { $in: input.itemIds }, archived_at: null, active: true });
    if (items.length !== input.itemIds.length) throw Errors.badRequest('unknown_document', 'A chosen document is no longer in the library');
    const tplItems = new Map(((tpl?.items ?? []) as { itemId: string; required: boolean }[]).map((x) => [x.itemId, x.required]));
    // Required documents of the template cannot be left out.
    const left = [...tplItems].filter(([itemId, req]) => req && !input.itemIds.includes(itemId));
    if (left.length) {
      const names = await tx.collection('onboarding_doc_items').find({ id: { $in: left.map(([x]) => x) }, archived_at: null });
      if (names.length) throw Errors.badRequest('required_documents', `${names.map((n) => n.name).join(', ')} ${names.length === 1 ? 'is' : 'are'} required by the template`);
    }
    const due = input.dueOn ?? null;
    if (due && due < istToday()) throw Errors.badRequest('past_deadline', 'The deadline cannot be in the past');

    const level = v.isSuper ? 'super_workspace' : 'hr_workspace';
    let cl = await tx.collection('onboarding_checklists').findOne({ employee_id: employeeId, status: 'active' });
    const adding = !!cl;
    if (!cl) {
      cl = await tx.collection('onboarding_checklists').insert({
        employee_id: employeeId, hr_workspace_id: e.hr_workspace_id ?? null, template_id: tpl?.id ?? null, template_name: (tpl?.name ?? null) as string | null, status: 'active',
        due_on: due, note: input.note ?? null, assigned_by_membership_id: actor.membershipId, requester_level: level,
      });
    }
    await tx.collection('onboarding_checklists').lock({ id: cl.id });
    const have = new Set(await tx.collection('document_requests').distinct<string>('library_item_id', { checklist_id: cl.id, status: { $ne: 'cancelled' } }));
    const requesterWs = v.isSuper || !v.hr || v.hr.companyWide ? null : (e.hr_workspace_id as string | null) ?? null;
    let added = 0;
    for (const it of items.sort((a, b) => (a.sort as number) - (b.sort as number))) {
      if (have.has(it.id as string)) continue;
      const type = builtInType(it.type_key as string) ?? builtInType('custom')!;
      const mandatory = tplItems.has(it.id as string) ? tplItems.get(it.id as string)! : it.requirement === 'mandatory';
      const guide = [it.description, it.instructions, `Accepted: ${(it.formats as RequestFileFormat[]).map((f) => REQUEST_FILE_LABEL[f]).join(', ')}; up to ${it.max_mb} MB${it.multiple ? ` per file, up to ${it.max_files} files` : ''}.`].filter(Boolean).join('\n');
      await this.center.insertRequest(tx, v, {
        type_key: type.key, doc_category: type.category, title: it.name, instructions: guide, reason: `Onboarding documents${mandatory ? ' (mandatory)' : ' (optional)'}${input.note ? `: ${input.note}` : ''}`,
        due_on: due, priority: mandatory ? 'high' : 'normal', formats: it.formats, max_mb: it.max_mb, expiry_required: false, replaces_document_id: null,
        requested_by_membership_id: actor.membershipId, requester_level: level, status: 'new_request', target_type: 'employee', employee_id: e.id, hr_workspace_id: e.hr_workspace_id ?? null,
        assignee_membership_id: e.membership_id ?? null, requester_hr_workspace_id: requesterWs,
        checklist_id: cl.id, library_item_id: it.id, mandatory, max_files: it.multiple ? it.max_files : 1,
      }, e, [], { quiet: true });
      added += 1;
    }
    if (!added && adding) throw Errors.conflict('nothing_new', 'Every chosen document is already on this checklist');
    await this.audit.record(tx, { action: adding ? 'onboarding_checklist.documents_added' : 'onboarding_checklist.assigned', resourceType: 'employee', resourceId: employeeId, metadata: { checklistId: cl.id, template: tpl?.name ?? null, documents: added } });
    const name = displayName(e as never);
    if (e.membership_id) {
      await this.notifications.notify(tx, {
        membershipIds: [e.membership_id], kind: adding ? 'onboarding.document_added' : 'onboarding.checklist_assigned',
        title: adding ? `${added} more onboarding document${added === 1 ? '' : 's'} to upload` : `Your onboarding checklist: ${added} document${added === 1 ? '' : 's'} to upload`,
        body: due ? `Please upload them before ${due}. HR checks each one.` : 'Upload each one from My Tasks. HR checks each one.',
        link: '/onboarding-documents/mine', email: true, priority: 'high', resource: { type: 'onboarding_checklist', id: cl.id as string }, dedupeKey: `onbdocs:${cl.id}:${added}:${adding ? 'add' : 'new'}`,
      });
    }
    if (!adding) {
      const admins = e.hr_workspace_id ? ((await hrWorkspaceAdmins(tx, [e.hr_workspace_id])).get(e.hr_workspace_id) ?? []) : [];
      await this.notifications.notify(tx, {
        membershipIds: [...new Set([actor.membershipId, ...admins])], kind: 'onboarding.created', title: `Onboarding created for ${name}`,
        body: `${added} document${added === 1 ? '' : 's'} assigned${tpl ? ` from ${tpl.name as string}` : ''}.`, link: `/onboarding-documents/${cl.id}`, resource: { type: 'onboarding_checklist', id: cl.id as string },
      });
    }
    await this.recompute(tx, cl.id as string);
    return cl.id as string;
  }

  /** Counts and completion for one checklist, after any change to its documents. */
  async recompute(tx: TenantTx, checklistId: string, changed?: Doc) {
    const cl = await tx.collection('onboarding_checklists').findOne({ id: checklistId });
    if (!cl || cl.status !== 'active') return;
    const reqs = await tx.collection('document_requests').find({ checklist_id: checklistId });
    const p = checklistProgress(reqs.map((r) => ({ status: onboardingDocStatus(r.status as DocumentRequestStatus), mandatory: !!r.mandatory })));
    const now = new Date();
    const set: Doc = { total: p.total, mandatory_total: p.mandatory, approved: p.approved, pending_approval: p.pendingApproval, percent: p.percent };
    const e = await tx.collection('employees').findOne({ id: cl.employee_id });
    const name = e ? displayName(e as never) : 'the employee';
    const hrPeople = async () => [...new Set([cl.assigned_by_membership_id, ...(cl.hr_workspace_id ? ((await hrWorkspaceAdmins(tx, [cl.hr_workspace_id])).get(cl.hr_workspace_id) ?? []) : [])])];
    // Every mandatory document sent (waiting for HR or approved): HR hears once.
    const mand = reqs.filter((r) => r.mandatory && r.status !== 'cancelled');
    const allSent = (mand.length ? mand : reqs.filter((r) => r.status !== 'cancelled')).every((r) => ['submitted', 'resubmitted', 'under_verification', 'completed'].includes(r.status));
    if (allSent && !cl.all_submitted_at && reqs.length) {
      set.all_submitted_at = now;
      await this.notifications.notify(tx, { membershipIds: await hrPeople(), kind: 'onboarding.all_submitted', title: `${name} has submitted every mandatory onboarding document`, body: 'They are waiting for your approval.', link: `/onboarding-documents/${checklistId}`, resource: { type: 'onboarding_checklist', id: checklistId } });
    }
    if (p.complete) {
      // Completed: off both sides' active lists, kept in the employee's onboarding history (archived, never deleted).
      Object.assign(set, { status: 'completed', completed_at: now, archived_at: now, percent: 100 });
      await this.audit.record(tx, { action: 'onboarding_checklist.completed', resourceType: 'employee', resourceId: cl.employee_id, metadata: { checklistId, documents: p.total, approved: p.approved } });
      if (e?.membership_id) await this.notifications.notify(tx, { membershipIds: [e.membership_id], kind: 'onboarding.completed', title: 'All your mandatory onboarding documents are approved', body: 'Your onboarding documents are complete. Thank you!', link: '/onboarding-documents/mine', email: true, resource: { type: 'onboarding_checklist', id: checklistId } });
      await this.notifications.notify(tx, { membershipIds: await hrPeople(), kind: 'onboarding.completed', title: `Onboarding documents completed for ${name}`, body: `${p.approved} of ${p.total} documents approved.`, link: `/onboarding-documents/${checklistId}`, resource: { type: 'onboarding_checklist', id: checklistId } });
    }
    await tx.collection('onboarding_checklists').updateOne({ id: checklistId }, { $set: set });
    await this.notifications.signal(tx, [e?.membership_id, cl.assigned_by_membership_id, changed?.requested_by_membership_id], 'documents.changed', { checklistId });
  }

  // Views -------------------------------------------------------------------------------------------------------

  private async mayRead(tx: TenantTx, v: Viewer, cl: Doc): Promise<boolean> {
    if (v.isSuper) return true;
    if (v.s.employeeId && cl.employee_id === v.s.employeeId) return true;
    if (!v.hr) return false;
    const e = await tx.collection('employees').findOne({ id: cl.employee_id });
    return !!e && hrCovers(v, e) && !!accessFor(v, (e.hr_workspace_id as string | null) ?? null)?.enabled;
  }

  private async checklistView(tx: TenantTx, v: Viewer, cl: Doc) {
    const reqs = await tx.collection('document_requests').find({ checklist_id: cl.id }, { sort: { created_at: 1 } });
    const items = new Map((await tx.collection('onboarding_doc_items').find({ id: { $in: reqs.map((r) => r.library_item_id).filter(Boolean) } })).map((i) => [i.id as string, i]));
    const docs = new Map((await tx.collection('employee_documents').find({ id: { $in: reqs.flatMap((r) => [r.document_id, ...((r.extra_document_ids ?? []) as string[])]).filter(Boolean) } }, { projection: { file_name: 1, size_bytes: 1, content_type: 1, version: 1 } })).map((d) => [d.id as string, d]));
    const e = await tx.collection('employees').findOne({ id: cl.employee_id });
    const mine = !!v.s.employeeId && v.s.employeeId === cl.employee_id;
    const rows = reqs.map((r) => {
      const it = items.get(r.library_item_id);
      const status = onboardingDocStatus(r.status as DocumentRequestStatus, (r.submissions ?? 0) > 0);
      const files = [r.document_id, ...((r.extra_document_ids ?? []) as string[])].filter(Boolean).map((id) => docs.get(id)).filter((d): d is Doc => !!d)
        .map((d) => ({ id: d.id as string, fileName: d.file_name as string, sizeBytes: d.size_bytes as number, contentType: d.content_type as string, version: (d.version ?? 1) as number }));
      return {
        requestId: r.id as string, taskId: (r.task_id ?? null) as string | null, reference: r.reference as string, title: r.title as string,
        description: (it?.description ?? null) as string | null, instructions: (it?.instructions ?? r.instructions ?? null) as string | null, verification: mine ? null : ((it?.verification ?? null) as string | null),
        requirement: ((it?.requirement ?? (r.mandatory ? 'mandatory' : 'optional')) as OnboardingRequirement), mandatory: !!r.mandatory,
        formats: (r.formats ?? []) as RequestFileFormat[], maxMb: r.max_mb as number, maxFiles: (r.max_files ?? 1) as number, expiryRequired: !!r.expiry_required, category: (it?.category_id ?? null) as string | null,
        status, statusLabel: ONBOARDING_DOC_STATUS_LABEL[status], approved: status === 'approved',
        hrComment: (r.reviewer_comment ?? null) as string | null, submissions: (r.submissions ?? 0) as number,
        lastSubmittedAt: iso(r.submitted_at), decidedAt: iso(r.decided_at), dueOn: (r.due_on ?? null) as string | null, files,
      };
    });
    const cats = await fieldById(tx, 'onboarding_doc_categories', rows.map((r) => r.category));
    const p = checklistProgress(rows.map((r) => ({ status: r.status, mandatory: r.mandatory })));
    const ws = cl.hr_workspace_id ? (await fieldById(tx, 'hr_workspaces', [cl.hr_workspace_id])).get(cl.hr_workspace_id) ?? null : null;
    return {
      id: cl.id as string, status: cl.status as 'active' | 'completed' | 'cancelled', templateName: (cl.template_name ?? null) as string | null,
      employee: e ? { id: e.id as string, name: displayName(e as never), code: (e.employee_code ?? null) as string | null, status: e.status as string, dateOfJoining: e.date_of_joining as string } : null,
      hrWorkspace: ws, dueOn: (cl.due_on ?? null) as string | null, note: (cl.note ?? null) as string | null,
      assignedAt: iso(cl.created_at)!, completedAt: iso(cl.completed_at), allSubmittedAt: iso(cl.all_submitted_at), progress: p,
      items: rows.map((r) => ({ ...r, categoryName: r.category ? cats.get(r.category) ?? null : null })),
      mine, canReview: !mine && (v.isSuper || !!v.hr),
    };
  }

  /** HR's consolidated list: every checklist the viewer may see, with each employee's progress. */
  async list(q: { status?: 'active' | 'completed'; q?: string; hrWorkspaceId?: string; pending?: boolean }) {
    return this.db.tenant(async (tx) => {
      const v = await this.requireHrOrSuper(tx);
      const filter: Doc = { status: q.status ?? 'active' };
      if (q.hrWorkspaceId) filter.hr_workspace_id = q.hrWorkspaceId;
      if (q.pending) filter.pending_approval = { $gt: 0 };
      if (q.q?.trim()) {
        const words = q.q.trim().split(/\s+/).slice(0, 4);
        const ids = await tx.collection('employees').distinct<string>('id', { $and: words.map((w) => ({ $or: [{ first_name: ilike(w) }, { last_name: ilike(w) }, { employee_code: ilike(w) }] })) });
        filter.employee_id = { $in: ids };
      }
      const rows = await tx.collection('onboarding_checklists').find(filter, { sort: { pending_approval: -1, created_at: -1 }, limit: 300 });
      const emps = new Map((await tx.collection('employees').find({ id: { $in: rows.map((r) => r.employee_id) } })).map((e) => [e.id as string, e]));
      const visible = v.isSuper ? rows : rows.filter((r) => { const e = emps.get(r.employee_id); return !!e && hrCovers(v, e) && !!accessFor(v, (e.hr_workspace_id as string | null) ?? null)?.enabled; });
      const depts = await fieldById(tx, 'departments', [...emps.values()].map((e) => e.current_department_id));
      const ws = await fieldById(tx, 'hr_workspaces', visible.map((r) => r.hr_workspace_id));
      const all = await tx.collection('onboarding_checklists').find(v.isSuper ? { status: 'active' } : { status: 'active', id: { $in: visible.map((x) => x.id) } }, { projection: { pending_approval: 1 } });
      return {
        rows: visible.map((r) => {
          const e = emps.get(r.employee_id)!;
          return {
            id: r.id as string, status: r.status as string, employee: { id: e.id as string, name: displayName(e as never), code: (e.employee_code ?? null) as string | null, department: e.current_department_id ? depts.get(e.current_department_id) ?? null : null, dateOfJoining: e.date_of_joining as string },
            hrWorkspace: r.hr_workspace_id ? ws.get(r.hr_workspace_id) ?? null : null, templateName: (r.template_name ?? null) as string | null,
            total: r.total as number, approved: r.approved as number, pendingApproval: r.pending_approval as number, percent: r.percent as number, mandatory: r.mandatory_total as number,
            dueOn: (r.due_on ?? null) as string | null, assignedAt: iso(r.created_at)!, completedAt: iso(r.completed_at),
          };
        }),
        totals: { active: q.status === 'completed' ? all.length : visible.length, pendingApproval: all.reduce((s, x) => s + ((x.pending_approval as number) ?? 0), 0) },
      };
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const v = await this.center.viewerIn(tx);
      const cl = await tx.collection('onboarding_checklists').findOne({ id });
      if (!cl || !(await this.mayRead(tx, v, cl))) throw Errors.notFound('Onboarding checklist');
      return this.checklistView(tx, v, cl);
    });
  }

  /** The employee's own onboarding documents: the active checklist and the completed ones (history). */
  async mine() {
    return this.db.tenant(async (tx) => {
      const v = await this.center.viewerIn(tx);
      if (!v.s.employeeId) return { active: null, history: [] };
      const rows = await tx.collection('onboarding_checklists').find({ employee_id: v.s.employeeId }, { sort: { created_at: -1 } });
      const active = rows.find((r) => r.status === 'active');
      return {
        active: active ? await this.checklistView(tx, v, active) : null,
        history: await Promise.all(rows.filter((r) => r.status !== 'active').map((r) => this.checklistView(tx, v, r))),
      };
    });
  }

  /** Every checklist of one employee (their onboarding history), for the profile. */
  async forEmployee(employeeId: string) {
    return this.db.tenant(async (tx) => {
      const v = await this.center.viewerIn(tx);
      const rows = await tx.collection('onboarding_checklists').find({ employee_id: employeeId }, { sort: { created_at: -1 } });
      const out = [];
      for (const r of rows) if (await this.mayRead(tx, v, r)) out.push(await this.checklistView(tx, v, r));
      return out;
    });
  }
}

function slug(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'document';
}

function itemRow(input: LibraryItemInput) {
  return {
    category_id: input.categoryId, name: input.name, requirement: input.requirement, description: input.description ?? null, instructions: input.instructions ?? null,
    formats: input.formats, max_mb: input.maxMb, multiple: input.multiple, max_files: input.multiple ? input.maxFiles : 1, verification: input.verification ?? null,
    sensitive: input.sensitive, active: input.active,
  };
}

function templateRow(input: LibraryTemplateInput) {
  return { name: input.name, description: input.description ?? null, items: input.items, department_ids: input.departmentIds, employment_types: input.employmentTypes, is_default: input.isDefault, active: input.active };
}

function itemView(i: Doc) {
  return {
    id: i.id as string, key: i.key as string, categoryId: i.category_id as string, name: i.name as string, requirement: i.requirement as OnboardingRequirement,
    requirementLabel: ONBOARDING_REQUIREMENT_LABEL[i.requirement as OnboardingRequirement], description: (i.description ?? null) as string | null, instructions: (i.instructions ?? null) as string | null,
    formats: (i.formats ?? []) as RequestFileFormat[], maxMb: i.max_mb as number, multiple: !!i.multiple, maxFiles: (i.max_files ?? 1) as number,
    verification: (i.verification ?? null) as string | null, sensitive: !!i.sensitive, active: !!i.active, builtIn: !!i.built_in,
  };
}
