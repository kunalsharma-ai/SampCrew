import { crmDownload } from '@/lib/crm-download';

/** A candidate document from Candidate CRM: `?inline=1` opens PDFs, images and text in the browser, otherwise it downloads. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response('File not found', { status: 404 });
  const inline = new URL(req.url).searchParams.get('inline') === '1';
  return crmDownload(`/documents/${id}${inline ? '?inline=1' : ''}`);
}
