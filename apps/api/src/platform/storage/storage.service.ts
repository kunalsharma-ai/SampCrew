import { createHmac, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { safeEqual } from '../auth/crypto';

export type FileLinkKind = 'files' | 'resumes' | 'receipts';

/**
 * File storage. The local driver writes under STORAGE_DIR and is meant for development and single-node
 * installs; object storage (S3-compatible) is not wired up yet, and nothing claims otherwise.
 * Downloads go through short-lived HMAC-signed links so files are never served from a guessable path.
 */
@Injectable()
export class StorageService {
  private readonly root: string;
  private readonly secret: Buffer;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.root = resolve(config.STORAGE_DIR);
    this.secret = config.FILE_URL_SECRET
      ? Buffer.from(config.FILE_URL_SECRET)
      : createHmac('sha256', Buffer.from(config.FIELD_ENCRYPTION_KEY, 'base64')).update('crew-file-links').digest();
  }

  readonly driver = 'local' as const;

  newKey(tenantId: string) {
    return `${tenantId}/${randomUUID()}`;
  }

  private path(key: string) {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)) throw new Error('Invalid storage key');
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return p;
  }

  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { flag: 'wx' });
  }

  async open(key: string): Promise<{ stream: Readable; size: number }> {
    const p = this.path(key);
    const s = await stat(p);
    return { stream: createReadStream(p), size: s.size };
  }

  /**
   * A link valid for ttlSeconds, bound to one file id and to the kind of file, so a link to an employee document
   * can never open a candidate's resume or the reverse.
   */
  sign(fileId: string, ttlSeconds = 300, kind: FileLinkKind = 'files') {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = this.signature(fileId, exp, kind);
    const path = `/api/v1/${kind === 'files' ? 'files' : `files/${kind}`}/${fileId}?exp=${exp}&sig=${sig}`;
    return { url: `${this.config.API_PUBLIC_URL}${path}`, path, expiresAt: new Date(exp * 1000).toISOString() };
  }

  verify(fileId: string, exp: number, sig: string, kind: FileLinkKind = 'files') {
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
    return safeEqual(this.signature(fileId, exp, kind), sig);
  }

  /** Deletes a stored file. Missing files are ignored (the goal is that the data is gone). */
  async remove(key: string) {
    await unlink(this.path(key)).catch((e: { code?: string }) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }

  private signature(fileId: string, exp: number, kind: FileLinkKind) {
    // Employee document links keep their original form so links issued before this change still verify.
    const payload = kind === 'files' ? `${fileId}.${exp}` : `${kind}:${fileId}.${exp}`;
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

/** Checks a file's leading bytes against its declared type, so a renamed executable is not accepted as a PDF. */
export function sniffMatches(contentType: string, head: Buffer): boolean {
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  switch (contentType) {
    case 'application/pdf':
      return starts(0x25, 0x50, 0x44, 0x46);
    case 'image/png':
      return starts(0x89, 0x50, 0x4e, 0x47);
    case 'image/jpeg':
      return starts(0xff, 0xd8, 0xff);
    case 'image/webp':
      return starts(0x52, 0x49, 0x46, 0x46) && head.subarray(8, 12).toString('ascii') === 'WEBP';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return starts(0x50, 0x4b, 0x03, 0x04);
    case 'text/plain':
      return !head.subarray(0, 512).includes(0);
    default:
      return false;
  }
}
