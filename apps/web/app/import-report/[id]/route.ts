import { streamExport } from '@/lib/download';

/** The report of an import (Excel): summary, every problem with a suggested correction, the rows to fix and all rows. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  return streamExport(`/imports/${id}/report.xlsx`);
}
