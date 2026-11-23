import { streamExport } from '@/lib/download';

const PASS = ['q', 'owner', 'employeeId', 'hrWorkspaceId', 'category', 'typeKey', 'status', 'requestedBy', 'from', 'to'];

/** The document list on screen, as CSV (records only, never files). */
export async function GET(req: Request) {
  const src = new URL(req.url).searchParams;
  const qs = new URLSearchParams();
  for (const k of PASS) {
    const v = src.get(k);
    if (v) qs.set(k, v.slice(0, 200));
  }
  qs.set('limit', '200');
  return streamExport(`/documents/center/export.csv?${qs}`);
}
