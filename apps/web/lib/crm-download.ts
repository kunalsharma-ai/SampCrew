import 'server-only';
import { NextResponse } from 'next/server';
import { apiDownload } from './api';

/**
 * Streams a Candidate CRM file (document, photo, spreadsheet) from the API with the person's own session. The API
 * checks access and audits each download; the browser never talks to the API directly.
 */
export async function passThrough(res: Response, fallback = 'File not found') {
  if (!res.ok || !res.body) {
    const e = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const status = [401, 403, 404, 409, 422].includes(res.status) ? res.status : 400;
    return new NextResponse(e.error?.message ?? fallback, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  for (const h of ['content-type', 'content-disposition', 'content-length', 'content-security-policy']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { headers });
}

export const crmDownload = (path: string, fallback?: string) => apiDownload(`/recruitment/crm${path}`).then((r) => passThrough(r, fallback));
