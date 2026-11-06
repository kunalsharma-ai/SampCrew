'use server';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';
import type { LoginDetails } from '@/lib/types';

const refresh = (id?: string) => {
  revalidatePath('/employees');
  if (id) revalidatePath(`/employees/${id}`);
};

export async function hireAction(values: Record<string, unknown>) {
  const r = await act(() => api<{ employee: { id: string }; inviteUrl?: string }>('/employees', { method: 'POST', body: values, idempotencyKey: crypto.randomUUID() }));
  refresh();
  return r;
}

export async function updateEmployeeAction(id: string, values: Record<string, unknown>) {
  const r = await act(() => api(`/employees/${id}`, { method: 'PATCH', body: values }), 'Profile saved');
  refresh(id);
  return r;
}

export async function sensitiveAction(id: string) {
  return act(() => api<Record<string, string | null>>(`/employees/${id}/sensitive`));
}

export async function saveSensitiveAction(id: string, values: Record<string, unknown>) {
  return act(() => api(`/employees/${id}/sensitive`, { method: 'PUT', body: values }), 'Saved securely');
}

export async function jobChangeAction(id: string, values: Record<string, unknown>) {
  const r = await act(() => api(`/employees/${id}/job-changes`, { method: 'POST', body: values }), 'Job change recorded');
  refresh(id);
  return r;
}

export async function lifecycleAction(id: string, action: 'confirm' | 'extend-probation' | 'exit' | 'withdraw-exit', values: Record<string, unknown> = {}) {
  const r = await act(() => api(`/employees/${id}/${action}`, { method: 'POST', body: values }), 'Done');
  refresh(id);
  return r;
}

export async function uploadDocumentAction(id: string, form: FormData) {
  const r = await act(() => apiForm(`/employees/${id}/documents`, form), 'Uploaded');
  refresh(id);
  return r;
}

export async function archiveDocumentAction(employeeId: string, documentId: string) {
  const r = await act(() => api(`/documents/${documentId}`, { method: 'DELETE' }), 'Archived');
  refresh(employeeId);
  return r;
}

export async function taskStatusAction(taskId: string, status: 'open' | 'done' | 'skipped') {
  const r = await act(() => api(`/onboarding/tasks/${taskId}`, { method: 'PATCH', body: { status } }));
  revalidatePath('/tasks');
  revalidatePath('/employees', 'layout');
  return r;
}

export async function linkLoginAction(id: string, membershipId: string) {
  const r = await act(() => api(`/employees/${id}/link-login`, { method: 'POST', body: { membershipId } }), 'Login linked');
  refresh(id);
  return r;
}

// Add-employee wizard --------------------------------------------------------------------------------------

export type DraftData = Record<string, string | number | boolean | null>;

export async function saveHireDraftAction(id: string | null, step: number, data: DraftData) {
  return act(() => api<{ id: string; step: number; updatedAt: string }>(id ? `/employees/drafts/${id}` : '/employees/drafts', { method: id ? 'PUT' : 'POST', body: { step, data } }));
}

export async function discardHireDraftAction(id: string) {
  const r = await act(() => api(`/employees/drafts/${id}`, { method: 'DELETE' }), 'Draft discarded');
  revalidatePath('/employees');
  return r;
}

export async function duplicateCheckAction(values: Record<string, string>) {
  return act(() => api<{ matches: { id: string; displayName: string; employeeCode: string; status: string; departmentName: string | null; reasons: string[] }[] }>('/employees/duplicate-check', { method: 'POST', body: values }));
}

/**
 * Completes a hire from the wizard in one go: creates the employee (job record, onboarding checklist, optional
 * invitation), then assigns their salary and uploads their documents, and finally removes the saved draft.
 * The employee is created first and kept even if a later step fails; those failures come back as warnings
 * so HR can finish them from the profile.
 */
export async function completeHireAction(form: FormData) {
  let payload: { employee: Record<string, unknown>; salary?: { structureId: string; annualCtc: string; effectiveFrom: string } | null; draftId?: string | null; documents?: { category: string; title: string; visibility: string }[] };
  try {
    payload = JSON.parse(String(form.get('payload') ?? '{}'));
  } catch {
    return { ok: false as const, message: 'The form could not be read. Please try again.' };
  }
  const hired = await act(() => api<{ employee: { id: string }; inviteUrl?: string; login?: { email: string; temporaryPassword: string } }>('/employees', { method: 'POST', body: payload.employee, idempotencyKey: String(form.get('idempotencyKey') ?? crypto.randomUUID()) }));
  if (!hired.ok) return hired;
  const id = hired.data!.employee.id;
  const warnings: string[] = [];
  if (payload.salary) {
    const s = await act(() => api(`/payroll/salaries/${id}`, { method: 'POST', body: payload.salary }));
    if (!s.ok) warnings.push(`Salary was not saved: ${s.message}`);
  }
  const files = form.getAll('documents').filter((f): f is File => f instanceof File && f.size > 0);
  for (const [i, file] of files.entries()) {
    const meta = payload.documents?.[i];
    const fd = new FormData();
    fd.set('file', file, file.name);
    fd.set('category', meta?.category ?? 'other');
    fd.set('title', meta?.title || file.name);
    fd.set('visibility', meta?.visibility ?? 'employee');
    const d = await act(() => apiForm(`/employees/${id}/documents`, fd));
    if (!d.ok) warnings.push(`${file.name} was not uploaded: ${d.message}`);
  }
  const photo = form.get('photo');
  if (photo instanceof File && photo.size > 0) {
    const fd = new FormData();
    fd.set('file', photo, photo.name);
    const ph = await act(() => apiForm(`/employees/${id}/photo`, fd, { method: 'PUT' }));
    if (!ph.ok) warnings.push(`The photo was not saved: ${ph.message}`);
  }
  if (payload.draftId) await act(() => api(`/employees/drafts/${payload.draftId}`, { method: 'DELETE' }));
  refresh();
  return { ok: true as const, data: { employeeId: id, inviteUrl: hired.data!.inviteUrl ?? null, warnings, login: hired.data!.login ?? null } };
}

// Photo, login and attendance registration (SAMPLEDGE feedback, 2026-11-06) -----------------------------------

export async function uploadPhotoAction(id: string, form: FormData) {
  const r = await act(() => apiForm<{ photoUpdatedAt: string }>(`/employees/${id}/photo`, form, { method: 'PUT' }), 'Photo saved');
  refresh(id);
  // The top bar shows the signed-in person's own photo.
  revalidatePath('/', 'layout');
  return r;
}

export async function removePhotoAction(id: string) {
  const r = await act(() => api(`/employees/${id}/photo`, { method: 'DELETE' }), 'Photo removed');
  refresh(id);
  revalidatePath('/', 'layout');
  return r;
}

export type LoginResult = { inviteUrl?: string; login?: { email: string; temporaryPassword: string } };

export async function createLoginAction(id: string, body: { mode: 'invite' | 'password'; initialPassword?: string }) {
  const r = await act(() => api<LoginResult>(`/employees/${id}/login`, { method: 'POST', body }), body.mode === 'invite' ? 'Invitation sent' : 'Login created');
  refresh(id);
  return r;
}

export type LoginControlAction = 'reset_password' | 'force_password_change' | 'lock' | 'unlock' | 'sign_out';
const LOGIN_DONE: Record<LoginControlAction, string> = {
  reset_password: 'Password reset', force_password_change: 'They will choose a new password at their next sign-in', lock: 'Login locked', unlock: 'Login unlocked', sign_out: 'Signed out everywhere in this workspace',
};

/** Workspace-admin control of an employee's SampCrew login. A reset password comes back once and is never stored readable. */
export async function loginControlAction(id: string, action: LoginControlAction, initialPassword?: string) {
  const r = await act(() => api<LoginDetails>(`/employees/${id}/login/actions`, { method: 'POST', body: { action, ...(initialPassword ? { initialPassword } : {}) } }), LOGIN_DONE[action]);
  refresh(id);
  return r;
}

export async function saveAttendanceRegistrationAction(id: string, body: { defaultShiftId: string | null; enrolments: { deviceUserId: string; deviceId: string | null }[] }) {
  const r = await act(() => api(`/employees/${id}/attendance-registration`, { method: 'PUT', body }), 'Attendance registration saved');
  refresh(id);
  return r;
}

/** Adds a designation from inside the hire wizard, so HR does not have to leave it. */
export async function createDesignationAction(name: string) {
  const r = await act(() => api<{ id: string; name: string }>('/designations', { method: 'POST', body: { name } }));
  revalidatePath('/organization');
  return r;
}

/** Adds a top-level department from inside the hire wizard. */
export async function createDepartmentAction(name: string, legalEntityId: string | null) {
  const r = await act(() => api<{ id: string; name: string }>('/org/departments', { method: 'POST', body: { name, ...(legalEntityId ? { legalEntityId } : {}) } }));
  revalidatePath('/organization');
  return r;
}

/** Adds a location for a legal entity from inside the hire wizard, using the entity's country and time zone. */
export async function createLocationAction(name: string, legalEntityId: string, countryCode: string, timezone: string) {
  const r = await act(() => api<{ id: string; name: string }>('/org/locations', { method: 'POST', body: { name, legalEntityId, countryCode, timezone } }));
  revalidatePath('/organization');
  return r;
}

/** Adds a shift from inside the hire wizard. The code is made from the name, with a number added if it is taken. */
export async function createShiftAction(name: string, startTime: string, endTime: string) {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8) || 'SHIFT';
  let r = await act(() => api<{ id: string; name: string; code: string; startTime: string; endTime: string }>('/shifts/templates', { method: 'POST', body: { code: base, name, startTime, endTime } }));
  for (let i = 2; !r.ok && r.code === 'shift_exists' && i < 10; i++) {
    r = await act(() => api<{ id: string; name: string; code: string; startTime: string; endTime: string }>('/shifts/templates', { method: 'POST', body: { code: `${base}${i}`, name, startTime, endTime } }));
  }
  revalidatePath('/attendance');
  return r;
}
