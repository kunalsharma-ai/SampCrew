import { streamSignedFile } from '@/lib/download';

/** A background verification case file (the API checks Background verification access and audits the download). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return streamSignedFile(`/bgv/files/${encodeURIComponent(id)}/link`);
}
