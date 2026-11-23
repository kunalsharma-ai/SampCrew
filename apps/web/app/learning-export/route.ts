import { NextResponse } from 'next/server';
import { apiDownload } from '@/lib/api';

const PASS = ['moduleId', 'employeeId', 'hrWorkspaceId', 'departmentId', 'designationId', 'status', 'from', 'to', 'minScore', 'maxScore', 'q'];

/** The learning report as Excel, with the filters on screen. The API limits it to the people the person may report on and audits it. */
export async function GET(req: Request) {
  const src = new URL(req.url).searchParams;
  const qs = new URLSearchParams();
  for (const k of PASS) {
    const v = src.get(k);
    if (v) qs.set(k, v.slice(0, 100));
  }
  const res = await apiDownload(`/learning/reports/export.xlsx?${qs}`);
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
