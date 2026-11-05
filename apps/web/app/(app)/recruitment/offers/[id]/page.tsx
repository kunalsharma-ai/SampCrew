import { redirect } from 'next/navigation';
import { load } from '@/lib/api';

/** Approval notifications link to an offer; open the candidate it belongs to. */
export default async function OfferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const o = await load<{ candidateId: string }>(`/recruitment/offers/${id}`);
  redirect(`/recruitment/candidates/${o.candidateId}`);
}
