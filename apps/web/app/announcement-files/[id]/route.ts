import { NextResponse } from 'next/server';
import { ApiError, api, apiRaw } from '@/lib/api';

/** Announcement attachments: the API checks the announcement is addressed to you and issues a short signed link. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new NextResponse('File not found', { status: 404 });
  try {
    const link = await api<{ path: string }>(`/announcements/files/${id}/link`, { method: 'POST' });
    const file = await apiRaw(link.path);
    if (!file.ok || !file.body) return new NextResponse('File not found', { status: 404 });
    const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    for (const h of ['content-type', 'content-length', 'content-disposition']) {
      const v = file.headers.get(h);
      if (v) headers.set(h, v);
    }
    // ?view=1 opens a PDF, picture or text file in the browser tab instead of saving it.
    const type = headers.get('content-type') ?? '';
    if (new URL(req.url).searchParams.get('view') === '1' && /^(application\/pdf|image\/(png|jpeg|webp|gif)|text\/plain)\b/.test(type)) {
      const disposition = headers.get('content-disposition');
      headers.set('content-disposition', disposition ? disposition.replace(/^attachment/i, 'inline') : 'inline');
    }
    return new NextResponse(file.body, { headers });
  } catch (e) {
    if (e instanceof ApiError) return new NextResponse(e.status === 401 ? 'Sign in again to download this file' : 'File not found', { status: e.status === 401 ? 401 : 404 });
    throw e;
  }
}
