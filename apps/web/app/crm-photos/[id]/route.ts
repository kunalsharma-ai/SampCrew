import { crmDownload } from '@/lib/crm-download';

/** A candidate's profile photo from Candidate CRM. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response('Photo not found', { status: 404 });
  return crmDownload(`/candidates/${id}/photo`, 'Photo not found');
}
