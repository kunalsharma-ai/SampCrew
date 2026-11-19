import { createHash } from 'node:crypto';
import { DOCUMENT_MAX_BYTES, DOCUMENT_TYPES } from '@crew/contracts';
import { safeFileName } from '../http/content-disposition';
import { Errors } from '../http/errors';
import { sniffMatches, type StorageService } from './storage.service';

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface StoredFile {
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  storage_key: string;
}

/**
 * Checks an upload (PDF, images, Word or text, up to 10 MB, content matching its type) and stores it, virus-scanned
 * when scanning is on. Returns the columns every file table keeps. Call it before the transaction that records the
 * file: a file whose row is never written is only an orphan on disk, never a row without a file.
 */
export async function storeUpload(storage: StorageService, tenantId: string, file: UploadedFile | undefined): Promise<StoredFile> {
  if (!file) throw Errors.badRequest('file_required', 'Attach a file');
  if (!(DOCUMENT_TYPES as readonly string[]).includes(file.mimetype)) throw Errors.badRequest('unsupported_type', 'Upload a PDF, PNG, JPEG, WebP, Word document or plain text file');
  if (file.size <= 0 || file.size > DOCUMENT_MAX_BYTES) throw Errors.badRequest('file_too_large', 'Files can be up to 10 MB');
  if (!sniffMatches(file.mimetype, file.buffer.subarray(0, 512))) throw Errors.badRequest('content_mismatch', 'The file content does not match its type');
  const key = storage.newKey(tenantId);
  await storage.put(key, file.buffer, { upload: true });
  return {
    file_name: safeFileName(file.originalname, 'file'),
    content_type: file.mimetype,
    size_bytes: file.size,
    sha256: createHash('sha256').update(file.buffer).digest('hex'),
    storage_key: key,
  };
}
