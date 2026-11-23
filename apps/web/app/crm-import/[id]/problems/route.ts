import { crmDownload } from '@/lib/crm-download';

/** The rows an import skipped or could not add, with the reason for each, as a spreadsheet. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response('Import not found', { status: 404 });
  return crmDownload(`/imports/${id}/problems.xlsx`, 'Import not found');
}
