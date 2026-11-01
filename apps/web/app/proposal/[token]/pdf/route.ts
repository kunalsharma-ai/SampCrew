import { NextResponse } from 'next/server';
import { apiDownload } from '@/lib/api';

/** The proposal PDF behind a client's private link (the signed copy once accepted). No session needed. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return new NextResponse('Not found', { status: 404 });
  const res = await apiDownload(`/public/proposals/${token}/proposal.pdf`);
  if (!res.ok || !res.body) return new NextResponse('Not available', { status: 404 });
  const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  for (const h of ['content-type', 'content-disposition', 'content-length']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { headers });
}
