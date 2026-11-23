import { IMPORT_TYPES, VALUE_LISTS } from '@crew/contracts';
import { streamExport } from '@/lib/download';

/** A template to fill in for a kind of record (Excel, with an instructions sheet and this workspace's custom fields). */
export async function GET(req: Request, { params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  if (!(IMPORT_TYPES as readonly string[]).includes(type)) return new Response('Not found', { status: 404 });
  const list = new URL(req.url).searchParams.get('list');
  return streamExport(`/imports/templates/${type}${list && (VALUE_LISTS as readonly string[]).includes(list) ? `?list=${list}` : ''}`);
}
