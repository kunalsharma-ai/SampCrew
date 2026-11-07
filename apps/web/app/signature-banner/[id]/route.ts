import { NextResponse } from 'next/server';
import { apiDownload } from '@/lib/api';

/** A company signature banner image (PNG, JPEG or GIF), for the signature preview. Pages add ?v=<updatedAt>. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse('Not found', { status: 404 });
  const res = await apiDownload(`/signatures/banners/${id}/image`);
  if (!res.ok || !res.body) return new NextResponse('Not found', { status: res.status === 401 ? 401 : 404 });
  const headers = new Headers({ 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' });
  for (const h of ['content-type', 'content-length']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { headers });
}
