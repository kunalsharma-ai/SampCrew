import { NextResponse } from 'next/server';
import { apiDownload } from '@/lib/api';

/** The company logo used in email signatures, for the signature preview. Pages add ?v=<updatedAt> so a new logo shows at once. */
export async function GET() {
  const res = await apiDownload('/signatures/logo');
  if (!res.ok || !res.body) return new NextResponse('Not found', { status: res.status === 401 ? 401 : 404 });
  const headers = new Headers({ 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' });
  for (const h of ['content-type', 'content-length']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { headers });
}
