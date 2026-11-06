'use server';
import type { CompanyBanner, SaveSignatureInput, SignatureBannerInput, SignatureSettingsInput } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';

const refresh = () => {
  revalidatePath('/settings/signature');
  revalidatePath('/settings/signature/company');
};

export async function saveSignatureAction(body: SaveSignatureInput) {
  const r = await act(() => api('/signatures/me', { method: 'PUT', body }), 'Your signature is saved. Connected computers pick it up at their next sync.');
  refresh();
  return r;
}

export async function requestSyncAction() {
  const r = await act(() => api('/signatures/me/sync-request', { method: 'POST' }), 'Your computers will install the signature again at their next check.');
  refresh();
  return r;
}

/** Connects a computer and returns its setup file. The file holds that computer's own token, so it is shown only once. */
export async function addComputerAction(name: string) {
  const r = await act(() => api<{ id: string; fileName: string; installer: string }>('/signatures/me/agents', { method: 'POST', body: { name } }));
  refresh();
  return r;
}

export async function revokeComputerAction(id: string) {
  const r = await act(() => api(`/signatures/me/agents/${id}`, { method: 'DELETE' }), 'Computer disconnected. It no longer receives your signature.');
  refresh();
  return r;
}

export async function saveCompanySignatureAction(body: SignatureSettingsInput) {
  const r = await act(() => api('/signatures/settings', { method: 'PUT', body }), 'Company signature settings saved.');
  refresh();
  return r;
}

export async function uploadSignatureLogoAction(form: FormData) {
  const r = await act(() => apiForm('/signatures/settings/logo', form, { method: 'PUT' }), 'Logo saved.');
  refresh();
  return r;
}

export async function removeSignatureLogoAction() {
  const r = await act(() => api('/signatures/settings/logo', { method: 'DELETE' }), 'Logo removed.');
  refresh();
  return r;
}

export async function adminRevokeComputerAction(id: string) {
  const r = await act(() => api(`/signatures/agents/${id}`, { method: 'DELETE' }), 'Computer disconnected.');
  refresh();
  return r;
}

export async function saveBannerAction(id: string | null, body: SignatureBannerInput) {
  const r = await act(() => api<CompanyBanner>(id ? `/signatures/banners/${id}` : '/signatures/banners', { method: id ? 'PUT' : 'POST', body }), id ? 'Banner saved.' : 'Banner added.');
  refresh();
  return r;
}

export async function deleteBannerAction(id: string) {
  const r = await act(() => api(`/signatures/banners/${id}`, { method: 'DELETE' }), 'Banner deleted.');
  refresh();
  return r;
}

export async function uploadBannerImageAction(id: string, form: FormData) {
  const r = await act(() => apiForm<CompanyBanner>(`/signatures/banners/${id}/image`, form, { method: 'PUT' }), 'Banner image saved.');
  refresh();
  return r;
}

export async function removeBannerImageAction(id: string) {
  const r = await act(() => api(`/signatures/banners/${id}/image`, { method: 'DELETE' }), 'Banner image removed.');
  refresh();
  return r;
}
