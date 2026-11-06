import { NextResponse } from 'next/server';
import { apiDownload } from '@/lib/api';

/**
 * An employee's photo, streamed from the API with the viewer's own session (the API checks they may see this
 * employee). Pages add ?v=<photoUpdatedAt> so a new photo is fetched straight away while an unchanged one is cached.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse('Not found', { status: 404 });
  const res = await apiDownload(`/employees/${id}/photo`);
  if (!res.ok || !res.body) return new NextResponse('Not found', { status: res.status === 401 ? 401 : 404 });
  const headers = new Headers({ 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' });
  for (const h of ['content-type', 'content-length']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { headers });
}
