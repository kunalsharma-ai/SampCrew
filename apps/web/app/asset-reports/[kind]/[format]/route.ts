import { ASSET_REPORTS } from '@crew/contracts';
import { NextResponse } from 'next/server';
import { streamExport } from '@/lib/download';

/** An asset report as Excel or PDF, built by the API for the signed-in person (assets:export) and audited. */
export async function GET(req: Request, { params }: { params: Promise<{ kind: string; format: string }> }) {
  const { kind, format } = await params;
  if (!(ASSET_REPORTS as readonly string[]).includes(kind) || !['xlsx', 'pdf'].includes(format)) return new NextResponse('Unknown report', { status: 404 });
  const src = new URL(req.url).searchParams;
  const qs = new URLSearchParams();
  for (const k of ['from', 'to', 'categoryId']) {
    const v = src.get(k);
    if (v) qs.set(k, v.slice(0, 60));
  }
  return streamExport(`/assets/reports/${kind}.${format}?${qs}`);
}
