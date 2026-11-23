import { NextResponse } from 'next/server';
import { ApiError, apiForm } from '@/lib/api';

/**
 * Submits a requested document. The browser posts here with XMLHttpRequest (so it can show upload progress); the
 * file is passed to the API with the person's session, which checks it (type, content, size, virus scan) and files it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
  // Only this site's own pages may post here (cookies are SameSite=Lax, and the origin is checked as well).
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (origin && host && new URL(origin).host !== host) return NextResponse.json({ error: { message: 'Not allowed' } }, { status: 403 });
  const form = await req.formData();
  const out = new FormData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: { code: 'file_required', message: 'Attach a file' } }, { status: 400 });
  out.set('file', file, file.name);
  for (const k of ['remarks', 'expiresOn']) {
    const v = form.get(k);
    if (typeof v === 'string' && v.trim()) out.set(k, v.slice(0, 2000));
  }
  try {
    const r = await apiForm(`/document-requests/${id}/submit`, out);
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof ApiError) return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    throw e;
  }
}
