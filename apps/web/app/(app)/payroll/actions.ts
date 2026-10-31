'use server';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';

const run = (id: string) => `/payroll/runs/${id}`;
const refresh = (...paths: string[]) => {
  for (const p of ['/payroll', '/approvals', ...paths]) revalidatePath(p);
};

// Runs ------------------------------------------------------------------------------------------------------

export async function createRunAction(values: Record<string, unknown>) {
  const r = await act(() => api<{ id: string }>('/payroll/runs', { method: 'POST', body: values }), 'Payroll run created. Compute it next.');
  refresh();
  return r;
}

export async function computeRunAction(id: string) {
  const r = await act(() => api<{ employees: number }>(`/payroll/runs/${id}/compute`, { method: 'POST' }), 'Payroll computed.');
  refresh(run(id));
  return r;
}

export async function submitRunAction(id: string) {
  const r = await act(() => api(`/payroll/runs/${id}/submit`, { method: 'POST' }), 'Sent for approval. The approver finalises it.');
  refresh(run(id));
  return r;
}

export async function withdrawRunAction(id: string) {
  const r = await act(() => api(`/payroll/runs/${id}/withdraw`, { method: 'POST' }), 'Withdrawn from approval. You can change it now.');
  refresh(run(id));
  return r;
}

export async function cancelRunAction(id: string, reason: string) {
  const r = await act(() => api(`/payroll/runs/${id}/cancel`, { method: 'POST', body: { reason } }), 'Payroll run cancelled.');
  refresh(run(id));
  return r;
}

export async function addAdjustmentAction(id: string, values: Record<string, unknown>) {
  const body = { ...values, taxable: values.taxable !== 'no' };
  const r = await act(() => api(`/payroll/runs/${id}/adjustments`, { method: 'POST', body }), 'Adjustment added and pay recomputed.');
  refresh(run(id));
  return r;
}

export async function removeAdjustmentAction(id: string, adjustmentId: string) {
  const r = await act(() => api(`/payroll/runs/${id}/adjustments/${adjustmentId}`, { method: 'DELETE' }), 'Adjustment removed.');
  refresh(run(id));
  return r;
}

export async function overrideItemAction(id: string, itemId: string, body: { lopDays?: string | null; hold?: boolean; reason: string }) {
  const r = await act(() => api<{ id: string }>(`/payroll/runs/${id}/items/${itemId}`, { method: 'PATCH', body }), 'Saved and recomputed.');
  refresh(run(id));
  return r;
}

// Salaries --------------------------------------------------------------------------------------------------

const salaryBody = (v: Record<string, unknown>) => ({
  effectiveFrom: v.effectiveFrom, annualCtc: v.annualCtc, structureId: v.structureId, note: v.note || undefined,
  pfEnabled: v.pfEnabled !== false, esiEnabled: v.esiEnabled !== false, ptEnabled: v.ptEnabled !== false, tdsEnabled: v.tdsEnabled !== false,
});

export async function previewSalaryAction(employeeId: string, values: Record<string, unknown>) {
  return act(() => api<{ currency: string; components: { code: string; name: string; kind: string; monthly: string; annual: string }[]; employerPfMonthly: string; warnings: string[] }>(
    `/payroll/salaries/${employeeId}/preview`, { method: 'POST', body: salaryBody(values) },
  ));
}

export async function assignSalaryAction(employeeId: string, values: Record<string, unknown>) {
  const r = await act(() => api<{ id: string; warnings: string[] }>(`/payroll/salaries/${employeeId}`, { method: 'POST', body: salaryBody(values) }), 'Salary saved.');
  refresh('/payroll/salaries', `/payroll/salaries/${employeeId}`);
  return r;
}

export async function removeSalaryAction(employeeId: string, salaryId: string) {
  const r = await act(() => api(`/payroll/salary-revisions/${salaryId}`, { method: 'DELETE' }), 'Salary revision removed.');
  refresh('/payroll/salaries', `/payroll/salaries/${employeeId}`);
  return r;
}

// Settings --------------------------------------------------------------------------------------------------

const settings = () => refresh('/settings/payroll');
const yes = (v: unknown) => v === true || v === 'yes';

export async function saveComponentAction(id: string | null, values: Record<string, unknown>) {
  const body = { ...values, taxable: yes(values.taxable), prorate: yes(values.prorate), pfWage: yes(values.pfWage), description: values.description ?? '' };
  const r = await act(() => api(id ? `/payroll/components/${id}` : '/payroll/components', { method: id ? 'PUT' : 'POST', body }), id ? 'Component updated.' : 'Component added.');
  settings();
  return r;
}

export async function archiveComponentAction(id: string) {
  const r = await act(() => api(`/payroll/components/${id}`, { method: 'DELETE' }), 'Component archived.');
  settings();
  return r;
}

export async function saveStructureAction(id: string | null, body: { name: string; description: string; lines: { componentId: string; calc: string; value: string }[] }) {
  const r = await act(() => api(id ? `/payroll/structures/${id}` : '/payroll/structures', { method: id ? 'PUT' : 'POST', body }), id ? 'Structure updated.' : 'Structure created.');
  settings();
  return r;
}

export async function archiveStructureAction(id: string) {
  const r = await act(() => api(`/payroll/structures/${id}`, { method: 'DELETE' }), 'Structure archived.');
  settings();
  return r;
}

export async function saveStatutoryAction(body: Record<string, unknown>) {
  const r = await act(() => api('/payroll/statutory', { method: 'POST', body }), 'Statutory settings saved.');
  settings();
  return r;
}

export async function removeStatutoryAction(id: string) {
  const r = await act(() => api(`/payroll/statutory/${id}`, { method: 'DELETE' }), 'Statutory settings removed.');
  settings();
  return r;
}

export async function saveCategoryAction(id: string | null, values: Record<string, unknown>) {
  const body = { name: values.name, receiptRequired: yes(values.receiptRequired), maxPerClaim: values.maxPerClaim ? String(values.maxPerClaim) : null };
  const r = await act(() => api(id ? `/expenses/categories/${id}` : '/expenses/categories', { method: id ? 'PUT' : 'POST', body }), id ? 'Category updated.' : 'Category added.');
  settings();
  revalidatePath('/expenses');
  return r;
}

export async function archiveCategoryAction(id: string) {
  const r = await act(() => api(`/expenses/categories/${id}`, { method: 'DELETE' }), 'Category archived.');
  settings();
  return r;
}

// Expenses --------------------------------------------------------------------------------------------------

export async function submitClaimAction(form: FormData) {
  const file = form.get('receipt');
  if (file instanceof File && file.size === 0) form.delete('receipt');
  const r = await act(() => apiForm<{ id: string }>('/expenses/claims', form), 'Claim submitted. Your manager will review it.');
  revalidatePath('/expenses');
  return r;
}

export async function cancelClaimAction(id: string) {
  const r = await act(() => api(`/expenses/claims/${id}/cancel`, { method: 'POST' }), 'Claim withdrawn.');
  revalidatePath('/expenses');
  return r;
}
