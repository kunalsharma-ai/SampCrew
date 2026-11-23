import { NextResponse } from 'next/server';
import { apiDownload } from '@/lib/api';

/** Console downloads that the API builds and audits (it checks reports:export or audit:export for the admin). */
const ALLOWED = [/^clients\/export$/, /^reports\/(workspaces|business|subscriptions|payments)$/, /^audit-log\/export$/];

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join('/');
  if (!ALLOWED.some((r) => r.test(path))) return new NextResponse('Not found', { status: 404 });
  const qs = new URL(req.url).searchParams;
  if (!['csv', 'xlsx', 'pdf'].includes(qs.get('format') ?? '')) qs.set('format', 'csv');
  const res = await apiDownload(`/platform/${path}?${qs}`);
  if (!res.ok || !res.body) {
    const e = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return new NextResponse(e.error?.message ?? 'This download is not available.', { status: res.status === 401 ? 401 : res.status === 403 ? 403 : 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  for (const h of ['content-type', 'content-disposition']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { headers });
}
