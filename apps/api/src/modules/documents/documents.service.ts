import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DOCUMENT_MAX_BYTES, DOCUMENT_TYPES, type documentMetaInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
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

const DOC_COLUMNS = `d.id, d.employee_id as "employeeId", d.category, d.title, d.file_name as "fileName", d.content_type as "contentType",
  d.size_bytes as "sizeBytes", d.sha256, d.visibility, u.full_name as "uploadedBy", d.created_at as "createdAt"`;

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

  private async access(tx: Tx, employeeId: string) {
    const e = await one<{ id: string; membership_id: string | null; le: string | null; d: string | null; l: string | null }>(
      tx, 'select id, membership_id, current_legal_entity_id as le, current_department_id as d, current_location_id as l from employees where id = $1', [employeeId],
    );
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
      return many(
        tx,
        `select ${DOC_COLUMNS} from employee_documents d left join memberships m on m.id = d.uploaded_by_membership_id left join users u on u.id = m.user_id
          where d.employee_id = $1 and d.archived_at is null and (d.visibility = 'employee' or $2) order by d.created_at desc`,
        [employeeId, a.canManage],
      );
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
      const row = (await one<{ id: string }>(
        tx,
        `insert into employee_documents (tenant_id, employee_id, category, title, file_name, content_type, size_bytes, sha256, storage_key, visibility, uploaded_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [employeeId, meta.category, meta.title, name, file.mimetype, file.size, sha, key, meta.visibility, actor.membershipId],
      ))!;
      await this.audit.record(tx, { action: 'document.uploaded', resourceType: 'employee', resourceId: employeeId, metadata: { documentId: row.id, category: meta.category, title: meta.title, sha256: sha } });
      if (!a.isSelf && meta.visibility === 'employee') {
        await this.notifications.notify(tx, { membershipIds: [a.e.membership_id], kind: 'document.added', title: `New document: ${meta.title}`, link: `/employees/${employeeId}?tab=documents` });
      }
      return one(tx, `select ${DOC_COLUMNS} from employee_documents d left join memberships m on m.id = d.uploaded_by_membership_id left join users u on u.id = m.user_id where d.id = $1`, [row.id]);
    });
  }

  private async loadForAccess(tx: Tx, id: string) {
    const d = await one<{ id: string; employee_id: string; visibility: string; title: string }>(tx, 'select id, employee_id, visibility, title from employee_documents where id = $1 and archived_at is null', [id]);
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
      await tx.query('update employee_documents set archived_at = now() where id = $1', [id]);
      await this.audit.record(tx, { action: 'document.archived', resourceType: 'employee', resourceId: d.employee_id, metadata: { documentId: id } });
    });
  }

  /** Resolves a signed link. The signature is the authorisation, so this runs without a session. */
  async open(id: string, exp: number, sig: string) {
    if (!this.storage.verify(id, exp, sig)) throw Errors.notFound('File');
    const d = await this.db.platform((tx) =>
      one<{ storage_key: string; file_name: string; content_type: string }>(tx, 'select storage_key, file_name, content_type from employee_documents where id = $1 and archived_at is null', [id]),
    );
    if (!d) throw Errors.notFound('File');
    const f = await this.storage.open(d.storage_key);
    return { ...f, fileName: d.file_name, contentType: d.content_type };
  }
}
