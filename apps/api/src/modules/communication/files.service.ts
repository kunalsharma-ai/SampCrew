import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { COMM_FILE_MAX_BYTES, COMM_FILE_TYPES } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { safeFileName } from '../../platform/http/content-disposition';
import { Errors } from '../../platform/http/errors';
import { sniffMatches, StorageService } from '../../platform/storage/storage.service';
import type { UploadedFile } from '../documents/documents.service';

const OLE = [0xd0, 0xcf, 0x11, 0xe0];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** Checks the first bytes against the declared type (Office files are ZIP or the older OLE format, CSV is text). */
function contentMatches(type: string, head: Buffer): boolean {
  const starts = (bytes: number[]) => bytes.every((b, i) => head[i] === b);
  if (type === 'text/csv') return sniffMatches('text/plain', head);
  if (['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'].includes(type)) return starts(OLE);
  if (type.startsWith('application/vnd.openxmlformats') || type === 'application/zip') return starts(ZIP);
  return sniffMatches(type, head);
}

/**
 * Files attached to chat messages, HR emails and announcements. Uploaded first (checked, scanned when a scanner is
 * set up, stored), then referenced by id. Downloads go through a short signed link, only for people who can see a
 * message, email or announcement the file is on (or who uploaded it).
 */
@Injectable()
export class CommFilesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  async upload(file: UploadedFile | undefined) {
    if (!file) throw Errors.badRequest('no_file', 'Choose a file');
    if (!(COMM_FILE_TYPES as readonly string[]).includes(file.mimetype)) throw Errors.badRequest('unsupported_type', 'Attach a PDF, image, Office document, text, CSV or ZIP file');
    if (file.size <= 0 || file.size > COMM_FILE_MAX_BYTES) throw Errors.badRequest('file_too_large', 'A file can be up to 10 MB');
    if (!contentMatches(file.mimetype, file.buffer.subarray(0, 512))) throw Errors.badRequest('content_mismatch', 'The file content does not match its type');
    const actor = requestContext.tenantActor();
    const key = this.storage.newKey(actor.tenantId);
    await this.storage.put(key, file.buffer, { upload: true });
    try {
      return await this.db.tenant(async (tx) => {
        const row = await tx.collection('comm_files').insert({
          name: safeFileName(file.originalname, 'file'), type: file.mimetype, size: file.size, storage_key: key,
          sha256: createHash('sha256').update(file.buffer).digest('hex'), uploaded_by_membership_id: actor.membershipId,
        });
        return { id: row.id as string, name: row.name as string, type: file.mimetype, size: file.size, href: `/communication-files/${row.id}` };
      });
    } catch (err) {
      await this.storage.remove(key);
      throw err;
    }
  }

  /** A 5-minute download link, after checking the caller may see something the file is attached to. */
  link(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const f = await tx.collection('comm_files').findOne({ id });
      // An erased person's shared files are gone (privacy erasure).
      if (!f || f.name === '[erased]') throw Errors.notFound('File');
      let allowed = f.uploaded_by_membership_id === s.membershipId;
      const hr = hasPermission(s, 'helpdesk:manage').allowed;
      if (!allowed) {
        const convIds = await tx.collection('chat_messages').distinct<string>('conversation_id', { file_ids: id, deleted_at: null });
        if (convIds.length) {
          const member = await tx.collection('chat_members').exists({ conversation_id: { $in: convIds }, membership_id: s.membershipId, left_at: null });
          const hrConv = await tx.collection('chat_conversations').exists({ id: { $in: convIds }, kind: 'hr', ...(hr ? {} : { employee_membership_id: s.membershipId }) });
          allowed = member || hrConv;
        }
      }
      if (!allowed) {
        const emails = await tx.collection('comm_emails').distinct<string>('id', { file_ids: id, status: { $ne: 'draft' } });
        if (emails.length) allowed = hr || (await tx.collection('comm_email_recipients').exists({ email_id: { $in: emails }, membership_id: s.membershipId }));
      }
      if (!allowed) {
        // People reading an announcement download its files through /announcements/files/:id/link (audience checked there).
        allowed = hasPermission(s, 'announcements:manage').allowed && (await tx.collection('announcements').exists({ file_ids: id }));
      }
      if (!allowed) throw Errors.notFound('File');
      await this.audit.record(tx, { action: 'comm_file.downloaded', resourceType: 'comm_file', resourceId: id });
      return this.storage.sign(id, 300, 'comm');
    });
  }

  async open(id: string, exp: number, sig: string) {
    if (!this.storage.verify(id, exp, sig, 'comm')) throw Errors.notFound('File');
    const f = await this.db.platform((tx) => tx.collection<{ storage_key: string; name: string; type: string }>('comm_files').findOne({ id }));
    if (!f) throw Errors.notFound('File');
    const { stream, size } = await this.storage.open(f.storage_key);
    return { stream, size, fileName: f.name, contentType: f.type };
  }
}
