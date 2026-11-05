import { NextResponse } from 'next/server';
import { ApiError, api, apiRaw } from '@/lib/api';

/**
 * Document download. Asks the API for a short-lived signed link (which checks access and audits the view),
 * then streams the file through the web server so the browser never needs direct API access.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const link = await api<{ path: string }>(`/documents/${id}/link`, { method: 'POST' });
    const file = await apiRaw(link.path);
    if (!file.ok || !file.body) return new NextResponse('File not found', { status: 404 });
    const headers = new Headers();
    for (const h of ['content-type', 'content-length', 'content-disposition']) {
      const v = file.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('cache-control', 'private, no-store');
    headers.set('x-content-type-options', 'nosniff');
    return new NextResponse(file.body, { headers });
  } catch (e) {
    if (e instanceof ApiError) return new NextResponse(e.status === 401 ? 'Sign in again to download this file' : 'File not found', { status: e.status === 401 ? 401 : 404 });
    throw e;
  }
}
