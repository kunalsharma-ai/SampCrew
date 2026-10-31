'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

/** Form selects send "true"/"false" and numbers as strings; turn them into JSON types. */
function typed(values: Record<string, unknown>, opts: { bools?: string[]; numbers?: string[]; nulls?: string[] } = {}) {
  const out: Record<string, unknown> = { ...values };
  for (const k of opts.bools ?? []) if (k in out) out[k] = out[k] === true || out[k] === 'true';
  for (const k of opts.numbers ?? []) if (k in out && out[k] !== null && out[k] !== '') out[k] = Number(out[k]);
  for (const k of opts.nulls ?? []) if (!(k in out) || out[k] === '') out[k] = null;
  return out;
}

const refresh = (...paths: string[]) => {
  for (const p of ['/attendance', '/approvals', ...paths]) revalidatePath(p);
};

export async function punchAction(body: { latitude?: number; longitude?: number; accuracyM?: number; direction?: 'in' | 'out' }) {
  const r = await act(
    () => api<{ punch: { direction: string; geofence: string; distanceM: number | null }; duplicate: boolean }>('/attendance/punch', {
      method: 'POST',
      body: { ...body, source: 'web', clientEventId: `web-${crypto.randomUUID()}` },
    }),
  );
  refresh();
  return r;
}

export async function qrPunchAction(code: string) {
  const r = await act(() => api<{ punch: { direction: string; capturedAt: string }; duplicate: boolean }>('/attendance/qr-punch', { method: 'POST', body: { code } }));
  refresh();
  return r;
}

export async function correctionAction(body: { employeeId?: string; workDate: string; punches: { time: string; direction: 'in' | 'out'; nextDay: boolean }[]; reason: string }) {
  const r = await act(() => api('/attendance/corrections', { method: 'POST', body, idempotencyKey: crypto.randomUUID() }), 'Correction sent for approval.');
  refresh('/attendance/team');
  return r;
}

export async function cancelCorrectionAction(id: string) {
  const r = await act(() => api(`/attendance/corrections/${id}/cancel`, { method: 'POST' }), 'Correction withdrawn.');
  refresh();
  return r;
}

export async function overtimeAction(body: { employeeId?: string; workDate: string; minutes: number; reason?: string }) {
  const r = await act(() => api('/attendance/overtime', { method: 'POST', body, idempotencyKey: crypto.randomUUID() }), 'Overtime claim sent for approval.');
  refresh();
  return r;
}

// Settings ----------------------------------------------------------------------------------------------

export async function saveShiftAction(id: string | null, values: Record<string, unknown>) {
  const body = typed(values, { bools: ['overtimeEnabled'], numbers: ['breakMinutes', 'graceLateMinutes', 'graceEarlyMinutes', 'halfDayMinutes', 'fullDayMinutes', 'overtimeMinMinutes'] });
  const r = await act(() => api(id ? `/shifts/templates/${id}` : '/shifts/templates', { method: id ? 'PUT' : 'POST', body }), id ? 'Shift updated.' : 'Shift created.');
  revalidatePath('/settings/attendance');
  return r;
}

export async function archiveShiftAction(id: string) {
  const r = await act(() => api(`/shifts/templates/${id}`, { method: 'DELETE' }), 'Shift archived.');
  revalidatePath('/settings/attendance');
  return r;
}

export async function savePolicyAction(values: Record<string, unknown>) {
  const body = typed(values, { bools: ['webPunch', 'mobilePunch', 'qrPunch', 'overtimeRequiresApproval'], numbers: ['earlyWindowMinutes', 'correctionWindowDays'], nulls: ['locationId', 'defaultShiftId'] });
  const r = await act(() => api('/attendance/policies', { method: 'PUT', body }), 'Policy saved.');
  revalidatePath('/settings/attendance');
  return r;
}

export async function removePolicyAction(locationId: string) {
  const r = await act(() => api(`/attendance/policies/${locationId}`, { method: 'DELETE' }), 'Location override removed; the workspace default applies.');
  revalidatePath('/settings/attendance');
  return r;
}

export async function lockAction(values: Record<string, unknown>) {
  const r = await act(() => api<{ pendingCorrections: number }>('/attendance/locks', { method: 'POST', body: typed(values, { nulls: ['legalEntityId'] }) }), 'Period locked.');
  revalidatePath('/settings/attendance');
  return r;
}

export async function unlockAction(id: string, reason: string) {
  const r = await act(() => api(`/attendance/locks/${id}/unlock`, { method: 'POST', body: { reason } }), 'Period unlocked.');
  revalidatePath('/settings/attendance');
  return r;
}

export async function recomputeAction(from: string, to: string) {
  return act(() => api<{ employees: number; days: number }>('/attendance/recompute', { method: 'POST', body: { from, to } }));
}

export async function createKioskAction(values: Record<string, unknown>) {
  const r = await act(() => api<{ id: string; token: string }>('/attendance/kiosks', { method: 'POST', body: values }));
  revalidatePath('/settings/attendance');
  return r;
}

export async function revokeKioskAction(id: string) {
  const r = await act(() => api(`/attendance/kiosks/${id}/revoke`, { method: 'POST' }), 'Kiosk revoked. Its screen stops showing codes.');
  revalidatePath('/settings/attendance');
  return r;
}

// Shifts and rosters ------------------------------------------------------------------------------------

export async function createRosterAction(values: Record<string, unknown>) {
  const r = await act(() => api<{ id: string }>('/shifts/rosters', { method: 'POST', body: typed(values, { nulls: ['departmentId', 'locationId'] }) }));
  revalidatePath('/shifts');
  return r;
}

export async function saveAssignmentsAction(rosterId: string | null, assignments: { employeeId: string; workDate: string; shiftTemplateId: string | null }[]) {
  const r = await act(() => api('/shifts/assignments', { method: 'PUT', body: { rosterId, assignments } }), 'Shifts saved.');
  revalidatePath('/shifts');
  return r;
}

export async function publishRosterAction(id: string) {
  const r = await act(() => api(`/shifts/rosters/${id}/publish`, { method: 'POST' }), 'Roster published. Everyone on it has been notified.');
  revalidatePath('/shifts');
  return r;
}

export async function deleteRosterAction(id: string) {
  const r = await act(() => api(`/shifts/rosters/${id}`, { method: 'DELETE' }), 'Draft roster deleted.');
  revalidatePath('/shifts');
  return r;
}

export async function swapCandidatesAction(date: string) {
  return act(() => api<{ date: string; myShift: string; candidates: { employeeId: string; name: string; shift: string }[] }>(`/shifts/swap-candidates?date=${date}`));
}

export async function requestSwapAction(body: { workDate: string; counterpartEmployeeId: string; reason?: string }) {
  const r = await act(() => api('/shifts/swaps', { method: 'POST', body }), 'Swap request sent to your colleague.');
  revalidatePath('/shifts');
  return r;
}

export async function swapResponseAction(id: string, action: 'accept' | 'decline' | 'cancel') {
  const r = await act(() => api(`/shifts/swaps/${id}/${action}`, { method: 'POST' }), action === 'accept' ? 'Accepted. It now goes to your manager for approval.' : action === 'decline' ? 'Declined.' : 'Withdrawn.');
  revalidatePath('/shifts');
  revalidatePath('/approvals');
  return r;
}

// Devices -----------------------------------------------------------------------------------------------

export async function createDeviceAction(values: Record<string, unknown>) {
  const body = typed(values, { bools: ['simulated', 'directionFromDevice'], numbers: ['expectedIntervalSeconds'] });
  if (typeof body.allowedIps === 'string') body.allowedIps = body.allowedIps.split(/[\s,]+/).filter(Boolean);
  const r = await act(() => api<{ id: string }>('/attendance/devices', { method: 'POST', body }));
  revalidatePath('/settings/devices');
  return r;
}

export async function updateDeviceAction(id: string, values: Record<string, unknown>) {
  const body = typed(values, { bools: ['directionFromDevice'], numbers: ['expectedIntervalSeconds'] });
  if (typeof body.allowedIps === 'string') body.allowedIps = body.allowedIps.split(/[\s,]+/).filter(Boolean);
  else if (!('allowedIps' in body)) body.allowedIps = [];
  const r = await act(() => api(`/attendance/devices/${id}`, { method: 'PATCH', body }), 'Device updated.');
  revalidatePath(`/settings/devices/${id}`);
  return r;
}

export async function archiveDeviceAction(id: string) {
  const r = await act(() => api(`/attendance/devices/${id}`, { method: 'DELETE' }), 'Device archived. Its punches are kept.');
  revalidatePath('/settings/devices');
  return r;
}

export async function mapUserAction(body: { deviceUserId: string; employeeId: string; deviceId: string | null }) {
  const r = await act(() => api('/attendance/devices/mappings', { method: 'POST', body }), `Enrolment number ${body.deviceUserId} mapped. Punches already received now count.`);
  revalidatePath('/settings/devices');
  return r;
}

export async function unmapAction(id: string) {
  const r = await act(() => api(`/attendance/devices/mappings/${id}`, { method: 'DELETE' }), 'Mapping removed.');
  revalidatePath('/settings/devices');
  return r;
}

export async function simulateAction(id: string, scenario: string, date?: string) {
  const r = await act(() => api<{ accepted: number; duplicates: number; rejected: number; records: number; date: string }>(`/attendance/devices/${id}/simulate`, { method: 'POST', body: { scenario, ...(date ? { date } : {}) } }));
  revalidatePath(`/settings/devices/${id}`);
  return r;
}
