import { NextResponse } from 'next/server';
import { ApiError, api, apiRaw } from '@/lib/api';

/**
 * Learning files (videos, audio, documents, images and assignment files). The API checks the person may see the file
 * and issues a short signed link; the file streams through here. Range requests pass through so videos can be seeked.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new NextResponse('File not found', { status: 404 });
  try {
    const link = await api<{ path: string }>(`/learning/files/${id}/link`, { method: 'POST' });
    const range = req.headers.get('range');
    const file = await apiRaw(link.path, range && /^bytes=\d*-\d*$/.test(range) ? { range } : undefined);
    if (file.status === 416) return new NextResponse(null, { status: 416, headers: { 'content-range': file.headers.get('content-range') ?? '' } });
    if (!file.ok || !file.body) return new NextResponse('File not found', { status: 404 });
    const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    for (const h of ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges']) {
      const v = file.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new NextResponse(file.body, { status: file.status, headers });
  } catch (e) {
    if (e instanceof ApiError) return new NextResponse(e.status === 401 ? 'Sign in again to open this file' : 'File not found', { status: e.status === 401 ? 401 : 404 });
    throw e;
  }
}
