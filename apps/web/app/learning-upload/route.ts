import { NextResponse } from 'next/server';
import { ApiError, apiForm } from '@/lib/api';

/**
 * Uploads a learning file (module content up to 50 MB, or a file for the person's own assignment). A route rather than
 * a server action because videos are larger than the server action limit. Same-origin requests only; the API checks
 * the person's Learning powers, the type, the size and the file's content.
 */
export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!origin || !host || new URL(origin).host !== host) return NextResponse.json({ ok: false, message: 'Upload refused' }, { status: 403 });
  const purpose = new URL(req.url).searchParams.get('purpose') === 'submission' ? 'submission' : 'content';
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, message: 'The upload did not arrive. Try again.' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) return NextResponse.json({ ok: false, message: 'Choose a file' }, { status: 400 });
  const out = new FormData();
  out.append('file', file, file.name);
  try {
    const data = await apiForm<{ id: string; name: string; type: string; size: number }>(`/learning/files?purpose=${purpose}`, out);
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    if (e instanceof ApiError) return NextResponse.json({ ok: false, message: e.status === 401 ? 'Sign in again to upload' : e.message }, { status: e.status });
    throw e;
  }
}
