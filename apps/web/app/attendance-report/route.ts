import { NextResponse } from 'next/server';
import { apiDownload } from '@/lib/api';

const PASS = ['from', 'to', 'format', 'scope', 'employeeIds', 'departmentIds', 'modes', 'sheets', 'section', 'status', 'verification',
  'departmentId', 'designationId', 'locationId', 'hrWorkspaceId', 'employeeId', 'managerId', 'level', 'q'];

/**
 * The attendance report (8-sheet Excel workbook or CSV) from the API, with the filters chosen. The API decides what the
 * person may see, checks the export permission, includes every matching record and audits the export.
 */
export async function GET(req: Request) {
  const src = new URL(req.url).searchParams;
  const qs = new URLSearchParams();
  for (const k of PASS) {
    const v = src.get(k);
    if (v) qs.set(k, v.slice(0, k === 'employeeIds' || k === 'departmentIds' ? 40_000 : 200));
  }
  const res = await apiDownload(`/attendance/work-mode/report?${qs}`);
  if (!res.ok || !res.body) {
    const e = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return new NextResponse(e.error?.message ?? 'Report not available', { status: [401, 403, 404, 422].includes(res.status) ? res.status : 400 });
  }
  const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  for (const h of ['content-type', 'content-disposition', 'content-length', 'x-report-rows']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { headers });
}
