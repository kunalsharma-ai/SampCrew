'use server';
import type { PublicProposal } from '@crew/contracts';
import { act, api } from '@/lib/api';

const token = (t: string) => (/^[A-Za-z0-9_-]{32}$/.test(t) ? t : 'invalid');

/** The client's answer, passed straight to the API without any session. */
export async function acceptProposalAction(t: string, body: { signerName: string; signerTitle: string; signerEmail: string; signature: string; authorised: boolean }) {
  return act(() => api<PublicProposal>(`/public/proposals/${token(t)}/accept`, { method: 'POST', body, auth: false }));
}

export async function declineProposalAction(t: string, body: { signerName: string; signerEmail: string; reason: string }) {
  return act(() => api<PublicProposal>(`/public/proposals/${token(t)}/decline`, { method: 'POST', body, auth: false }));
}
