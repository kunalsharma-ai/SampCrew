import { NextResponse } from 'next/server';
import { apiDownload } from '@/lib/api';

const PASS = ['q', 'status', 'departmentId', 'sort', 'dir', 'columns'];

/**
 * Streams the employee directory as CSV or Excel (`format=xlsx`) from the API, with the filters, sort and columns on screen. The API applies
 * the person's own scope, neutralises spreadsheet formulas and audits every export.
 */
export async function GET(req: Request) {
  const src = new URL(req.url).searchParams;
  const qs = new URLSearchParams();
  for (const k of PASS) {
    const v = src.get(k);
    if (v) qs.set(k, v.slice(0, 400));
  }
  const res = await apiDownload(`/employees/export.${src.get('format') === 'xlsx' ? 'xlsx' : 'csv'}?${qs}`);
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
