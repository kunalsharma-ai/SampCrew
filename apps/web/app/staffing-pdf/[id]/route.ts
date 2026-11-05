import { NextResponse } from 'next/server';
import { apiDownload } from '@/lib/api';

/** Streams a staffing proposal PDF (a sent version, the signed copy, or a preview of the bid now) from the API, which checks access. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new NextResponse('Not found', { status: 404 });
  const q = new URL(req.url).searchParams;
  const version = q.get('version');
  const qs = version && /^[0-9a-f-]{36}$/.test(version) ? `?version=${version}` : '';
  const res = await apiDownload(q.get('signed') === '1' ? `/staffing/bids/${id}/signed.pdf` : `/staffing/bids/${id}/proposal.pdf${qs}`);
  if (!res.ok || !res.body) return new NextResponse('Not available', { status: res.status === 401 ? 401 : 404 });
  const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  for (const h of ['content-type', 'content-disposition', 'content-length']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { headers });
}
