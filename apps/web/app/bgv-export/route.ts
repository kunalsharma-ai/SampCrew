import { streamExport } from '@/lib/download';

const PASS = ['status', 'q', 'method', 'agencyId'];

/** Verification cases as Excel, with the filters on screen. */
export async function GET(req: Request) {
  const src = new URL(req.url).searchParams;
  const qs = new URLSearchParams();
  for (const k of PASS) {
    const v = src.get(k);
    if (v) qs.set(k, v.slice(0, 200));
  }
  return streamExport(`/bgv/cases/export.xlsx?${qs}`);
}
