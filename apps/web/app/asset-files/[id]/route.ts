import { streamSignedFile } from '@/lib/download';

/** An asset document (invoice, warranty, photo); the API checks asset access and records the download. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return streamSignedFile(`/assets/files/${encodeURIComponent(id)}/link`);
}
