import { NextResponse } from 'next/server';
import { ApiError, api, apiRaw } from '@/lib/api';

/** Files on a help query: the API checks the admin may answer it and signs a short link; the file streams through here. */
export async function GET(_req: Request, { params }: { params: Promise<{ queryId: string; fileId: string }> }) {
  const { queryId, fileId } = await params;
  const uuid = /^[0-9a-f-]{36}$/;
  if (!uuid.test(queryId) || !uuid.test(fileId)) return new NextResponse('File not found', { status: 404 });
  try {
    const link = await api<{ path: string }>(`/platform/help/queries/${queryId}/files/${fileId}/link`, { method: 'POST' });
    const file = await apiRaw(link.path);
    if (!file.ok || !file.body) return new NextResponse('File not found', { status: 404 });
    const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    for (const h of ['content-type', 'content-length', 'content-disposition']) {
      const v = file.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new NextResponse(file.body, { headers });
  } catch (e) {
    if (e instanceof ApiError) return new NextResponse(e.status === 401 ? 'Sign in again to download this file' : 'File not found', { status: e.status === 401 ? 401 : 404 });
    throw e;
  }
}
