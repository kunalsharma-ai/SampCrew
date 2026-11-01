'use server';
import type { BidInput, BidSendInput, BidTemplateInput, ClientInput } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { Bid, BidTemplate, Client } from './types';

const refresh = (id?: string) => {
  revalidatePath('/staffing/bids');
  if (id) revalidatePath(`/staffing/bids/${id}`);
};

export async function saveClientAction(id: string | null, values: ClientInput) {
  const r = await act(() => api<Client>(id ? `/staffing/clients/${id}` : '/staffing/clients', { method: id ? 'PUT' : 'POST', body: values }), id ? 'Client saved' : 'Client added');
  revalidatePath('/staffing/clients');
  return r;
}

export async function archiveClientAction(id: string) {
  const r = await act(() => api(`/staffing/clients/${id}`, { method: 'DELETE' }), 'Client archived');
  revalidatePath('/staffing/clients');
  return r;
}

export async function saveTemplateAction(id: string | null, values: BidTemplateInput) {
  const r = await act(() => api<BidTemplate>(id ? `/staffing/templates/${id}` : '/staffing/templates', { method: id ? 'PUT' : 'POST', body: values }), 'Template saved');
  revalidatePath('/staffing/templates');
  return r;
}

export async function archiveTemplateAction(id: string) {
  const r = await act(() => api(`/staffing/templates/${id}`, { method: 'DELETE' }), 'Template archived');
  revalidatePath('/staffing/templates');
  return r;
}

/** Saves a bid and, when asked, submits it for approval in the same step. */
export async function saveBidAction(id: string | null, values: BidInput, submit: boolean) {
  const r = await act(() => api<Bid>(id ? `/staffing/bids/${id}` : '/staffing/bids', { method: id ? 'PUT' : 'POST', body: values }));
  if (!r.ok) return r;
  const bidId = r.data!.id;
  if (submit) {
    const s = await act(() => api(`/staffing/bids/${bidId}/submit`, { method: 'POST' }));
    refresh(bidId);
    if (!s.ok) return { ok: false as const, message: `Saved, but not submitted: ${s.message}`, data: { id: bidId } };
  }
  refresh(bidId);
  return { ok: true as const, data: { id: bidId } };
}

export async function bidAction(id: string, action: 'submit' | 'delete') {
  const r = action === 'delete'
    ? await act(() => api(`/staffing/bids/${id}`, { method: 'DELETE' }), 'Draft deleted')
    : await act(() => api(`/staffing/bids/${id}/submit`, { method: 'POST' }), 'Submitted for approval');
  refresh(action === 'delete' ? undefined : id);
  return r;
}

export async function bidOutcomeAction(id: string, outcome: 'won' | 'lost' | 'withdrawn', reason?: string) {
  const r = await act(() => api(`/staffing/bids/${id}/outcome`, { method: 'POST', body: { outcome, reason: reason || undefined } }), outcome === 'withdrawn' ? 'Bid withdrawn' : `Marked as ${outcome}`);
  refresh(id);
  return r;
}

export async function sendBidAction(id: string, values: BidSendInput) {
  const r = await act(() => api<{ id: string; sendAt: string; recipients: number }>(`/staffing/bids/${id}/send`, { method: 'POST', body: values }));
  refresh(id);
  return r;
}

export async function cancelBidEmailAction(id: string, emailId: string) {
  const r = await act(() => api(`/staffing/bids/${id}/emails/${emailId}/cancel`, { method: 'POST' }), 'Scheduled email cancelled');
  refresh(id);
  return r;
}
