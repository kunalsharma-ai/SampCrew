import { NextResponse } from 'next/server';
import { apiDownload } from '@/lib/api';

/** Streams an invoice PDF from the API, which checks billing:read for this workspace. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new NextResponse('Not found', { status: 404 });
  const res = await apiDownload(`/billing/invoices/${id}/pdf`);
  if (!res.ok || !res.body) {
    const e = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return new NextResponse(e.error?.message ?? 'Not available', { status: res.status === 401 ? 401 : 404 });
  }
  const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  for (const h of ['content-type', 'content-disposition']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { headers });
}
