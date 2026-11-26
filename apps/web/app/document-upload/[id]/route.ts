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
  // One file, or several for a document that takes more than one (front and back of a card, each mark sheet).
  const files = [...form.getAll('file'), ...form.getAll('files')].filter((f): f is File => f instanceof File).slice(0, 10);
  if (!files.length) return NextResponse.json({ error: { code: 'file_required', message: 'Attach a file' } }, { status: 400 });
  if (files.length === 1) out.set('file', files[0]!, files[0]!.name);
  else for (const f of files) out.append('files', f, f.name);
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
