import { NextResponse } from 'next/server';
import { apiDownload } from '@/lib/api';

/** Streams a privacy access export (JSON) from the API, which checks permission and audits every download. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new NextResponse('Not found', { status: 404 });
  const res = await apiDownload(`/privacy/requests/${id}/export`);
  if (!res.ok || !res.body) {
    const e = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return new NextResponse(e.error?.message ?? 'Not available', { status: res.status === 401 ? 401 : res.status === 409 ? 409 : 404 });
  }
  const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  for (const h of ['content-type', 'content-disposition', 'content-length']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { headers });
}
