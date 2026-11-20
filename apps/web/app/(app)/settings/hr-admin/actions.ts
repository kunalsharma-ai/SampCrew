'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { FeatureLevelRow } from '@crew/contracts';
import type { ModuleRow } from './types';

export async function setModulesAction(changes: { key: string; enabled: boolean }[]) {
  const r = await act(() => api<ModuleRow[]>('/hr-admin/modules', { method: 'PUT', body: { changes } }), changes.every((c) => c.enabled) ? 'Switched on for everyone in the workspace.' : 'Switched off for everyone in the workspace. Its data is kept.');
  revalidatePath('/settings/hr-admin');
  revalidatePath('/', 'layout');
  return r;
}

export async function setRoleGrantsAction(roleId: string, grants: { permission: string; scope: string }[]) {
  const r = await act(() => api(`/hr-admin/roles/${roleId}/permissions`, { method: 'PUT', body: { grants } }), 'Permissions saved. They apply from the next page each member opens.');
  revalidatePath('/settings/hr-admin');
  revalidatePath('/settings/roles');
  return r;
}

export async function resetRoleAction(roleId: string) {
  const r = await act(() => api(`/hr-admin/roles/${roleId}/reset`, { method: 'POST' }), 'Back to the default permissions.');
  revalidatePath('/settings/hr-admin');
  revalidatePath('/settings/roles');
  return r;
}

export async function setFeatureLevelsAction(changes: { key: string; target: 'company' | 'hr' | 'employee'; enabled: boolean }[]) {
  const on = changes.every((c) => c.enabled);
  const r = await act(() => api<{ items: FeatureLevelRow[] }>('/hr-admin/features', { method: 'PUT', body: { changes } }), on ? 'Switched on. People get it from the next page they open.' : 'Switched off. People lose it at once; its records are kept.');
  revalidatePath('/settings/hr-admin');
  revalidatePath('/', 'layout');
  return r;
}
