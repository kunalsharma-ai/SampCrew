import { NextResponse } from 'next/server';
import { passThrough } from '@/lib/crm-download';
import { accessToken } from '@/lib/session';

const API_URL = process.env.CREW_API_URL ?? 'http://localhost:4000';

/**
 * Candidate CRM export to Excel or CSV. The page posts a form (so the browser downloads the file); this sends the
 * request to the API with the person's session. The API applies their access, leaves out private columns they may
 * not see, neutralises spreadsheet formulas and logs every export.
 */
export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  if (origin && new URL(origin).host !== req.headers.get('host')) return new NextResponse('Not allowed', { status: 403 });
  const form = await req.formData().catch(() => null);
  let body: unknown;
  try {
    body = JSON.parse(String(form?.get('payload') ?? ''));
  } catch {
    return new NextResponse('Choose what to export', { status: 400 });
  }
  const token = await accessToken();
  if (!token) return NextResponse.redirect(new URL('/login?expired=1', req.url), 303);
  const res = await fetch(`${API_URL}/api/v1/recruitment/crm/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-crew-client': 'web', authorization: `Bearer ${token}`, ...(req.headers.get('user-agent') ? { 'user-agent': req.headers.get('user-agent')!.slice(0, 500) } : {}) },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  return passThrough(res, 'Export not available');
}
