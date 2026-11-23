import { NextResponse } from 'next/server';
import { ApiError, api, apiRaw } from '@/lib/api';

const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain']);

/**
 * Secure preview: the API checks the person may preview this document (Super Workspace's switches included), records
 * the view and issues a 5-minute link; the file streams through here so the browser never sees an API address.
 * Only PDFs, images and text open inline; anything else is offered as a download (when downloads are allowed).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const link = await api<{ path: string; contentType: string }>(`/documents/${id}/access-link`, { method: 'POST', body: { mode: 'preview' } });
    const file = await apiRaw(link.path);
    if (!file.ok || !file.body) return new NextResponse('File not found', { status: 404 });
    const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    const type = file.headers.get('content-type') ?? link.contentType;
    headers.set('content-type', type);
    const len = file.headers.get('content-length');
    if (len) headers.set('content-length', len);
    const disp = file.headers.get('content-disposition') ?? 'attachment';
    headers.set('content-disposition', INLINE.has(type) ? disp.replace(/^attachment/, 'inline') : disp);
    // A previewed file can never run script or load anything, even if it is an image with tricks in it.
    headers.set('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    return new NextResponse(file.body, { headers });
  } catch (e) {
    if (e instanceof ApiError) {
      const msg = e.status === 401 ? 'Sign in again to open this file' : e.status === 403 ? e.message : 'File not found';
      return new NextResponse(msg, { status: e.status === 401 ? 401 : e.status === 403 ? 403 : 404 });
    }
    throw e;
  }
}
