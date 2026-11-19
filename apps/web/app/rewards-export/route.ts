import { NextResponse } from 'next/server';
import { apiDownload } from '@/lib/api';

/** Streams a finished month's attendance reward winners as Excel from the API (HR only; the API checks it). */
export async function GET(req: Request) {
  const month = new URL(req.url).searchParams.get('month');
  const qs = month && /^\d{4}-\d{2}$/.test(month) ? `?month=${month}` : '';
  const res = await apiDownload(`/workspace/reward-winners/export.xlsx${qs}`);
  if (!res.ok || !res.body) {
    const e = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return new NextResponse(e.error?.message ?? 'Export not available', { status: [401, 403, 422].includes(res.status) ? res.status : 400 });
  }
  const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  for (const h of ['content-type', 'content-disposition', 'content-length']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { headers });
}
