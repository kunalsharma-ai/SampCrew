import { NextResponse } from 'next/server';
import { apiRaw } from '@/lib/api';

/** A file the workspace shared with the agency, through the agency's private link (the API checks and audits it). */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string; fileId: string }> }) {
  const { token, fileId } = await params;
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token) || !/^[0-9a-f-]{36}$/i.test(fileId)) return new NextResponse('File not found', { status: 404 });
  const res = await apiRaw(`/api/v1/bgv-portal/${token}/files/${fileId}`);
  if (!res.ok || !res.body) return new NextResponse('File not found', { status: 404 });
  const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  for (const h of ['content-type', 'content-length', 'content-disposition']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { headers });
}
