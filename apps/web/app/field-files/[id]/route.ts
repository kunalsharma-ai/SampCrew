import { streamSignedFile } from '@/lib/download';

/** The file stored in a custom file field; the API checks the field's and the record's access and records the download. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return streamSignedFile(`/custom-fields/files/${encodeURIComponent(id)}/link`);
}
