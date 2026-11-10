import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DOCUMENT_MAX_BYTES, DOCUMENT_TYPES, type documentMetaInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { sniffMatches, StorageService } from '../../platform/storage/storage.service';
import { employeeAttrs } from '../employees/employee-attrs';
import { safeFileName } from '../../platform/http/content-disposition';

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function docViews(tx: TenantTx, docs: Record<string, any>[]) {
  const by = await membershipUserNames(tx, docs.map((d) => d.uploaded_by_membership_id));
  return docs.map((d) => ({
    id: d.id, employeeId: d.employee_id, category: d.category, title: d.title, fileName: d.file_name, contentType: d.content_type, sizeBytes: d.size_bytes,
    sha256: d.sha256, visibility: d.visibility, uploadedBy: by.get(d.uploaded_by_membership_id) ?? null, createdAt: d.created_at,
  }));
}

/**
 * Employee documents. Files are checked (type, size, magic bytes), hashed, stored by the storage driver and
 * downloaded only through short-lived signed links. 'hr_only' documents are hidden from the employee.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationService,
  ) {}

  private async access(tx: TenantTx, employeeId: string) {
    const doc = await tx.collection('employees').findOne({ id: employeeId });
    const e = doc && { id: doc.id as string, membership_id: (doc.membership_id ?? null) as string | null, le: doc.current_legal_entity_id ?? null, d: doc.current_department_id ?? null, l: doc.current_location_id ?? null };
    if (!e) throw Errors.notFound('Employee');
    const attrs = employeeAttrs({ id: e.id, membershipId: e.membership_id, legalEntityId: e.le, departmentId: e.d, locationId: e.l });
    const s = await this.authz.subject(tx);
    const covers = (perm: string) => grantsFor(s, perm).some((g) => g.scope !== 'own' && grantCovers(s, g, attrs));
    return { e, attrs, isSelf: s.employeeId === e.id, canManage: covers('documents:manage'), canRead: covers('documents:read') };
  }

  async list(employeeId: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx, employeeId);
      await this.authz.require('documents:read', a.attrs, tx);
      const docs = await tx.collection('employee_documents').find(
        { employee_id: employeeId, archived_at: null, ...(a.canManage ? {} : { visibility: 'employee' }) },
        { sort: { created_at: -1 } },
      );
      return docViews(tx, docs);
    });
  }

  async upload(employeeId: string, meta: z.infer<typeof documentMetaInput>, file: UploadedFile | undefined) {
    if (!file) throw Errors.badRequest('file_required', 'Attach a file');
    if (!(DOCUMENT_TYPES as readonly string[]).includes(file.mimetype)) throw Errors.badRequest('unsupported_type', 'Upload a PDF, PNG, JPEG, WebP, Word document or plain text file');
    if (file.size <= 0 || file.size > DOCUMENT_MAX_BYTES) throw Errors.badRequest('file_too_large', 'Files can be up to 10 MB');
    if (!sniffMatches(file.mimetype, file.buffer.subarray(0, 512))) throw Errors.badRequest('content_mismatch', 'The file content does not match its type');
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx, employeeId);
      // People who manage documents for this employee can upload anything; employees can add their own,
      // which are always visible to them.
      if (!a.canManage) {
        if (!a.isSelf) {
          await this.authz.require('documents:read', a.attrs, tx);
          throw Errors.forbidden();
        }
        if (meta.visibility === 'hr_only') throw Errors.forbidden('Only HR can add HR-only documents');
      }
      const key = this.storage.newKey(actor.tenantId);
      const sha = createHash('sha256').update(file.buffer).digest('hex');
      const name = safeFileName(file.originalname, 'file');
      await this.storage.put(key, file.buffer, { upload: true });
      const row = await tx.collection('employee_documents').insert({
        employee_id: employeeId, category: meta.category, title: meta.title, file_name: name, content_type: file.mimetype, size_bytes: file.size, sha256: sha,
        storage_key: key, visibility: meta.visibility, uploaded_by_membership_id: actor.membershipId,
      });
      await this.audit.record(tx, { action: 'document.uploaded', resourceType: 'employee', resourceId: employeeId, metadata: { documentId: row.id, category: meta.category, title: meta.title, sha256: sha } });
      if (!a.isSelf && meta.visibility === 'employee') {
        await this.notifications.notify(tx, { membershipIds: [a.e.membership_id], kind: 'document.added', title: `New document: ${meta.title}`, link: `/employees/${employeeId}?tab=documents` });
      }
      return (await docViews(tx, [row]))[0];
    });
  }

  private async loadForAccess(tx: TenantTx, id: string) {
    const d = await tx.collection<{ id: string; employee_id: string; visibility: string; title: string }>('employee_documents').findOne({ id, archived_at: null });
    if (!d) throw Errors.notFound('Document');
    const a = await this.access(tx, d.employee_id);
    await this.authz.require('documents:read', a.attrs, tx);
    if (d.visibility === 'hr_only' && !a.canManage) throw Errors.notFound('Document');
    return { d, a };
  }

  /** Issues a 5-minute download link. Each issue is audited as a view. */
  async link(id: string) {
    return this.db.tenant(async (tx) => {
      const { d } = await this.loadForAccess(tx, id);
      await this.audit.record(tx, { action: 'document.downloaded', resourceType: 'employee', resourceId: d.employee_id, metadata: { documentId: id, title: d.title } });
      return this.storage.sign(id);
    });
  }

  async archive(id: string) {
    return this.db.tenant(async (tx) => {
      const { d, a } = await this.loadForAccess(tx, id);
      if (!a.canManage) throw Errors.forbidden();
      await tx.collection('employee_documents').updateOne({ id }, { $set: { archived_at: new Date() } });
      await this.audit.record(tx, { action: 'document.archived', resourceType: 'employee', resourceId: d.employee_id, metadata: { documentId: id } });
    });
  }

  /** Resolves a signed link. The signature is the authorisation, so this runs without a session. */
  async open(id: string, exp: number, sig: string) {
    if (!this.storage.verify(id, exp, sig)) throw Errors.notFound('File');
    const d = await this.db.platform((tx) =>
      tx.collection<{ storage_key: string; file_name: string; content_type: string }>('employee_documents').findOne({ id, archived_at: null }),
    );
    if (!d) throw Errors.notFound('File');
    const f = await this.storage.open(d.storage_key);
    return { ...f, fileName: d.file_name, contentType: d.content_type };
  }
}
