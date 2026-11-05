import { NextResponse } from 'next/server';
import { apiDownload } from '@/lib/api';

const PATHS: Record<string, string> = { register: 'register.csv', 'register-xlsx': 'register.xlsx', 'bank-file': 'bank-file.csv' };

/** Streams a payroll export (CSV, or the register as Excel) from the API (which checks access and audits the export). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await params;
  if (!PATHS[kind] || !/^[0-9a-f-]{36}$/.test(id)) return new NextResponse('Not found', { status: 404 });
  const res = await apiDownload(`/payroll/runs/${id}/${PATHS[kind]}`);
  if (!res.ok || !res.body) {
    const e = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return new NextResponse(e.error?.message ?? 'Not available', { status: res.status === 401 ? 401 : res.status === 409 ? 409 : 404 });
  }
  const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  for (const h of ['content-type', 'content-disposition']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { headers });
}
