import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  accessLevelOf, ACCESS_LEVEL_LABEL, AWAITING_REVIEW, AWAITING_SUBMISSION, builtInType, BUILT_IN_DOCUMENT_TYPES, DOCUMENT_ACCESS_KEYS, DOCUMENT_ACCESS_SWITCHES, DOCUMENT_GROUPS,
  DOCUMENT_GROUP_LABEL, DOCUMENT_REQUEST_STATUS_LABEL, DOCUMENT_STATUS_LABEL, LEGACY_CATEGORY_GROUP, legacyCategoriesOf, OPEN_REQUEST_STATUSES, REQUEST_FILE_FORMATS, requestDisplayStatus, effectiveDocumentAccess,
  type documentAccessInput, type documentCategoryInput, type documentDecisionInput, type DocumentRequestInput, type documentRequestQuery, type DocumentRepositoryQuery,
  type DocumentRequestStatus, type documentSubmitMeta, type documentTypeInput, type DocumentTypeDef, type RequestFileFormat, type DocumentAccess,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { scopeFilter, type Subject } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { ilike, MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { StorageService } from '../../platform/storage/storage.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { DocumentsService, type UploadedFile } from '../documents/documents.service';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { displayName, fieldById } from '../employees/employee-view';
import {
  accessFor, allowedStatuses, CENTRAL, companyWideHr, type Doc, type DocLevel, employeeAttrsOf, hrCovers, hrInfo, hrWorkspaceAdmins, levelGrants, loadAccessBook, refOf, sharedAccess,
  statusAllowed, statusOf, type Viewer, viewerOf,
} from './document-access';

const TASK_FORMAT: Record<RequestFileFormat, string | null> = { pdf: 'pdf', image: 'image', word: 'word', excel: null };
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : (d as string | null | undefined) ?? null);
const DECISION_KEY = Symbol('documents.decision');

/** Employees whose name or code matches every word typed ("Kunal Sharma", "sharma", "EMP-0042"). */
function nameFilter(q: string): Doc {
  const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  return { $and: words.map((w) => ({ $or: [{ first_name: ilike(w) }, { last_name: ilike(w) }, { preferred_name: ilike(w) }, { employee_code: ilike(w) }] })) };
}

/** The task status a request status shows as on My Tasks. */
const TASK_STATUS_OF: Record<DocumentRequestStatus, string> = {
  new_request: 'new', pending_submission: 'not_started', submitted: 'pending_review', resubmitted: 'pending_review', under_verification: 'pending_review',
  correction_required: 'reopened', rejected: 'reopened', completed: 'completed', cancelled: 'cancelled',
};

interface Person { name: string | null; level: string | null; designation: string | null }

/**
 * Centralized document management: document requests (Super Workspace or an HR Workspace asks a person or an HR
 * Workspace for a document), their tasks, verification through the approvals engine, the Documents section of every
 * profile, the company-wide repository, Super Workspace's document access switches for each HR Workspace, and the
 * activity history. Every file is one employee_documents row, reached from the task, the approval and the profile.
 * Every read and action is checked here, on the server, for the person asking.
 */
@Injectable()
export class DocumentCenterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DocumentCenterService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly approvals: ApprovalsService,
    private readonly documents: DocumentsService,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    this.approvals.register('document_request', {
      permission: 'documents:manage',
      configurePermission: 'tenant:manage',
      defaultSteps: [{ type: 'role', role: 'hr_workspace' }],
      fallbackRole: 'super_workspace',
      label: 'Document verification',
      quiet: true,
      link: (id) => `/documents/requests/${id}`,
      attributes: async (tx, id) => {
        const r = await tx.collection('document_requests').findOne({ id });
        if (!r) throw Errors.notFound('Document request');
        if (r.employee_id) {
          const e = await tx.collection('employees').findOne({ id: r.employee_id });
          if (e) return employeeAttrsOf(e);
        }
        return {};
      },
      decider: (tx, id, s) => this.mayVerify(tx, id, s),
      details: async (tx, id) => {
        const r = await tx.collection('document_requests').findOne({ id });
        if (!r) return null;
        const d = r.document_id ? await tx.collection('employee_documents').findOne({ id: r.document_id }) : undefined;
        return { request: r.reference, document: r.title, fileName: d?.file_name ?? null, documentId: d?.id ?? null, version: d?.version ?? null, requestedBy: ACCESS_LEVEL_LABEL[r.requester_level as 'super_workspace'], reason: r.reason };
      },
      documents: async (tx, id) => {
        const r = await tx.collection('document_requests').findOne({ id }, { projection: { document_id: 1 } });
        const d = r?.document_id ? await tx.collection('employee_documents').findOne({ id: r.document_id }, { projection: { file_name: 1, title: 1 } }) : undefined;
        return d ? [{ name: (d.file_name as string) ?? 'Document', href: `/files/${d.id}` }] : [];
      },
      onApproved: (tx, req) => this.decided(tx, req.resource_id, 'approve', req.comment ?? null),
      onRejected: (tx, req) => this.decided(tx, req.resource_id, 'reject', req.comment ?? null),
    });
    if (this.config.CREW_DISABLE_DISPATCHER === 'true' || this.config.CREW_ENV === 'test') return;
    const tick = () => void this.sweepAll().catch((err: Error) => this.logger.error(`Document reminders failed: ${err.message}`));
    this.timer = setInterval(tick, 60 * 60 * 1000);
    this.timer.unref();
    setTimeout(tick, 60_000).unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // People, names and labels -------------------------------------------------------------------------------------

  private async people(tx: TenantTx, membershipIds: unknown[]): Promise<Map<string, Person>> {
    const ids = [...new Set(membershipIds.filter((x): x is string => typeof x === 'string'))];
    const out = new Map<string, Person>();
    if (!ids.length) return out;
    const names = await membershipUserNames(tx, ids);
    const ms = await tx.collection('memberships').find({ id: { $in: ids } }, { projection: { employee_id: 1 } });
    const emps = new Map((await tx.collection('employees').find({ id: { $in: ms.map((m) => m.employee_id).filter(Boolean) } }, { projection: { current_designation_id: 1, first_name: 1, last_name: 1, preferred_name: 1 } })).map((e) => [e.id as string, e]));
    const desig = await fieldById(tx, 'designations', [...emps.values()].map((e) => e.current_designation_id));
    const roles = new Map((await tx.collection('roles').find({ is_system: true, key: { $in: ['super_workspace', 'hr_workspace', 'employee_workspace'] } })).map((r) => [r.id as string, r.key as string]));
    const assigned = await tx.collection('role_assignments').find({ membership_id: { $in: ids }, role_id: { $in: [...roles.keys()] } }, { projection: { membership_id: 1, role_id: 1 } });
    for (const m of ms) {
      const e = m.employee_id ? emps.get(m.employee_id) : undefined;
      const keys = assigned.filter((a) => a.membership_id === m.id).map((a) => roles.get(a.role_id)!);
      const level = accessLevelOf(keys);
      out.set(m.id as string, {
        name: names.get(m.id) ?? (e ? displayName(e as never) : null),
        level: level === 'super' ? 'Super Workspace' : level === 'hr' ? 'HR Workspace' : 'Employee Workspace',
        designation: e ? desig.get(e.current_designation_id) ?? null : null,
      });
    }
    return out;
  }

  private async catalogue(tx: TenantTx) {
    const custom = await tx.collection('document_types').find({ active: true }, { sort: { name: 1 } });
    const categories = await tx.collection('document_categories').find({ active: true }, { sort: { name: 1 } });
    const types: DocumentTypeDef[] = [
      ...BUILT_IN_DOCUMENT_TYPES,
      ...custom.map((c) => ({ key: c.key as string, name: c.name as string, category: c.category as string, sensitive: !!c.sensitive, owners: (c.owners ?? ['employee']) as DocumentTypeDef['owners'], legacy: 'other' as const, builtIn: false })),
    ];
    const groups = [
      ...DOCUMENT_GROUPS.map((g) => ({ key: g as string, name: DOCUMENT_GROUP_LABEL[g], description: null as string | null, builtIn: true })),
      ...categories.map((c) => ({ key: c.key as string, name: c.name as string, description: (c.description ?? null) as string | null, builtIn: false })),
    ];
    return { types, groups, typeOf: (key: string | null | undefined) => types.find((x) => x.key === key), groupName: (key: string | null | undefined) => groups.find((g) => g.key === key)?.name ?? DOCUMENT_GROUP_LABEL.other };
  }

  private requesterLabel(level: string, wsName: string | null) {
    return level === 'super_workspace' ? 'Super Workspace' : wsName ? `HR Workspace (${wsName})` : 'HR Workspace';
  }

  private async viewer(tx: TenantTx): Promise<Viewer> {
    return viewerOf(tx, await this.authz.subject(tx));
  }

  /** Records one entry in the document's activity (append only) and returns nothing. */
  private async activity(tx: TenantTx, v: Viewer | null, e: { action: string; documentId?: string | null; requestId?: string | null; taskId?: string | null; approvalId?: string | null; employeeId?: string | null; hrWorkspaceId?: string | null; comment?: string | null; metadata?: Doc }) {
    const actor = requestContext.get()?.actor;
    const user = actor?.kind === 'user' ? actor : null;
    await tx.collection('document_activity').insert({
      action: e.action, document_id: e.documentId ?? null, request_id: e.requestId ?? null, task_id: e.taskId ?? null, approval_request_id: e.approvalId ?? null,
      employee_id: e.employeeId ?? null, hr_workspace_id: e.hrWorkspaceId ?? null, actor_membership_id: user?.membershipId ?? null, actor_user_id: user?.userId ?? null,
      actor_level: v ? v.level : user ? 'employee_workspace' : 'system',
      actor_hr_workspace_id: v?.hr && !v.hr.companyWide ? v.hr.workspaceIds[0] ?? null : null,
      comment: e.comment ?? null, metadata: e.metadata ?? {},
    });
  }

  // Who may see what ------------------------------------------------------------------------------------------------

  /** What the viewer may do with one document, or null when they may not see it at all. */
  private docRights(v: Viewer, d: Doc, owner: Doc | undefined): null | { preview: boolean; download: boolean; via: 'self' | 'super' | 'hr' | 'shared' | 'manager' | 'hr_admin' } {
    if (v.isSuper) return { preview: true, download: true, via: 'super' };
    if (d.owner_type === 'hr_workspace') {
      const a = accessFor(v, d.hr_workspace_id);
      if (a?.view_hr_documents) return { preview: a.preview, download: a.download, via: 'hr_admin' };
      const sh = sharedAccess(v, d.hr_workspace_id);
      if (sh) return { preview: sh.preview, download: sh.download, via: 'shared' };
      return null;
    }
    if (v.s.employeeId && d.employee_id === v.s.employeeId) return d.visibility === 'hr_only' ? null : { preview: true, download: true, via: 'self' };
    if (owner && hrCovers(v, owner)) {
      const a = accessFor(v, owner.hr_workspace_id ?? null) ?? (v.hr?.companyWide ? null : v.book.get(owner.hr_workspace_id ?? null));
      if (a && a.enabled && statusAllowed(a, statusOf(d))) return { preview: a.preview, download: a.download, via: 'hr' };
      return null;
    }
    const sh = owner ? sharedAccess(v, owner.hr_workspace_id ?? null) : null;
    if (sh && statusAllowed(sh, statusOf(d))) return { preview: sh.preview, download: sh.download, via: 'shared' };
    // Managers keep what they had: their team's documents the employee can see.
    if (owner && d.visibility !== 'hr_only' && levelGrants(v.s, 'employee_workspace', 'documents:read').some(() => true)) {
      const team = { ...v.s, grants: levelGrants(v.s, 'employee_workspace', 'documents:read').filter((g) => g.scope !== 'own') };
      const attrs = employeeAttrsOf(owner);
      if (team.grants.some((g) => g.scope === 'team' && ((attrs.employeeId && team.reportEmployeeIds?.has(attrs.employeeId)) || (attrs.membershipId && team.reportIds.has(attrs.membershipId))))) {
        return { preview: true, download: true, via: 'manager' };
      }
    }
    return null;
  }

  /**
   * A database filter for the documents the viewer may see (before the page's own filters), so lists are filtered
   * in the database. Mirrors docRights.
   */
  private async visibleFilter(tx: TenantTx, v: Viewer): Promise<Doc> {
    if (v.isSuper) return {};
    const or: Doc[] = [];
    if (v.s.employeeId) or.push({ employee_id: v.s.employeeId, visibility: { $ne: 'hr_only' } });
    if (v.hr) {
      const hrS = { ...v.s, grants: levelGrants(v.s, 'hr_workspace', 'documents:read') };
      const scope = scopeFilter(hrS, 'documents:read', EMPLOYEE_FIELDS);
      if (scope) {
        const emps = await tx.collection('employees').find(scope, { projection: { _id: 1, hr_workspace_id: 1 } });
        const by = new Map<string, string[]>();
        for (const e of emps) {
          const key = v.hr.companyWide ? CENTRAL : (e.hr_workspace_id as string | null) ?? CENTRAL;
          by.set(key, [...(by.get(key) ?? []), e.id as string]);
        }
        for (const [key, ids] of by) {
          const a = v.hr.companyWide ? v.book.get(null) : v.book.get(key === CENTRAL ? null : key);
          if (!a.enabled) continue;
          or.push({ owner_type: 'employee', employee_id: { $in: ids.filter((x) => x !== v.s.employeeId) }, verification_status: { $in: allowedStatuses(a) } });
        }
      }
      const own = v.hr.companyWide ? await tx.collection('hr_workspaces').distinct<string>('id', {}) : v.hr.workspaceIds;
      const hrDocs = own.filter((w) => accessFor(v, w)?.view_hr_documents);
      if (hrDocs.length) or.push({ owner_type: 'hr_workspace', hr_workspace_id: { $in: hrDocs } });
      for (const scopeKey of v.hr.companyWide ? [CENTRAL] : v.hr.workspaceIds) {
        const a = v.book.get(scopeKey === CENTRAL ? null : scopeKey);
        if (!a.view_other_hr) continue;
        const shared = v.book.shared(scopeKey === CENTRAL ? null : scopeKey).filter((x) => x !== scopeKey);
        if (!shared.length) continue;
        const ids = await tx.collection('employees').distinct<string>('id', { hr_workspace_id: { $in: shared } });
        or.push({ owner_type: 'employee', employee_id: { $in: ids }, verification_status: { $in: allowedStatuses(a) } });
        or.push({ owner_type: 'hr_workspace', hr_workspace_id: { $in: shared } });
      }
    } else {
      // Managers: their team's documents the employee can see.
      const team = levelGrants(v.s, 'employee_workspace', 'documents:read').filter((g) => g.scope === 'team');
      if (team.length && v.s.reportEmployeeIds?.size) or.push({ employee_id: { $in: [...v.s.reportEmployeeIds] }, visibility: { $ne: 'hr_only' } });
    }
    return or.length ? { $or: or } : { _id: { $in: [] } };
  }

  /** Loads one document the viewer may see (404 otherwise: a direct link never reveals that it exists). */
  private async loadDoc(tx: TenantTx, v: Viewer, id: string) {
    const d = await tx.collection('employee_documents').findOne({ id, archived_at: null });
    if (!d) throw Errors.notFound('Document');
    const owner = d.employee_id ? await tx.collection('employees').findOne({ id: d.employee_id }) : undefined;
    const rights = this.docRights(v, d, owner);
    if (!rights) throw Errors.notFound('Document');
    return { d, owner, rights };
  }

  // Views ---------------------------------------------------------------------------------------------------------

  private async docViews(tx: TenantTx, v: Viewer, docs: Doc[]) {
    const cat = await this.catalogue(tx);
    const owners = new Map((await tx.collection('employees').find({ id: { $in: docs.map((d) => d.employee_id).filter(Boolean) } })).map((e) => [e.id as string, e]));
    const ws = await fieldById(tx, 'hr_workspaces', [...docs.map((d) => d.hr_workspace_id), ...[...owners.values()].map((e) => e.hr_workspace_id)]);
    const reqs = new Map((await tx.collection('document_requests').find({ id: { $in: docs.map((d) => d.request_id).filter(Boolean) } })).map((r) => [r.id as string, r]));
    const people = await this.people(tx, [...docs.flatMap((d) => [d.uploaded_by_membership_id, d.verified_by_membership_id]), ...[...reqs.values()].map((r) => r.requested_by_membership_id)]);
    const today = istToday();
    return docs.map((d) => {
      const owner = d.employee_id ? owners.get(d.employee_id) : undefined;
      const r = d.request_id ? reqs.get(d.request_id) : undefined;
      const type = cat.typeOf(d.type_key);
      const rights = this.docRights(v, d, owner) ?? { preview: false, download: false, via: 'none' };
      const expired = !!d.expired_at || (!!d.expires_on && d.expires_on < today && d.verification_status === 'verified');
      const status = d.superseded_at ? 'superseded' : expired ? 'expired' : statusOf(d);
      const sensitive = type?.sensitive ?? d.category === 'id_proof';
      const ext = String(d.file_name ?? '').includes('.') ? String(d.file_name).split('.').pop() : '';
      const by = people.get(d.uploaded_by_membership_id);
      const verifier = people.get(d.verified_by_membership_id);
      const requester = r ? people.get(r.requested_by_membership_id) : undefined;
      return {
        id: d.id as string,
        reference: (d.reference ?? refOf('DOC', d.id)) as string,
        title: d.title as string,
        typeKey: (d.type_key ?? null) as string | null,
        typeName: type?.name ?? null,
        // `category` keeps the original profile category (the phone app and earlier screens read it); `group` is the
        // document group the central repository filters by.
        category: d.category as string,
        group: (d.doc_category ?? type?.category ?? LEGACY_CATEGORY_GROUP[d.category as 'other'] ?? 'other') as string,
        categoryName: cat.groupName(d.doc_category ?? type?.category ?? LEGACY_CATEGORY_GROUP[d.category as 'other'] ?? 'other'),
        fileName: sensitive && !rights.download ? `•••• (protected).${ext}` : (d.file_name as string),
        contentType: d.content_type as string,
        sizeBytes: d.size_bytes as number,
        sensitive,
        visibility: d.visibility as string,
        ownerType: (d.owner_type ?? 'employee') as 'employee' | 'hr_workspace',
        employee: owner ? { id: owner.id as string, name: displayName(owner as never), code: (owner.employee_code ?? null) as string | null } : null,
        hrWorkspace: (d.hr_workspace_id ?? owner?.hr_workspace_id) ? { id: (d.hr_workspace_id ?? owner?.hr_workspace_id) as string, name: ws.get(d.hr_workspace_id ?? owner?.hr_workspace_id) ?? null } : null,
        submittedBy: by?.name ?? null,
        requestedBy: r ? { level: r.requester_level as string, label: this.requesterLabel(r.requester_level, r.requester_hr_workspace_id ? ws.get(r.requester_hr_workspace_id) ?? null : null), name: requester?.name ?? null, designation: requester?.designation ?? null } : null,
        requestId: (d.request_id ?? null) as string | null,
        requestReference: (r?.reference ?? null) as string | null,
        status,
        statusLabel: DOCUMENT_STATUS_LABEL[status] ?? status,
        verificationStatus: (d.verification_status ?? null) as string | null,
        verificationRemarks: (d.verification_remarks ?? null) as string | null,
        verifiedBy: verifier ? { name: verifier.name, designation: verifier.designation, level: verifier.level } : null,
        verifiedAt: iso(d.verified_at),
        expiresOn: (d.expires_on ?? null) as string | null,
        expired,
        version: (d.version ?? 1) as number,
        previousDocumentId: (d.previous_document_id ?? null) as string | null,
        supersededAt: iso(d.superseded_at),
        taskId: (d.task_id ?? null) as string | null,
        createdAt: iso(d.created_at)!,
        updatedAt: iso(d.verified_at ?? d.created_at)!,
        can: { preview: rights.preview, download: rights.download },
        // Fields the earlier profile tab and the phone app read.
        employeeId: (d.employee_id ?? null) as string | null,
        uploadedBy: by?.name ?? null,
        sha256: d.sha256 as string,
      };
    });
  }

  private async requestViews(tx: TenantTx, v: Viewer, rows: Doc[], opts: { approvers?: boolean } = {}) {
    const cat = await this.catalogue(tx);
    const emps = new Map((await tx.collection('employees').find({ id: { $in: rows.map((r) => r.employee_id).filter(Boolean) } })).map((e) => [e.id as string, e]));
    const ws = await fieldById(tx, 'hr_workspaces', rows.flatMap((r) => [r.hr_workspace_id, r.requester_hr_workspace_id]));
    const docs = new Map((await tx.collection('employee_documents').find({ id: { $in: rows.map((r) => r.document_id).filter(Boolean) } })).map((d) => [d.id as string, d]));
    const people = await this.people(tx, rows.flatMap((r) => [r.requested_by_membership_id, r.assignee_membership_id, r.submitted_by_membership_id, r.reviewer_membership_id]));
    const me = requestContext.tenantActor().membershipId;
    const today = istToday();
    const out = [];
    for (const r of rows) {
      const e = r.employee_id ? emps.get(r.employee_id) : undefined;
      const d = r.document_id ? docs.get(r.document_id) : undefined;
      const requester = people.get(r.requested_by_membership_id);
      const approvers = opts.approvers && r.approval_request_id && AWAITING_REVIEW.includes(r.status) ? await this.approvals.approversOf(tx, r.approval_request_id) : [];
      const display = requestDisplayStatus(r.status, r.due_on ?? null, today);
      out.push({
        id: r.id as string,
        reference: r.reference as string,
        targetType: r.target_type as 'employee' | 'hr_workspace',
        employee: e ? { id: e.id as string, name: displayName(e as never), code: (e.employee_code ?? null) as string | null } : null,
        hrWorkspace: r.hr_workspace_id ? { id: r.hr_workspace_id as string, name: ws.get(r.hr_workspace_id) ?? null } : null,
        assignee: r.assignee_membership_id ? { membershipId: r.assignee_membership_id as string, name: people.get(r.assignee_membership_id)?.name ?? null } : null,
        typeKey: r.type_key as string,
        typeName: cat.typeOf(r.type_key)?.name ?? r.title,
        category: r.doc_category as string,
        categoryName: cat.groupName(r.doc_category),
        title: r.title as string,
        instructions: (r.instructions ?? null) as string | null,
        reason: r.reason as string,
        dueOn: (r.due_on ?? null) as string | null,
        priority: r.priority as string,
        formats: (r.formats ?? []) as RequestFileFormat[],
        maxMb: r.max_mb as number,
        expiryRequired: !!r.expiry_required,
        replacesDocumentId: (r.replaces_document_id ?? null) as string | null,
        requestedBy: { level: r.requester_level as string, label: this.requesterLabel(r.requester_level, r.requester_hr_workspace_id ? ws.get(r.requester_hr_workspace_id) ?? null : null), name: requester?.name ?? null, designation: requester?.designation ?? null, accessLevel: requester?.level ?? null, membershipId: r.requested_by_membership_id as string },
        status: r.status as DocumentRequestStatus,
        displayStatus: display,
        statusLabel: DOCUMENT_REQUEST_STATUS_LABEL[display],
        overdue: display === 'overdue',
        document: d ? { id: d.id as string, reference: (d.reference ?? refOf('DOC', d.id)) as string, fileName: d.file_name as string, version: (d.version ?? 1) as number, status: statusOf(d), sizeBytes: d.size_bytes as number, contentType: d.content_type as string, expiresOn: (d.expires_on ?? null) as string | null } : null,
        submittedAt: iso(r.submitted_at),
        submittedBy: r.submitted_by_membership_id ? people.get(r.submitted_by_membership_id)?.name ?? null : null,
        submissions: (r.submissions ?? 0) as number,
        reviewer: r.reviewer_membership_id ? { name: people.get(r.reviewer_membership_id)?.name ?? null, designation: people.get(r.reviewer_membership_id)?.designation ?? null } : null,
        reviewerComment: (r.reviewer_comment ?? null) as string | null,
        decidedAt: iso(r.decided_at),
        completedAt: iso(r.completed_at),
        cancelledReason: (r.cancelled_reason ?? null) as string | null,
        taskId: (r.task_id ?? null) as string | null,
        approvalRequestId: (r.approval_request_id ?? null) as string | null,
        createdAt: iso(r.created_at)!,
        isMine: await this.isTarget(tx, v, r),
        raisedByMe: r.requested_by_membership_id === me,
        canReview: approvers.includes(me),
      });
    }
    return out;
  }

  // Request access ------------------------------------------------------------------------------------------------

  /** Is the viewer the one who must submit this request (the employee, or an admin of the HR Workspace asked)? */
  private async isTarget(tx: TenantTx, v: Viewer, r: Doc): Promise<boolean> {
    if (r.target_type === 'employee') return !!v.s.employeeId && v.s.employeeId === r.employee_id;
    if (r.assignee_membership_id === v.s.membershipId) return true;
    return !!v.hr && !v.hr.companyWide && v.hr.workspaceIds.includes(r.hr_workspace_id);
  }

  private async mayReadRequest(tx: TenantTx, v: Viewer, r: Doc): Promise<boolean> {
    if (v.isSuper || r.requested_by_membership_id === v.s.membershipId || (await this.isTarget(tx, v, r))) return true;
    if (!v.hr) return false;
    if (r.requester_level === 'hr_workspace' && (r.requester_hr_workspace_id ? accessFor(v, r.requester_hr_workspace_id) : v.hr.companyWide ? v.book.get(null) : null)?.enabled) return true;
    if (r.target_type === 'employee') {
      const e = await tx.collection('employees').findOne({ id: r.employee_id });
      const a = e && hrCovers(v, e) ? accessFor(v, e.hr_workspace_id ?? null) : null;
      return !!a && (a.view_pending || a.view_employee);
    }
    return !!accessFor(v, r.hr_workspace_id)?.view_hr_documents;
  }

  private async loadRequest(tx: TenantTx, v: Viewer, id: string) {
    const r = await tx.collection('document_requests').findOne({ id });
    if (!r || !(await this.mayReadRequest(tx, v, r))) throw Errors.notFound('Document request');
    return r;
  }

  /**
   * May this person verify the request's submission? The level that asked verifies: Super Workspace for its own
   * requests; for an HR Workspace's request, that HR Workspace's people (company-wide HR for the central group) while
   * Super Workspace's switches let them verify. Called by the approvals engine with the person's grants on that level.
   */
  private async mayVerify(tx: TenantTx, requestId: string, s: Subject): Promise<boolean> {
    const r = await tx.collection('document_requests').findOne({ id: requestId });
    if (!r) return false;
    if (r.requester_level === 'super_workspace') return levelGrants(s, 'super_workspace', 'documents:manage').length > 0;
    if (levelGrants(s, 'super_workspace', 'documents:manage').length) return true;
    const hr = hrInfo(s, 'documents:manage');
    if (!hr) return false;
    const book = await loadAccessBook(tx);
    const ws = r.requester_hr_workspace_id as string | null;
    const a = hr.companyWide ? book.get(null) : ws && hr.workspaceIds.includes(ws) ? book.get(ws) : null;
    return !!a?.verify;
  }

  // Catalogue -----------------------------------------------------------------------------------------------------

  async getCatalogue() {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const c = await this.catalogue(tx);
      return { groups: c.groups, types: c.types, canManage: v.isSuper };
    });
  }

  async addCategory(input: z.infer<typeof documentCategoryInput>) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      if (!v.isSuper) throw Errors.forbidden('Only Super Workspace can add document categories');
      if ((DOCUMENT_GROUPS as readonly string[]).includes(input.key) || (await tx.collection('document_categories').exists({ key: input.key }))) throw Errors.conflict('duplicate', 'A category with this key already exists');
      const row = await tx.collection('document_categories').insert({ key: input.key, name: input.name, description: input.description ?? null, created_by_membership_id: v.s.membershipId });
      await this.audit.record(tx, { action: 'document_category.created', resourceType: 'document_category', resourceId: row.id, metadata: { key: input.key, name: input.name } });
      return { key: row.key, name: row.name, description: row.description, builtIn: false };
    });
  }

  async addType(input: z.infer<typeof documentTypeInput>) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const hrMay = v.hr && (v.hr.companyWide ? v.book.get(null).request : v.hr.workspaceIds.some((w) => v.book.get(w).request));
      if (!v.isSuper && !hrMay) throw Errors.forbidden('Only Super Workspace, or HR Workspace people who may request documents, can add document types');
      const c = await this.catalogue(tx);
      if (c.typeOf(input.key)) throw Errors.conflict('duplicate', 'A document type with this key already exists');
      if (!c.groups.some((g) => g.key === input.category)) throw Errors.badRequest('unknown_category', 'Choose one of the document categories');
      const row = await tx.collection('document_types').insert({ key: input.key, name: input.name, category: input.category, sensitive: input.sensitive, owners: input.owners, created_by_membership_id: v.s.membershipId });
      await this.audit.record(tx, { action: 'document_type.created', resourceType: 'document_type', resourceId: row.id, metadata: { key: input.key, name: input.name, category: input.category } });
      return { key: row.key, name: row.name, category: row.category, sensitive: row.sensitive, owners: row.owners, legacy: 'other', builtIn: false };
    });
  }

  // Access switches -----------------------------------------------------------------------------------------------

  /** Super Workspace: the document access switches of company-wide HR and of every HR Workspace. */
  async accessSettings() {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      if (!v.isSuper) throw Errors.forbidden('Only Super Workspace manages document access');
      const workspaces = await tx.collection('hr_workspaces').find({ status: { $ne: 'archived' } }, { sort: { name: 1 } });
      const admins = await hrWorkspaceAdmins(tx, workspaces.map((w) => w.id as string));
      const central = await companyWideHr(tx);
      const scope = (key: string, name: string, hrWorkspaceId: string | null, people: number) => {
        const row = v.book.row(key);
        return { scope: key, name, hrWorkspaceId, people, switches: effectiveDocumentAccess(row?.switches), stored: row ? (row.switches as Record<string, boolean>) : null, sharedHrWorkspaceIds: (row?.shared_hr_workspace_ids ?? []) as string[], version: (row?.version ?? 0) as number, updatedAt: iso(row?.updated_at) };
      };
      return {
        switches: DOCUMENT_ACCESS_SWITCHES,
        scopes: [scope(CENTRAL, 'Company-wide HR Workspace', null, central.length), ...workspaces.map((w) => scope(w.id, w.name, w.id, admins.get(w.id)?.length ?? 0))],
      };
    });
  }

  async saveAccess(scopeKey: string, input: z.infer<typeof documentAccessInput>) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      if (!v.isSuper) throw Errors.forbidden('Only Super Workspace manages document access');
      let hrWorkspaceId: string | null = null;
      let name = 'Company-wide HR Workspace';
      if (scopeKey !== CENTRAL) {
        const w = await tx.collection('hr_workspaces').findOne({ id: scopeKey });
        if (!w) throw Errors.notFound('HR Workspace');
        hrWorkspaceId = w.id;
        name = w.name;
      }
      const shared = [...new Set(input.sharedHrWorkspaceIds.filter((x) => x !== scopeKey))];
      if (shared.length && (await tx.collection('hr_workspaces').count({ id: { $in: shared } })) !== shared.length) throw Errors.badRequest('unknown_hr_workspace', 'Choose HR Workspaces of this company');
      const before = v.book.row(scopeKey);
      if (input.version !== undefined && (before?.version ?? 0) !== input.version) throw Errors.conflict('stale', 'Someone changed these switches since you opened them. Reload and try again.');
      const from = effectiveDocumentAccess(before?.switches);
      const switches = Object.fromEntries(DOCUMENT_ACCESS_KEYS.map((k) => [k, input.switches[k]]));
      const to = effectiveDocumentAccess(switches);
      const changes = Object.fromEntries(DOCUMENT_ACCESS_KEYS.filter((k) => from[k] !== to[k]).map((k) => [k, { from: from[k], to: to[k] }]));
      if (before) await tx.collection('document_access_settings').updateOne({ id: before.id }, { $set: { switches, shared_hr_workspace_ids: shared, updated_by_membership_id: v.s.membershipId }, $inc: { version: 1 } });
      else await tx.collection('document_access_settings').insert({ scope_key: scopeKey, hr_workspace_id: hrWorkspaceId, switches, shared_hr_workspace_ids: shared, updated_by_membership_id: v.s.membershipId, version: 1 });
      await this.audit.record(tx, { action: 'document_access.changed', resourceType: 'hr_workspace', resourceId: hrWorkspaceId ?? CENTRAL, changes, metadata: { scope: scopeKey, name, shared } });
      await this.activity(tx, v, { action: 'access_changed', hrWorkspaceId, metadata: { scope: scopeKey, changes, shared } });
      const recipients = hrWorkspaceId ? (await hrWorkspaceAdmins(tx, [hrWorkspaceId])).get(hrWorkspaceId) ?? [] : await companyWideHr(tx);
      if (Object.keys(changes).length || JSON.stringify((before?.shared_hr_workspace_ids ?? []).slice().sort()) !== JSON.stringify(shared.slice().sort())) {
        const on = Object.entries(changes).filter(([, c]) => c.to).map(([k]) => DOCUMENT_ACCESS_SWITCHES.find((s) => s.key === k)!.label);
        const off = Object.entries(changes).filter(([, c]) => !c.to).map(([k]) => DOCUMENT_ACCESS_SWITCHES.find((s) => s.key === k)!.label);
        await this.notifications.notify(tx, {
          membershipIds: recipients, kind: 'documents.access_changed', title: `Super Workspace changed document access for ${name}`,
          body: [on.length ? `Now allowed: ${on.join(', ')}.` : '', off.length ? `No longer allowed: ${off.join(', ')}.` : ''].filter(Boolean).join(' ') || 'The list of other HR Workspaces you can see changed.',
          link: '/documents', priority: off.length ? 'high' : 'normal', actorMembershipId: v.s.membershipId, dedupeKey: `docaccess:${scopeKey}`,
        });
      }
      return { scope: scopeKey, switches: to, sharedHrWorkspaceIds: shared, version: (before?.version ?? 0) + 1 };
    });
  }

  /** What the signed-in person may do with documents (for showing the right screens). */
  async myAccess() {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const all = Object.fromEntries(DOCUMENT_ACCESS_KEYS.map((k) => [k, true])) as DocumentAccess;
      const scopes = v.hr ? (v.hr.companyWide ? [CENTRAL] : v.hr.workspaceIds) : [];
      const merged = Object.fromEntries(DOCUMENT_ACCESS_KEYS.map((k) => [k, scopes.some((sc) => v.book.get(sc === CENTRAL ? null : sc)[k])])) as DocumentAccess;
      const ws = await fieldById(tx, 'hr_workspaces', v.hr?.workspaceIds ?? []);
      return {
        level: v.level,
        access: v.isSuper ? all : v.hr ? merged : null,
        hrWorkspaces: (v.hr?.workspaceIds ?? []).map((id) => ({ id, name: ws.get(id) ?? null, access: v.book.get(id) })),
        companyWide: !!v.hr?.companyWide,
        employeeId: v.s.employeeId ?? null,
      };
    });
  }

  // Requests ------------------------------------------------------------------------------------------------------

  /** People and HR Workspaces the viewer may ask for documents (for the request form). */
  async targets() {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const out = { employees: [] as { id: string; name: string; code: string | null; departmentName: string | null; hrWorkspaceName: string | null; hasLogin: boolean }[], hrWorkspaces: [] as { id: string; name: string; admins: { membershipId: string; name: string | null }[] }[] };
      let employees: Doc[] = [];
      if (v.isSuper) employees = await tx.collection('employees').find({ status: { $ne: 'exited' } }, { sort: { first_name: 1 }, limit: 3000 });
      else if (v.hr) {
        const hrS = { ...v.s, grants: levelGrants(v.s, 'hr_workspace', 'documents:manage') };
        const scope = scopeFilter(hrS, 'documents:manage', EMPLOYEE_FIELDS);
        if (scope) employees = (await tx.collection('employees').find({ ...scope, status: { $ne: 'exited' } }, { sort: { first_name: 1 }, limit: 3000 })).filter((e) => accessFor(v, e.hr_workspace_id ?? null)?.request);
      }
      employees = employees.filter((e) => e.id !== v.s.employeeId);
      const depts = await fieldById(tx, 'departments', employees.map((e) => e.current_department_id));
      const wsNames = await fieldById(tx, 'hr_workspaces', employees.map((e) => e.hr_workspace_id));
      out.employees = employees.map((e) => ({ id: e.id, name: displayName(e as never), code: e.employee_code ?? null, departmentName: depts.get(e.current_department_id) ?? null, hrWorkspaceName: wsNames.get(e.hr_workspace_id) ?? null, hasLogin: !!e.membership_id }));
      let ws: Doc[] = [];
      if (v.isSuper) ws = await tx.collection('hr_workspaces').find({ status: 'active' }, { sort: { name: 1 } });
      else if (v.hr) {
        const ids = new Set<string>();
        for (const sc of v.hr.companyWide ? [CENTRAL] : v.hr.workspaceIds) {
          const a = v.book.get(sc === CENTRAL ? null : sc);
          if (a.request_other_hr) v.book.shared(sc === CENTRAL ? null : sc).forEach((x) => x !== sc && ids.add(x));
        }
        ws = await tx.collection('hr_workspaces').find({ id: { $in: [...ids] }, status: 'active' }, { sort: { name: 1 } });
      }
      const admins = await hrWorkspaceAdmins(tx, ws.map((w) => w.id as string));
      const names = await membershipUserNames(tx, [...admins.values()].flat());
      out.hrWorkspaces = ws.map((w) => ({ id: w.id, name: w.name, admins: (admins.get(w.id) ?? []).map((m) => ({ membershipId: m, name: names.get(m) ?? null })) }));
      return out;
    });
  }

  async create(input: DocumentRequestInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      if (!v.isSuper && !v.hr) throw Errors.forbidden('Only Super Workspace and HR Workspace can request documents');
      const cat = await this.catalogue(tx);
      const type = cat.typeOf(input.typeKey);
      if (!type) throw Errors.badRequest('unknown_type', 'Choose a document type');
      if (!type.owners.includes(input.target)) throw Errors.badRequest('wrong_owner', input.target === 'employee' ? `${type.name} is asked of HR Workspaces, not people` : `${type.name} is asked of people, not HR Workspaces`);
      const title = input.title?.trim() || type.name;
      const level: DocLevel = v.isSuper ? 'super_workspace' : 'hr_workspace';
      const due = input.dueOn ?? null;
      if (due && due < istToday()) throw Errors.badRequest('past_deadline', 'The deadline cannot be in the past');
      let replaced: Doc | undefined;
      if (input.replacesDocumentId) {
        replaced = (await this.loadDoc(tx, v, input.replacesDocumentId)).d;
      }
      const common = {
        type_key: type.key, doc_category: type.category, title, instructions: input.instructions ?? null, reason: input.reason, due_on: due, priority: input.priority,
        formats: input.formats, max_mb: input.maxMb, expiry_required: input.expiryRequired, replaces_document_id: replaced?.id ?? null,
        requested_by_membership_id: actor.membershipId, requester_level: level, status: 'new_request',
      };
      const wsNames = new Map<string, string>();
      const created: Doc[] = [];
      if (input.target === 'employee') {
        const ids = [...new Set(input.employeeIds ?? [])];
        const people = await tx.collection('employees').find({ id: { $in: ids } });
        if (people.length !== ids.length) throw Errors.notFound('Employee');
        for (const e of people) {
          if (e.id === v.s.employeeId) throw Errors.badRequest('self_request', 'You cannot request a document from yourself');
          if (replaced && replaced.employee_id !== e.id) throw Errors.badRequest('wrong_owner', 'A replacement is asked of the person the document belongs to');
          let requesterWs: string | null = null;
          if (!v.isSuper) {
            if (!hrCovers(v, e, 'documents:manage')) throw Errors.notFound('Employee');
            const a = accessFor(v, e.hr_workspace_id ?? null);
            if (!a?.request) throw Errors.forbidden('Super Workspace has not allowed your HR Workspace to request employee documents');
            requesterWs = v.hr!.companyWide ? null : (e.hr_workspace_id as string);
          }
          if (!e.membership_id) throw Errors.badRequest('no_login', `${displayName(e as never)} has no SampCrew login yet, so they cannot receive the request`);
          created.push(await this.insertRequest(tx, v, { ...common, target_type: 'employee', employee_id: e.id, hr_workspace_id: e.hr_workspace_id ?? null, assignee_membership_id: e.membership_id, requester_hr_workspace_id: requesterWs }, e));
        }
      } else {
        const w = await tx.collection('hr_workspaces').findOne({ id: input.hrWorkspaceId!, status: 'active' });
        if (!w) throw Errors.notFound('HR Workspace');
        wsNames.set(w.id, w.name);
        let requesterWs: string | null = null;
        if (!v.isSuper) {
          const scopes = v.hr!.companyWide ? [CENTRAL] : v.hr!.workspaceIds;
          const via = scopes.find((sc) => sc !== w.id && v.book.get(sc === CENTRAL ? null : sc).request_other_hr && v.book.shared(sc === CENTRAL ? null : sc).includes(w.id));
          if (!via) throw Errors.forbidden('Super Workspace has not allowed your HR Workspace to request documents from this HR Workspace');
          requesterWs = via === CENTRAL ? null : via;
        }
        if (replaced && replaced.hr_workspace_id !== w.id) throw Errors.badRequest('wrong_owner', 'A replacement is asked of the HR Workspace the document belongs to');
        const admins = (await hrWorkspaceAdmins(tx, [w.id])).get(w.id) ?? [];
        if (!admins.length) throw Errors.badRequest('no_admins', `${w.name} has no HR Workspace Admin to send the request to`);
        const assignee = input.assigneeMembershipId ?? admins[0]!;
        if (!admins.includes(assignee)) throw Errors.badRequest('not_admin', 'Choose one of the HR Workspace Admins');
        if (assignee === actor.membershipId) throw Errors.badRequest('self_request', 'You cannot request a document from yourself');
        created.push(await this.insertRequest(tx, v, { ...common, target_type: 'hr_workspace', employee_id: null, hr_workspace_id: w.id, assignee_membership_id: assignee, requester_hr_workspace_id: requesterWs }, undefined, admins));
      }
      if (replaced) await this.activity(tx, v, { action: 'replacement_requested', documentId: replaced.id, requestId: created[0]!.id, employeeId: replaced.employee_id, hrWorkspaceId: replaced.hr_workspace_id });
      return this.requestViews(tx, v, created);
    });
  }

  private async insertRequest(tx: TenantTx, v: Viewer, row: Doc, employee?: Doc, admins: string[] = []) {
    const actor = requestContext.tenantActor();
    const id = randomUUID();
    const r = await tx.collection('document_requests').insert({ id, reference: refOf('DRQ', id), ...row });
    const wsName = r.requester_hr_workspace_id ? (await tx.collection('hr_workspaces').findOne({ id: r.requester_hr_workspace_id }))?.name ?? null : null;
    const from = this.requesterLabel(r.requester_level, wsName);
    // The task on the receiver's My Tasks: the employee, or the HR Workspace Admin it was sent to (when they have an
    // employee record; any admin of the HR Workspace can still submit from the request).
    let taskEmployee = employee;
    if (!taskEmployee && r.assignee_membership_id) {
      const m = await tx.collection('memberships').findOne({ id: r.assignee_membership_id });
      taskEmployee = m?.employee_id ? await tx.collection('employees').findOne({ id: m.employee_id }) : undefined;
    }
    let taskId: string | null = null;
    if (taskEmployee) {
      const legacy = builtInType(r.type_key)?.legacy ?? 'other';
      const task = await tx.collection('employee_tasks').insert({
        employee_id: taskEmployee.id, assignee_membership_id: r.assignee_membership_id, category: 'hr', kind: 'document', title: r.title,
        description: [r.instructions, `Reason: ${r.reason}`, `Requested by ${from}.`].filter(Boolean).join('\n\n'), priority: r.priority, due_on: r.due_on ?? null,
        document_spec: { category: legacy, formats: (r.formats as RequestFileFormat[]).map((f) => TASK_FORMAT[f]).filter(Boolean), maxMb: r.max_mb },
        assigned_by_membership_id: actor.membershipId, status: 'new', request_id: r.id, request_status: 'new_request',
        history: [{ at: new Date(), by: actor.membershipId, action: 'assigned', status: 'new', remarks: `Document request ${r.reference} from ${from}` }],
      });
      taskId = task.id;
      await tx.collection('document_requests').updateOne({ id: r.id }, { $set: { task_id: taskId } });
    }
    await this.activity(tx, v, { action: 'requested', requestId: r.id, taskId, employeeId: r.employee_id, hrWorkspaceId: r.hr_workspace_id, comment: r.reason, metadata: { title: r.title, type: r.type_key, dueOn: r.due_on ?? null, from } });
    await this.audit.record(tx, { action: 'document_request.created', resourceType: r.employee_id ? 'employee' : 'hr_workspace', resourceId: r.employee_id ?? r.hr_workspace_id, metadata: { requestId: r.id, reference: r.reference, type: r.type_key, title: r.title, level: r.requester_level } });
    const to = r.target_type === 'employee' ? [r.assignee_membership_id] : [...new Set([r.assignee_membership_id, ...admins])];
    await this.notifications.notify(tx, {
      membershipIds: to, kind: 'document.requested',
      title: `${from} has requested your ${r.title}`,
      body: `Please submit it${r.due_on ? ` before ${r.due_on}` : ''}. Reason: ${r.reason}`,
      link: `/documents/requests/${r.id}`, email: true, priority: r.priority === 'urgent' || r.priority === 'high' ? 'high' : 'normal',
      actorMembershipId: actor.membershipId, resource: { type: 'document_request', id: r.id }, dedupeKey: `docreq:${r.id}:requested`,
    });
    await this.notifications.signal(tx, to, 'documents.changed', { requestId: r.id });
    return (await tx.collection('document_requests').findOne({ id: r.id }))!;
  }

  async listRequests(q: z.infer<typeof documentRequestQuery>) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const me = v.s.membershipId;
      const filter: Doc = {};
      const today = istToday();
      if (q.status === 'open') filter.status = { $in: [...OPEN_REQUEST_STATUSES] };
      else if (q.status === 'awaiting_review') filter.status = { $in: [...AWAITING_REVIEW] };
      else if (q.status === 'awaiting_submission') filter.status = { $in: [...AWAITING_SUBMISSION] };
      else if (q.status === 'overdue') Object.assign(filter, { status: { $in: [...AWAITING_SUBMISSION] }, due_on: { $lt: today } });
      else if (q.status) filter.status = q.status;
      if (q.employeeId) filter.employee_id = q.employeeId;
      if (q.hrWorkspaceId) filter.hr_workspace_id = q.hrWorkspaceId === CENTRAL ? null : q.hrWorkspaceId;
      if (q.requestedBy) filter.requester_level = q.requestedBy;
      if (q.typeKey) filter.type_key = q.typeKey;
      if (q.dueBefore) filter.due_on = { ...(filter.due_on ?? {}), $lte: q.dueBefore };
      if (q.q) {
        const emps = await tx.collection('employees').distinct<string>('id', nameFilter(q.q));
        const ws = await tx.collection('hr_workspaces').distinct<string>('id', { name: ilike(q.q) });
        filter.$and = [{ $or: [{ title: ilike(q.q) }, { reference: ilike(q.q) }, { employee_id: { $in: emps } }, { hr_workspace_id: { $in: ws } }] }];
      }
      let scope: Doc;
      if (q.scope === 'mine') {
        const ors: Doc[] = [];
        if (v.s.employeeId) ors.push({ target_type: 'employee', employee_id: v.s.employeeId });
        ors.push({ target_type: 'hr_workspace', assignee_membership_id: me });
        if (v.hr && !v.hr.companyWide && v.hr.workspaceIds.length) ors.push({ target_type: 'hr_workspace', hr_workspace_id: { $in: v.hr.workspaceIds } });
        scope = { $or: ors };
      } else if (q.scope === 'raised') {
        scope = v.isSuper ? { requester_level: 'super_workspace' } : { requested_by_membership_id: me };
      } else if (q.scope === 'review') {
        const reqIds = await this.approvals.waitingFor(tx, me, 'document_request');
        scope = { approval_request_id: { $in: reqIds } };
      } else if (v.isSuper) scope = {};
      else {
        // Everything the person may read: computed per row (requests are few compared to documents).
        scope = {};
      }
      const rows = await tx.collection('document_requests').find({ ...filter, ...scope }, { sort: { created_at: -1 }, limit: 2000 });
      const visible: Doc[] = [];
      for (const r of rows) if (q.scope !== 'all' || v.isSuper || (await this.mayReadRequest(tx, v, r))) visible.push(r);
      const page = visible.slice(q.offset, q.offset + q.limit);
      return { items: await this.requestViews(tx, v, page, { approvers: true }), total: visible.length };
    });
  }

  async getRequest(id: string) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const r = await this.loadRequest(tx, v, id);
      const [view] = await this.requestViews(tx, v, [r], { approvers: true });
      const versions = await tx.collection('employee_documents').find({ request_id: id }, { sort: { version: -1, created_at: -1 } });
      const history = await this.history(tx, { request_id: id });
      const trail = r.approval_request_id ? await this.approvals.trail(tx, r.approval_request_id) : [];
      await this.notifications.markReadByLink(tx, v.s.membershipId, `/documents/requests/${id}`);
      return { ...view!, versions: await this.docViews(tx, v, versions.filter((d) => this.docRights(v, d, undefined) || view!.isMine || view!.canReview || v.isSuper)), history, approvalTrail: trail, canCancel: OPEN_REQUEST_STATUSES.includes(r.status) && (r.requested_by_membership_id === v.s.membershipId || v.isSuper) };
    });
  }

  /** The person asked opened the request (or its task): it is no longer new. */
  async opened(id: string) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const r = await this.loadRequest(tx, v, id);
      if (await this.isTarget(tx, v, r)) await this.markOpened(tx, v, r);
      return { ok: true };
    });
  }

  /** In the caller's transaction (also used when the task is opened). */
  async markOpened(tx: TenantTx, v: Viewer | null, r: Doc) {
    if (r.status !== 'new_request') return;
    if (!(await tx.collection('document_requests').updateOne({ id: r.id, status: 'new_request' }, { $set: { status: 'pending_submission' } }))) return;
    if (r.task_id) await tx.collection('employee_tasks').updateOne({ id: r.task_id }, { $set: { request_status: 'pending_submission' } });
    await this.activity(tx, v, { action: 'opened', requestId: r.id, taskId: r.task_id, employeeId: r.employee_id, hrWorkspaceId: r.hr_workspace_id });
  }

  async markOpenedByTask(tx: TenantTx, requestId: string) {
    const r = await tx.collection('document_requests').findOne({ id: requestId });
    if (r) await this.markOpened(tx, await this.viewer(tx), r);
  }

  /** The person asked sends the file. It is stored once, as a new version, and goes to the level that asked to verify. */
  async submit(id: string, file: UploadedFile | undefined, meta: z.infer<typeof documentSubmitMeta>) {
    DocumentsService.check(file);
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const r = await this.loadRequest(tx, v, id);
      await tx.collection('document_requests').lock({ id });
      if (!(await this.isTarget(tx, v, r))) throw Errors.forbidden(r.target_type === 'employee' ? 'Only the person asked can submit this document' : 'Only the HR Workspace asked can submit this document');
      if (!AWAITING_SUBMISSION.includes(r.status)) throw Errors.conflict('invalid_state', AWAITING_REVIEW.includes(r.status) ? 'Your last upload is being verified' : 'This request is closed');
      const allowed = (r.formats as RequestFileFormat[]).flatMap((f) => REQUEST_FILE_FORMATS[f] as readonly string[]);
      if (!allowed.includes(file.mimetype)) throw Errors.badRequest('file_not_allowed', `Upload ${(r.formats as string[]).map((f) => f.toUpperCase()).join(', ')}`);
      if (file.size > r.max_mb * 1024 * 1024) throw Errors.badRequest('file_too_large', `Files for this request can be up to ${r.max_mb} MB`);
      if (r.expiry_required && !meta.expiresOn) throw Errors.badRequest('expiry_required', 'Enter the date the document expires');
      const prev = r.document_id ? await tx.collection('employee_documents').findOne({ id: r.document_id }) : r.replaces_document_id ? await tx.collection('employee_documents').findOne({ id: r.replaces_document_id }) : undefined;
      if (prev && r.document_id) await tx.collection('employee_documents').updateOne({ id: prev.id }, { $set: { superseded_at: new Date() } });
      const legacy = builtInType(r.type_key)?.legacy ?? 'other';
      const docId = randomUUID();
      const doc = await this.documents.store(tx, r.employee_id ?? null, { category: legacy, title: r.title, visibility: 'employee' }, file, {
        id: docId, owner_type: r.target_type, hr_workspace_id: r.hr_workspace_id ?? null, request_id: r.id, type_key: r.type_key, doc_category: r.doc_category, reference: refOf('DOC', docId),
        version: prev ? (prev.version ?? 1) + 1 : 1, previous_document_id: prev?.id ?? null, expires_on: meta.expiresOn ?? null, submitter_remarks: meta.remarks ?? null,
        verification_status: 'pending', task_id: r.task_id ?? null,
      });
      const status: DocumentRequestStatus = (r.submissions ?? 0) > 0 ? 'resubmitted' : 'submitted';
      const approvalId = await this.approvals.start(tx, { resourceType: 'document_request', resourceId: r.id, subjectEmployeeId: r.employee_id ?? null, summary: `${r.title}: ${doc.fileName} (${r.reference})`, steps: [{ type: 'role', role: r.requester_level }] });
      await tx.collection('document_requests').updateOne({ id }, { $set: { status, document_id: doc.id, submitted_at: new Date(), submitted_by_membership_id: actor.membershipId, approval_request_id: approvalId }, $inc: { submissions: 1 } });
      if (r.task_id) {
        await tx.collection('employee_tasks').updateOne({ id: r.task_id }, {
          $set: { status: 'pending_review', request_status: status, document_id: doc.id, submitted_at: new Date(), employee_remarks: meta.remarks ?? null, verification_request_id: approvalId, seen_at: new Date() },
          $push: { history: { at: new Date(), by: actor.membershipId, action: 'uploaded', status: 'pending_review', remarks: meta.remarks ?? file.originalname } },
        });
      }
      await this.activity(tx, v, { action: status, documentId: doc.id, requestId: id, taskId: r.task_id, approvalId, employeeId: r.employee_id, hrWorkspaceId: r.hr_workspace_id, comment: meta.remarks ?? null, metadata: { version: prev ? (prev.version ?? 1) + 1 : 1, fileName: doc.fileName, sha256: doc.sha256 } });
      await this.notifications.notify(tx, {
        membershipIds: [actor.membershipId], kind: 'document.submitted', title: `Your ${r.title} has been submitted successfully`,
        body: `It is awaiting verification by ${ACCESS_LEVEL_LABEL[r.requester_level as 'super_workspace']}.`, link: `/documents/requests/${id}`,
        resource: { type: 'document_request', id }, dedupeKey: `docreq:${id}:submitted:${(r.submissions ?? 0) + 1}`,
      });
      if (r.requested_by_membership_id !== actor.membershipId) {
        const reviewers = await this.approvals.approversOf(tx, approvalId);
        if (!reviewers.includes(r.requested_by_membership_id)) {
          await this.notifications.notify(tx, { membershipIds: [r.requested_by_membership_id], kind: `document.${status}`, title: `${r.title} was ${status === 'resubmitted' ? 'resubmitted' : 'submitted'}`, body: `${r.reference} is now with ${ACCESS_LEVEL_LABEL[r.requester_level as 'super_workspace']} for verification.`, link: `/documents/requests/${id}`, resource: { type: 'document_request', id } });
        }
      }
      await this.notifications.signal(tx, [actor.membershipId, r.requested_by_membership_id], 'documents.changed', { requestId: id });
      const fresh = (await tx.collection('document_requests').findOne({ id }))!;
      return (await this.requestViews(tx, v, [fresh], { approvers: true }))[0]!;
    });
  }

  /** A reviewer opened the submission: it is now under verification. */
  async startReview(id: string) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const r = await this.loadRequest(tx, v, id);
      if (!r.approval_request_id || !['submitted', 'resubmitted'].includes(r.status)) return { status: r.status };
      if (!(await this.approvals.approversOf(tx, r.approval_request_id)).includes(v.s.membershipId)) return { status: r.status };
      await tx.collection('document_requests').updateOne({ id, status: r.status }, { $set: { status: 'under_verification', reviewer_membership_id: v.s.membershipId } });
      if (r.task_id) await tx.collection('employee_tasks').updateOne({ id: r.task_id }, { $set: { request_status: 'under_verification' } });
      await this.activity(tx, v, { action: 'review_started', documentId: r.document_id, requestId: id, taskId: r.task_id, approvalId: r.approval_request_id, employeeId: r.employee_id, hrWorkspaceId: r.hr_workspace_id });
      await this.notifications.signal(tx, [r.assignee_membership_id, r.submitted_by_membership_id], 'documents.changed', { requestId: id });
      return { status: 'under_verification' };
    });
  }

  /** Approve, reject (with the reason) or send back for correction (with what to fix). */
  async decide(id: string, input: z.infer<typeof documentDecisionInput>) {
    const approvalId = await this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const r = await this.loadRequest(tx, v, id);
      if (!AWAITING_REVIEW.includes(r.status) || !r.approval_request_id) throw Errors.conflict('invalid_state', 'There is no submission waiting for verification');
      if (!(await this.approvals.approversOf(tx, r.approval_request_id)).includes(v.s.membershipId)) {
        throw Errors.forbidden(r.requester_level === 'super_workspace' ? 'Super Workspace verifies documents it requested' : 'You cannot verify this document');
      }
      this.checkSwitch(v, r, input.decision);
      if (input.decision !== 'correction') return r.approval_request_id as string;
      await tx.collection('document_requests').lock({ id });
      await this.approvals.cancel(tx, r.approval_request_id);
      await this.closeRound(tx, v, r, 'correction', input.comment ?? null);
      return null;
    });
    if (approvalId) {
      const ctx = requestContext.get() as unknown as Record<symbol, unknown> | undefined;
      if (ctx) ctx[DECISION_KEY] = { requestId: id, expiresOn: input.expiresOn ?? undefined };
      await this.approvals.decide(approvalId, input.decision === 'approve' ? 'approve' : 'reject', input.comment ?? undefined);
    }
    return this.getRequest(id);
  }

  private checkSwitch(v: Viewer, r: Doc, decision: 'approve' | 'reject' | 'correction') {
    if (v.isSuper) return;
    const a = v.hr?.companyWide ? v.book.get(null) : r.requester_hr_workspace_id ? v.book.get(r.requester_hr_workspace_id) : null;
    const key = decision === 'approve' ? 'approve' : decision === 'reject' ? 'reject' : 'correct';
    if (!a?.verify || !a[key]) throw Errors.forbidden(`Super Workspace has not allowed your HR Workspace to ${decision === 'correction' ? 'request corrections' : `${decision} documents`}`);
  }

  /** Called by the approvals engine when the submission is approved or rejected (from here or from Approvals). */
  private async decided(tx: TenantTx, requestId: string, decision: 'approve' | 'reject', comment: string | null) {
    const v = await this.viewer(tx);
    const r = await tx.collection('document_requests').findOne({ id: requestId });
    if (!r) return;
    this.checkSwitch(v, r, decision);
    await this.closeRound(tx, v, r, decision, comment);
  }

  private async closeRound(tx: TenantTx, v: Viewer, r: Doc, decision: 'approve' | 'reject' | 'correction', comment: string | null) {
    const me = v.s.membershipId;
    const now = new Date();
    const ctx = requestContext.get() as unknown as Record<symbol, { requestId: string; expiresOn?: string }> | undefined;
    const stash = ctx && ctx[DECISION_KEY]?.requestId === r.id ? ctx[DECISION_KEY] : undefined;
    const docStatus = decision === 'approve' ? 'verified' : decision === 'reject' ? 'rejected' : 'correction_required';
    if (r.document_id) {
      await tx.collection('employee_documents').updateOne({ id: r.document_id }, {
        $set: { verification_status: docStatus, verification_remarks: comment, verified_at: now, verified_by_membership_id: me, ...(stash?.expiresOn ? { expires_on: stash.expiresOn } : {}) },
      });
    }
    if (decision === 'approve' && r.replaces_document_id) {
      await tx.collection('employee_documents').updateOne({ id: r.replaces_document_id, superseded_at: null }, { $set: { superseded_at: now } });
      await this.activity(tx, v, { action: 'replaced', documentId: r.replaces_document_id, requestId: r.id, employeeId: r.employee_id, hrWorkspaceId: r.hr_workspace_id, metadata: { by: r.document_id } });
    }
    const status: DocumentRequestStatus = decision === 'approve' ? 'completed' : decision === 'reject' ? 'rejected' : 'correction_required';
    await tx.collection('document_requests').updateOne({ id: r.id }, { $set: { status, reviewer_membership_id: me, reviewer_comment: comment, decided_at: now, ...(status === 'completed' ? { completed_at: now } : {}) } });
    if (r.task_id) {
      const taskStatus = TASK_STATUS_OF[status];
      await tx.collection('employee_tasks').updateOne({ id: r.task_id }, {
        $set: { status: taskStatus, request_status: status, reviewer_remarks: comment, ...(taskStatus === 'completed' ? { completed_at: now } : {}) },
        $push: { history: { at: now, by: me, action: decision === 'approve' ? 'document_verified' : decision === 'reject' ? 'document_rejected' : 'correction_requested', status: taskStatus, remarks: comment } },
      });
    }
    const action = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'correction_requested';
    await this.activity(tx, v, { action, documentId: r.document_id, requestId: r.id, taskId: r.task_id, approvalId: r.approval_request_id, employeeId: r.employee_id, hrWorkspaceId: r.hr_workspace_id, comment });
    await this.audit.record(tx, { action: `document.${action}`, resourceType: r.employee_id ? 'employee' : 'hr_workspace', resourceId: r.employee_id ?? r.hr_workspace_id, metadata: { requestId: r.id, documentId: r.document_id, reference: r.reference, comment } });
    const by = r.requester_level === 'super_workspace' ? 'Super Workspace' : 'HR Workspace';
    const to = [...new Set([r.submitted_by_membership_id, r.target_type === 'employee' ? r.assignee_membership_id : null].filter(Boolean))];
    const notice = decision === 'approve'
      ? { title: `Your ${r.title} has been verified and approved by ${by}`, body: comment ? `Remarks: ${comment}` : 'It is now in your profile documents.', priority: 'normal' as const }
      : decision === 'reject'
        ? { title: `Your ${r.title} was rejected by ${by}`, body: `Reason: ${comment}\nYou can upload a corrected document from the request.`, priority: 'high' as const }
        : { title: `${by} asked you to correct your ${r.title}`, body: `What to fix: ${comment}`, priority: 'high' as const };
    await this.notifications.notify(tx, {
      membershipIds: to, kind: `document.${action}`, ...notice, link: `/documents/requests/${r.id}`, email: true, actorMembershipId: me,
      resource: { type: 'document_request', id: r.id }, dedupeKey: `docreq:${r.id}:${action}:${r.submissions ?? 0}`,
    });
    if (r.requested_by_membership_id !== me) {
      await this.notifications.notify(tx, {
        membershipIds: [r.requested_by_membership_id], kind: `document.${action}`,
        title: decision === 'approve' ? `Collected: ${r.title} (${r.reference})` : `${r.title} ${decision === 'reject' ? 'rejected' : 'sent back for correction'} (${r.reference})`,
        body: comment ?? undefined, link: `/documents/requests/${r.id}`, actorMembershipId: me, resource: { type: 'document_request', id: r.id },
      });
    }
    await this.notifications.signal(tx, [...to, r.requested_by_membership_id, me], 'documents.changed', { requestId: r.id });
  }

  async cancel(id: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const r = await this.loadRequest(tx, v, id);
      if (!(r.requested_by_membership_id === v.s.membershipId || v.isSuper)) throw Errors.forbidden('Only the person who asked, or Super Workspace, can cancel a request');
      if (!OPEN_REQUEST_STATUSES.includes(r.status)) throw Errors.conflict('invalid_state', 'This request is already closed');
      await this.cancelInTx(tx, v, r, reason);
      return { ok: true };
    });
  }

  async cancelInTx(tx: TenantTx, v: Viewer | null, r: Doc, reason: string) {
    if (r.approval_request_id && AWAITING_REVIEW.includes(r.status)) await this.approvals.cancel(tx, r.approval_request_id);
    if (r.document_id) await tx.collection('employee_documents').updateOne({ id: r.document_id, verification_status: 'pending' }, { $set: { verification_status: 'rejected', verification_remarks: `Request cancelled: ${reason}` } });
    await tx.collection('document_requests').updateOne({ id: r.id }, { $set: { status: 'cancelled', cancelled_reason: reason, decided_at: new Date() } });
    if (r.task_id) {
      await tx.collection('employee_tasks').updateOne({ id: r.task_id, status: { $ne: 'cancelled' } }, { $set: { status: 'cancelled', request_status: 'cancelled', reviewer_remarks: reason }, $push: { history: { at: new Date(), by: requestContext.tenantActor().membershipId, action: 'cancelled', status: 'cancelled', remarks: reason } } });
    }
    await this.activity(tx, v, { action: 'cancelled', documentId: r.document_id, requestId: r.id, taskId: r.task_id, employeeId: r.employee_id, hrWorkspaceId: r.hr_workspace_id, comment: reason });
    await this.notifications.notify(tx, { membershipIds: [r.assignee_membership_id], kind: 'document.cancelled', title: `Document request cancelled: ${r.title}`, body: reason, link: `/documents/requests/${r.id}`, resource: { type: 'document_request', id: r.id } });
  }

  async cancelByTask(tx: TenantTx, requestId: string, reason: string) {
    const v = await this.viewer(tx);
    const r = await tx.collection('document_requests').findOne({ id: requestId });
    if (!r || !OPEN_REQUEST_STATUSES.includes(r.status)) return;
    if (!(r.requested_by_membership_id === v.s.membershipId || v.isSuper)) throw Errors.forbidden('Only the person who asked, or Super Workspace, can cancel a document request');
    await this.cancelInTx(tx, v, r, reason);
  }

  // Repository ----------------------------------------------------------------------------------------------------

  private async repoFilter(tx: TenantTx, v: Viewer, q: Partial<DocumentRepositoryQuery>): Promise<Doc> {
    const and: Doc[] = [{ archived_at: null }, await this.visibleFilter(tx, v)];
    if (!q.includeReplaced) and.push({ superseded_at: null });
    if (q.owner) and.push(q.owner === 'employee' ? { owner_type: { $ne: 'hr_workspace' } } : { owner_type: 'hr_workspace' });
    if (q.employeeId) and.push({ employee_id: q.employeeId });
    if (q.hrWorkspaceId) {
      const id = q.hrWorkspaceId === CENTRAL ? null : q.hrWorkspaceId;
      const emps = await tx.collection('employees').distinct<string>('id', { hr_workspace_id: id });
      and.push({ $or: [{ hr_workspace_id: id, owner_type: 'hr_workspace' }, { employee_id: { $in: emps } }] });
    }
    if (q.category) and.push({ $or: [{ doc_category: q.category }, { doc_category: null, category: { $in: legacyCategoriesOf(q.category) } }] });
    if (q.typeKey) and.push({ type_key: q.typeKey });
    const today = istToday();
    if (q.status === 'expired') and.push({ verification_status: 'verified', $or: [{ expired_at: { $ne: null } }, { expires_on: { $lt: today } }] });
    else if (q.status === 'unverified') and.push({ verification_status: null });
    else if (q.status) and.push({ verification_status: q.status });
    if (q.requestedBy) {
      if (q.requestedBy === 'none') and.push({ request_id: null });
      else and.push({ request_id: { $in: await tx.collection('document_requests').distinct<string>('id', { requester_level: q.requestedBy }) } });
    }
    if (q.verifierMembershipId) and.push({ verified_by_membership_id: q.verifierMembershipId });
    if (q.from) and.push({ created_at: { $gte: new Date(`${q.from}T00:00:00+05:30`) } });
    if (q.to) and.push({ created_at: { $lt: new Date(Date.parse(`${q.to}T00:00:00+05:30`) + 86_400_000) } });
    if (q.q) {
      const emps = await tx.collection('employees').distinct<string>('id', nameFilter(q.q));
      const ws = await tx.collection('hr_workspaces').distinct<string>('id', { name: ilike(q.q) });
      const cat = await this.catalogue(tx);
      const types = cat.types.filter((x) => x.name.toLowerCase().includes(q.q!.toLowerCase())).map((x) => x.key);
      const groups = cat.groups.filter((g) => g.name.toLowerCase().includes(q.q!.toLowerCase())).map((g) => g.key);
      const reqs = await tx.collection('document_requests').distinct<string>('id', { reference: ilike(q.q) });
      and.push({ $or: [{ title: ilike(q.q) }, { reference: ilike(q.q) }, { employee_id: { $in: emps } }, { owner_type: 'hr_workspace', hr_workspace_id: { $in: ws } }, { type_key: { $in: types } }, { doc_category: { $in: groups } }, { request_id: { $in: reqs } }] });
    }
    return { $and: and };
  }

  async repository(q: DocumentRepositoryQuery) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const filter = await this.repoFilter(tx, v, q);
      const total = await tx.collection('employee_documents').count(filter);
      const rows = await tx.collection('employee_documents').find(filter, { sort: { created_at: -1 }, skip: q.offset, limit: q.limit });
      return { items: await this.docViews(tx, v, rows), total, level: v.level };
    });
  }

  /** The Documents section of a person's profile (every document they have, with its status and history links). */
  async employeeDocuments(employeeId: string, q: Partial<DocumentRepositoryQuery> = {}) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const e = await tx.collection('employees').findOne({ id: employeeId });
      if (!e) throw Errors.notFound('Employee');
      const self = v.s.employeeId === employeeId;
      if (!v.isSuper && !self && !hrCovers(v, e) && !sharedAccess(v, e.hr_workspace_id ?? null) && !(v.s.reportEmployeeIds?.has(employeeId))) {
        await this.authz.require('documents:read', employeeAttrsOf(e), tx);
      }
      const filter = await this.repoFilter(tx, v, { ...q, employeeId, includeReplaced: q.includeReplaced ?? false });
      const rows = await tx.collection('employee_documents').find(filter, { sort: { created_at: -1 }, limit: 500 });
      return this.docViews(tx, v, rows);
    });
  }

  /** The Documents section of an HR Workspace's profile. */
  async hrWorkspaceDocuments(hrWorkspaceId: string, q: Partial<DocumentRepositoryQuery> = {}) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const w = await tx.collection('hr_workspaces').findOne({ id: hrWorkspaceId });
      if (!w) throw Errors.notFound('HR Workspace');
      if (!v.isSuper && !accessFor(v, hrWorkspaceId)?.view_hr_documents && !sharedAccess(v, hrWorkspaceId)) throw Errors.notFound('HR Workspace');
      const filter = await this.repoFilter(tx, v, { ...q, owner: 'hr_workspace' });
      const rows = await tx.collection('employee_documents').find({ $and: [filter, { hr_workspace_id: hrWorkspaceId }] }, { sort: { created_at: -1 }, limit: 500 });
      const requests = await tx.collection('document_requests').find({ target_type: 'hr_workspace', hr_workspace_id: hrWorkspaceId }, { sort: { created_at: -1 }, limit: 200 });
      return { documents: await this.docViews(tx, v, rows), requests: await this.requestViews(tx, v, requests) };
    });
  }

  /** The dashboard numbers, within what the viewer may see. */
  async overview() {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const base = await this.repoFilter(tx, v, {});
      const docs = tx.collection('employee_documents');
      const count = (extra: Doc) => docs.count({ $and: [base, extra] });
      const today = istToday();
      const reqFilter: Doc = v.isSuper ? {} : v.hr ? { $or: [{ requested_by_membership_id: v.s.membershipId }, ...(v.hr.companyWide ? [{ requester_level: 'hr_workspace', requester_hr_workspace_id: null }] : [{ requester_hr_workspace_id: { $in: v.hr.workspaceIds } }])] } : { requested_by_membership_id: v.s.membershipId };
      const [total, approved, pending, rejected, correction, hrDocs, employeeDocs, expired] = await Promise.all([
        count({}), count({ verification_status: 'verified' }), count({ verification_status: 'pending' }), count({ verification_status: 'rejected' }), count({ verification_status: 'correction_required' }),
        count({ owner_type: 'hr_workspace' }), count({ owner_type: { $ne: 'hr_workspace' } }), count({ verification_status: 'verified', $or: [{ expired_at: { $ne: null } }, { expires_on: { $lt: today } }] }),
      ]);
      const [openRequests, overdue, awaitingReview] = await Promise.all([
        tx.collection('document_requests').count({ ...reqFilter, status: { $in: [...AWAITING_SUBMISSION] } }),
        tx.collection('document_requests').count({ ...reqFilter, status: { $in: [...AWAITING_SUBMISSION] }, due_on: { $lt: today } }),
        (async () => (await this.approvals.waitingFor(tx, v.s.membershipId, 'document_request')).length)(),
      ]);
      return { level: v.level, total, approved, pending, rejected, correction, expired, hrWorkspaceDocuments: hrDocs, employeeDocuments: employeeDocs, pendingRequests: openRequests, overdueRequests: overdue, awaitingMyVerification: awaitingReview };
    });
  }

  /** One document: preview rights, versions of the same requirement, its request and its full history. */
  async document(id: string) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const { d } = await this.loadDoc(tx, v, id);
      // All versions of the same requirement: follow previous links back, and later versions forward.
      const chain: Doc[] = [d];
      let cur = d;
      while (cur.previous_document_id && chain.length < 50) {
        const p = await tx.collection('employee_documents').findOne({ id: cur.previous_document_id });
        if (!p) break;
        chain.push(p);
        cur = p;
      }
      cur = d;
      for (let i = 0; i < 50; i++) {
        const n = await tx.collection('employee_documents').findOne({ previous_document_id: cur.id });
        if (!n) break;
        chain.unshift(n);
        cur = n;
      }
      const visible = chain.filter((x) => x.id === d.id || this.docRights(v, x, undefined) || x.employee_id === d.employee_id || x.hr_workspace_id === d.hr_workspace_id);
      const [view] = await this.docViews(tx, v, [d]);
      const request = d.request_id ? await tx.collection('document_requests').findOne({ id: d.request_id }) : undefined;
      const requestView = request && (await this.mayReadRequest(tx, v, request)) ? (await this.requestViews(tx, v, [request], { approvers: true }))[0] : null;
      return {
        ...view!,
        submitterRemarks: (d.submitter_remarks ?? null) as string | null,
        versions: await this.docViews(tx, v, visible),
        request: requestView,
        history: await this.history(tx, { $or: [{ document_id: { $in: chain.map((x) => x.id) } }, { request_id: { $in: chain.map((x) => x.request_id).filter(Boolean) } }] }),
        approvalTrail: request?.approval_request_id ? await this.approvals.trail(tx, request.approval_request_id) : [],
        canRequestReplacement: (v.isSuper || (!!v.hr && (d.owner_type === 'hr_workspace' ? false : !!accessFor(v, (d.employee_id ? (await tx.collection('employees').findOne({ id: d.employee_id }))?.hr_workspace_id : null) ?? null)?.request))) && !d.superseded_at && (d.verification_status === 'verified' || !!d.expired_at),
      };
    });
  }

  private async history(tx: TenantTx, filter: Doc, newest?: number) {
    const rows = newest
      ? await tx.collection('document_activity').find(filter, { sort: { created_at: -1 }, limit: newest })
      : await tx.collection('document_activity').find(filter, { sort: { created_at: 1 }, limit: 500 });
    const people = await this.people(tx, rows.map((r) => r.actor_membership_id));
    return rows.map((r) => ({
      id: r.id as string, action: r.action as string, at: iso(r.created_at)!, by: people.get(r.actor_membership_id)?.name ?? (r.actor_level === 'system' ? 'SampCrew' : null),
      byDesignation: people.get(r.actor_membership_id)?.designation ?? null,
      level: r.actor_level === 'system' ? 'System' : ACCESS_LEVEL_LABEL[r.actor_level as 'super_workspace'] ?? r.actor_level, comment: (r.comment ?? null) as string | null,
      documentId: (r.document_id ?? null) as string | null, requestId: (r.request_id ?? null) as string | null, metadata: (r.metadata ?? {}) as Record<string, unknown>,
    }));
  }

  /** Recent document activity the viewer may see (Super Workspace: everything; HR Workspace: its documents). */
  async recentActivity(limit = 100) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      if (!v.isSuper && !v.hr) throw Errors.forbidden();
      let filter: Doc = {};
      if (!v.isSuper) {
        const docs = await tx.collection('employee_documents').distinct<string>('id', await this.repoFilter(tx, v, { includeReplaced: true }));
        const reqs = await tx.collection('document_requests').distinct<string>('id', { $or: [{ requested_by_membership_id: v.s.membershipId }, { document_id: { $in: docs } }] });
        filter = { $or: [{ document_id: { $in: docs } }, { request_id: { $in: reqs } }] };
      }
      return this.history(tx, filter, limit);
    });
  }

  /** Short-lived link to open (preview) or save (download) a file, after the same checks as every other read. */
  async link(id: string, mode: 'preview' | 'download') {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      const { d, rights } = await this.loadDoc(tx, v, id);
      if (mode === 'preview' && !rights.preview) throw Errors.forbidden('Super Workspace has not allowed previewing documents for your HR Workspace');
      if (mode === 'download' && !rights.download) throw Errors.forbidden('Super Workspace has not allowed downloading documents for your HR Workspace');
      const type = builtInType(d.type_key);
      await this.activity(tx, v, { action: mode === 'preview' ? 'viewed' : 'downloaded', documentId: id, requestId: d.request_id, employeeId: d.employee_id, hrWorkspaceId: d.hr_workspace_id, metadata: { sensitive: !!type?.sensitive } });
      await this.audit.record(tx, { action: mode === 'preview' ? 'document.previewed' : 'document.downloaded', resourceType: d.employee_id ? 'employee' : 'hr_workspace', resourceId: d.employee_id ?? d.hr_workspace_id, metadata: { documentId: id, title: d.title, sensitive: !!type?.sensitive } });
      return { ...this.storage.sign(id), mode, contentType: d.content_type as string };
    });
  }

  /** The document list as a spreadsheet (records, never files), for people allowed to export. */
  async exportCsv(q: DocumentRepositoryQuery) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      if (!v.isSuper) {
        const scopes = v.hr ? (v.hr.companyWide ? [CENTRAL] : v.hr.workspaceIds) : [];
        if (!scopes.some((sc) => v.book.get(sc === CENTRAL ? null : sc).export)) throw Errors.forbidden('Super Workspace has not allowed exporting document records');
      }
      const filter = await this.repoFilter(tx, v, q);
      const rows = await tx.collection('employee_documents').find(filter, { sort: { created_at: -1 }, limit: 10_000 });
      const views = await this.docViews(tx, v, rows);
      const cell = (x: unknown) => {
        const s = x === null || x === undefined ? '' : String(x);
        const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
        return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
      };
      const head = ['Reference', 'Document', 'Type', 'Category', 'Owner', 'Employee code', 'HR Workspace', 'Requested by', 'Submitted by', 'Submitted on', 'Status', 'Verified by', 'Verified on', 'Expires on', 'Version'];
      const lines = views.map((d) => [d.reference, d.title, d.typeName, d.categoryName, d.employee?.name ?? d.hrWorkspace?.name, d.employee?.code, d.hrWorkspace?.name, d.requestedBy?.label, d.submittedBy, d.createdAt.slice(0, 10), d.statusLabel, d.verifiedBy?.name, d.verifiedAt?.slice(0, 10), d.expiresOn, d.version].map(cell).join(','));
      await this.activity(tx, v, { action: 'exported', metadata: { count: views.length } });
      await this.audit.record(tx, { action: 'document.exported', resourceType: 'document', resourceId: null, metadata: { count: views.length } });
      return `${head.join(',')}\n${lines.join('\n')}\n`;
    });
  }

  /**
   * Adding or archiving a file on a person's profile (the earlier profile upload): HR Workspace people may do it only
   * while Super Workspace leaves their document management switched on. Super Workspace and the person always may.
   */
  async assertMayManageProfile(employeeId: string) {
    return this.db.tenant(async (tx) => {
      const v = await this.viewer(tx);
      if (v.isSuper || v.s.employeeId === employeeId || !v.hr) return;
      const e = await tx.collection('employees').findOne({ id: employeeId });
      if (!e || !hrCovers(v, e, 'documents:manage')) return; // the upload's own checks answer
      const a = accessFor(v, e.hr_workspace_id ?? null);
      if (!a?.enabled || !(a.view_employee || a.view_approved)) throw Errors.forbidden('Super Workspace has switched off document management for your HR Workspace');
    });
  }

  async assertMayArchive(documentId: string) {
    const employeeId = await this.db.tenant(async (tx) => (await tx.collection('employee_documents').findOne({ id: documentId }, { projection: { employee_id: 1 } }))?.employee_id as string | undefined);
    if (employeeId) await this.assertMayManageProfile(employeeId);
  }

  // Reminders, overdue notices and expiry (hourly) ----------------------------------------------------------------

  async sweepAll(today = istToday()) {
    const release = await this.db.tryLease('document_sweep', 30 * 60 * 1000);
    if (!release) return 0;
    try {
      const tenants = new Set([
        ...(await this.db.platform((tx) => tx.collection('document_requests').distinct<string>('tenant_id', { status: { $in: [...AWAITING_SUBMISSION] }, due_on: { $ne: null } }))),
        ...(await this.db.platform((tx) => tx.collection('employee_documents').distinct<string>('tenant_id', { verification_status: 'verified', expires_on: { $lt: today }, expired_at: null }))),
      ]);
      let n = 0;
      for (const tenantId of tenants) n += await this.db.tenant((tx) => this.sweep(tx, today), { tenantId });
      return n;
    } finally {
      await release();
    }
  }

  /** Deadline reminders (two days before), overdue notices (once) and expired documents (once), for one company. */
  async sweep(tx: TenantTx, today = istToday()) {
    let n = 0;
    const soon = await tx.collection('document_requests').find({ status: { $in: [...AWAITING_SUBMISSION] }, due_on: { $gte: today, $lte: addDays(today, 2) }, reminder_sent_on: null }, { limit: 500 });
    for (const r of soon) {
      if (!(await tx.collection('document_requests').updateOne({ id: r.id, reminder_sent_on: null }, { $set: { reminder_sent_on: today } }))) continue;
      await this.notifications.notify(tx, { membershipIds: [r.assignee_membership_id], kind: 'document.deadline', title: `Reminder: submit your ${r.title} by ${r.due_on}`, link: `/documents/requests/${r.id}`, priority: 'high', email: true, dedupeKey: `docreq:${r.id}:reminder`, resource: { type: 'document_request', id: r.id } });
      await this.activity(tx, null, { action: 'reminder', requestId: r.id, employeeId: r.employee_id, hrWorkspaceId: r.hr_workspace_id });
      n++;
    }
    const late = await tx.collection('document_requests').find({ status: { $in: [...AWAITING_SUBMISSION] }, due_on: { $lt: today }, overdue_notified_at: null }, { limit: 500 });
    for (const r of late) {
      if (!(await tx.collection('document_requests').updateOne({ id: r.id, overdue_notified_at: null }, { $set: { overdue_notified_at: new Date() } }))) continue;
      await this.notifications.notify(tx, { membershipIds: [r.assignee_membership_id], kind: 'document.overdue', title: `Overdue: your ${r.title} was due on ${r.due_on}`, body: 'Please submit it as soon as you can.', link: `/documents/requests/${r.id}`, priority: 'high', email: true, dedupeKey: `docreq:${r.id}:overdue`, resource: { type: 'document_request', id: r.id } });
      await this.notifications.notify(tx, { membershipIds: [r.requested_by_membership_id], kind: 'document.overdue', title: `Overdue: ${r.title} (${r.reference}) was due on ${r.due_on}`, link: `/documents/requests/${r.id}`, dedupeKey: `docreq:${r.id}:overdue:requester`, resource: { type: 'document_request', id: r.id } });
      await this.activity(tx, null, { action: 'overdue', requestId: r.id, employeeId: r.employee_id, hrWorkspaceId: r.hr_workspace_id });
      n++;
    }
    const expired = await tx.collection('employee_documents').find({ verification_status: 'verified', expires_on: { $lt: today }, expired_at: null, superseded_at: null, archived_at: null }, { limit: 500 });
    for (const d of expired) {
      if (!(await tx.collection('employee_documents').updateOne({ id: d.id, expired_at: null }, { $set: { expired_at: new Date() } }))) continue;
      const owner = d.employee_id ? await tx.collection('employees').findOne({ id: d.employee_id }, { projection: { membership_id: 1 } }) : undefined;
      const admins = d.owner_type === 'hr_workspace' && d.hr_workspace_id ? (await hrWorkspaceAdmins(tx, [d.hr_workspace_id])).get(d.hr_workspace_id) ?? [] : [];
      const req = d.request_id ? await tx.collection('document_requests').findOne({ id: d.request_id }, { projection: { requested_by_membership_id: 1 } }) : undefined;
      await this.notifications.notify(tx, { membershipIds: [owner?.membership_id, ...admins, req?.requested_by_membership_id], kind: 'document.expired', title: `${d.title} has expired`, body: `It expired on ${d.expires_on}. A replacement can be requested from the document.`, link: `/documents/${d.id}`, priority: 'high', dedupeKey: `doc:${d.id}:expired`, resource: { type: 'document', id: d.id } });
      await this.activity(tx, null, { action: 'expired', documentId: d.id, requestId: d.request_id, employeeId: d.employee_id, hrWorkspaceId: d.hr_workspace_id, metadata: { expiresOn: d.expires_on } });
      n++;
    }
    return n;
  }
}
