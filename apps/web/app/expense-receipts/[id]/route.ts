import { NextResponse } from 'next/server';
import { ApiError, api, apiRaw } from '@/lib/api';

/** Receipt download: the API issues a short-lived signed link after checking access (and audits it); the file streams through here. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const link = await api<{ path: string }>(`/expenses/claims/${id}/receipt-link`, { method: 'POST' });
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
