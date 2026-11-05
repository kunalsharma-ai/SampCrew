'use server';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';

const refresh = (...paths: string[]) => {
  for (const p of ['/recruitment', '/approvals', ...paths]) revalidatePath(p);
};
const job = (id: string) => `/recruitment/jobs/${id}`;
const cand = (id: string) => `/recruitment/candidates/${id}`;
const nulls = (v: Record<string, unknown>, keys: string[]) => {
  const out = { ...v };
  for (const k of keys) if (!(k in out) || out[k] === '') out[k] = null;
  return out;
};
const lines = (v: unknown) => String(v ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

// Requisitions ----------------------------------------------------------------------------------------------

export async function saveRequisitionAction(id: string | null, values: Record<string, unknown>) {
  const body: Record<string, unknown> = { ...values };
  if ('scorecard' in body) body.scorecard = lines(body.scorecard);
  if ('headcount' in body) body.headcount = Number(body.headcount);
  const clean = id ? body : nulls(body, ['locationId', 'designationId', 'salaryMin', 'salaryMax', 'targetStartDate', 'replacingEmployeeId']);
  const r = await act(() => api<{ id: string }>(id ? `/recruitment/requisitions/${id}` : '/recruitment/requisitions', { method: id ? 'PATCH' : 'POST', body: clean }), id ? 'Requisition updated.' : 'Requisition saved as a draft.');
  refresh(...(id ? [job(id)] : []));
  return r;
}

export async function submitRequisitionAction(id: string) {
  const r = await act(() => api(`/recruitment/requisitions/${id}/submit`, { method: 'POST' }), 'Sent for approval.');
  refresh(job(id));
  return r;
}

export async function requisitionStatusAction(id: string, action: 'open' | 'hold' | 'reopen' | 'close' | 'cancel', reason?: string) {
  const done: Record<string, string> = { open: 'Requisition opened.', hold: 'Requisition on hold.', reopen: 'Requisition reopened.', close: 'Requisition closed.', cancel: 'Requisition cancelled.' };
  const r = await act(() => api(`/recruitment/requisitions/${id}/status`, { method: 'POST', body: { action, reason: reason || undefined } }), done[action]);
  refresh(job(id));
  return r;
}

export async function savePostingAction(id: string, values: Record<string, unknown>) {
  const body = { ...values, showSalary: values.showSalary === 'true' };
  const r = await act(() => api(`/recruitment/requisitions/${id}/posting`, { method: 'PUT', body }), 'Job posting saved.');
  refresh(job(id));
  return r;
}

export async function publishPostingAction(id: string, publish: boolean) {
  const r = await act(() => api(`/recruitment/requisitions/${id}/posting/${publish ? 'publish' : 'unpublish'}`, { method: 'POST' }), publish ? 'Published on your career site.' : 'Taken off your career site.');
  refresh(job(id));
  return r;
}

// Candidates ------------------------------------------------------------------------------------------------

export async function addCandidateAction(values: Record<string, unknown>) {
  const body: Record<string, unknown> = { ...values, lawfulBasisConfirmed: values.lawfulBasisConfirmed === 'true' ? true : undefined };
  if (typeof body.tags === 'string') body.tags = body.tags.split(',').map((t) => t.trim()).filter(Boolean);
  const r = await act(() => api<{ id: string }>('/recruitment/candidates', { method: 'POST', body }), 'Candidate added.');
  refresh('/recruitment/candidates', ...(typeof values.requisitionId === 'string' ? [job(values.requisitionId)] : []));
  return r;
}

export async function updateCandidateAction(id: string, values: Record<string, unknown>) {
  const body: Record<string, unknown> = { ...values };
  if (typeof body.tags === 'string') body.tags = body.tags.split(',').map((t) => t.trim()).filter(Boolean);
  const r = await act(() => api(`/recruitment/candidates/${id}`, { method: 'PATCH', body }), 'Candidate updated.');
  refresh(cand(id));
  return r;
}

export async function addToJobAction(candidateId: string, requisitionId: string) {
  const r = await act(() => api(`/recruitment/candidates/${candidateId}/applications`, { method: 'POST', body: { requisitionId } }), 'Added to the job.');
  refresh(cand(candidateId), job(requisitionId));
  return r;
}

export async function noteAction(candidateId: string, body: string, applicationId?: string) {
  const r = await act(() => api(`/recruitment/candidates/${candidateId}/notes`, { method: 'POST', body: { body, applicationId } }), 'Note added.');
  refresh(cand(candidateId));
  return r;
}

export async function uploadCvAction(candidateId: string, form: FormData) {
  const r = await act(() => apiForm(`/recruitment/candidates/${candidateId}/files`, form), 'CV uploaded.');
  refresh(cand(candidateId));
  return r;
}

export async function eraseCandidateAction(candidateId: string, reason: string) {
  const r = await act(() => api(`/recruitment/candidates/${candidateId}/erase`, { method: 'POST', body: { reason } }), 'Personal details erased.');
  refresh(cand(candidateId), '/recruitment/candidates');
  return r;
}

// Applications ----------------------------------------------------------------------------------------------

export async function moveAction(applicationId: string, stageId: string, paths: string[] = []) {
  const r = await act(() => api(`/recruitment/applications/${applicationId}/move`, { method: 'POST', body: { stageId } }));
  refresh(...paths);
  return r;
}

export async function rejectAction(applicationId: string, values: Record<string, unknown>, paths: string[] = []) {
  const body = { reason: values.reason, note: values.note || undefined, notifyCandidate: values.notifyCandidate === 'true' };
  const r = await act(() => api(`/recruitment/applications/${applicationId}/reject`, { method: 'POST', body }), 'Application rejected.');
  refresh(...paths);
  return r;
}

export async function withdrawAction(applicationId: string, paths: string[] = []) {
  const r = await act(() => api(`/recruitment/applications/${applicationId}/withdraw`, { method: 'POST' }), 'Marked as withdrawn.');
  refresh(...paths);
  return r;
}

export async function reopenAction(applicationId: string, paths: string[] = []) {
  const r = await act(() => api(`/recruitment/applications/${applicationId}/reopen`, { method: 'POST' }), 'Application reopened.');
  refresh(...paths);
  return r;
}

export async function scheduleInterviewAction(applicationId: string, values: Record<string, unknown>, paths: string[] = []) {
  // The browser turns the local date and time into an exact instant before calling this.
  const body = {
    title: values.title,
    startsAt: values.startsAt || undefined,
    durationMinutes: Number(values.durationMinutes ?? 45),
    mode: values.mode,
    meetingUrl: values.meetingUrl || undefined,
    locationText: values.locationText || undefined,
    panelMembershipIds: Array.isArray(values.panelMembershipIds) ? values.panelMembershipIds : [values.panelMembershipIds].filter(Boolean),
    notifyCandidate: values.notifyCandidate === 'true',
  };
  const r = await act(() => api<{ id: string }>(`/recruitment/applications/${applicationId}/interviews`, { method: 'POST', body }), 'Interview scheduled. The panel has been notified.');
  refresh('/recruitment/interviews', ...paths);
  return r;
}

export async function cancelInterviewAction(id: string, reason: string, paths: string[] = []) {
  const r = await act(() => api(`/recruitment/interviews/${id}/cancel`, { method: 'POST', body: { reason } }), 'Interview cancelled.');
  refresh('/recruitment/interviews', `/recruitment/interviews/${id}`, ...paths);
  return r;
}

export async function feedbackAction(id: string, body: { ratings: { criterion: string; score: number; note?: string }[]; recommendation: string; summary: string }) {
  const r = await act(() => api(`/recruitment/interviews/${id}/feedback`, { method: 'POST', body }), 'Scorecard submitted.');
  refresh('/recruitment/interviews', `/recruitment/interviews/${id}`);
  return r;
}

// Offers and hiring -----------------------------------------------------------------------------------------

const offerBody = (v: Record<string, unknown>) => ({ ...v, designationId: v.designationId || null, variablePay: v.variablePay || undefined, notes: v.notes || undefined });

export async function draftOfferAction(applicationId: string, values: Record<string, unknown>, paths: string[] = []) {
  const r = await act(() => api(`/recruitment/applications/${applicationId}/offers`, { method: 'POST', body: offerBody(values) }), 'Offer drafted. Submit it for approval when ready.');
  refresh(...paths);
  return r;
}

export async function updateOfferAction(id: string, values: Record<string, unknown>, paths: string[] = []) {
  const r = await act(() => api(`/recruitment/offers/${id}`, { method: 'PUT', body: offerBody(values) }), 'Offer updated.');
  refresh(...paths);
  return r;
}

export async function offerStepAction(id: string, step: 'submit' | 'send' | 'withdraw', paths: string[] = []) {
  const done = { submit: 'Offer sent for approval.', send: 'Offer emailed to the candidate.', withdraw: 'Offer withdrawn.' };
  const r = await act(() => api(`/recruitment/offers/${id}/${step}`, { method: 'POST' }), done[step]);
  refresh(...paths);
  return r;
}

export async function offerResponseAction(id: string, values: Record<string, unknown>, paths: string[] = []) {
  const r = await act(() => api(`/recruitment/offers/${id}/response`, { method: 'POST', body: { response: values.response, note: values.note || undefined } }), 'Response recorded.');
  refresh(...paths);
  return r;
}

export async function hireAction(applicationId: string, values: Record<string, unknown>, paths: string[] = []) {
  const body = {
    workEmail: values.workEmail || undefined,
    inviteToCrew: values.inviteToCrew === 'true',
    probationMonths: values.probationMonths === undefined ? undefined : Number(values.probationMonths),
    dateOfJoining: values.dateOfJoining || undefined,
  };
  const r = await act(() => api<{ employee: { id: string } }>(`/recruitment/applications/${applicationId}/hire`, { method: 'POST', body }), 'Hired. Their employee record is ready.');
  refresh('/employees', ...paths);
  return r;
}

// Settings --------------------------------------------------------------------------------------------------

const settings = '/settings/recruitment';

export async function addStageAction(values: Record<string, unknown>) {
  const r = await act(() => api('/recruitment/settings/stages', { method: 'POST', body: values }), 'Stage added.');
  revalidatePath(settings);
  return r;
}

export async function renameStageAction(id: string, values: Record<string, unknown>) {
  const r = await act(() => api(`/recruitment/settings/stages/${id}`, { method: 'PATCH', body: { name: values.name } }), 'Stage renamed.');
  revalidatePath(settings);
  return r;
}

export async function reorderStagesAction(stageIds: string[]) {
  const r = await act(() => api('/recruitment/settings/stages/order', { method: 'PUT', body: { stageIds } }));
  revalidatePath(settings);
  return r;
}

export async function archiveStageAction(id: string) {
  const r = await act(() => api(`/recruitment/settings/stages/${id}`, { method: 'DELETE' }), 'Stage removed.');
  revalidatePath(settings);
  return r;
}

export async function saveCareerSiteAction(values: Record<string, unknown>) {
  const body = { ...values, enabled: values.enabled === 'true', retentionDays: Number(values.retentionDays ?? 365) };
  const r = await act(() => api('/recruitment/settings/career-site', { method: 'PUT', body }), 'Career site saved.');
  revalidatePath(settings);
  return r;
}
