'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

const done = <T,>(r: T) => {
  revalidatePath('/settings/workspace-permissions');
  return r;
};

/** Saves every switch of one level for one group; the API keeps them within what the level may ever have. */
export const saveWorkspacePermissionsAction = async (body: { level: 'hr' | 'employee'; groupId: string; permissions: Record<string, boolean>; template?: string }) =>
  done(await act(() => api('/workspace-permissions', { method: 'PUT', body }), 'Permissions saved. They apply from the next request.'));

/** Makes the switches on screen the Default HR or Default Employee template (null: back to the SampCrew defaults). */
export const saveTemplateAction = async (key: 'hr_default' | 'employee_default', permissions: Record<string, boolean> | null) =>
  done(await act(() => (permissions ? api(`/workspace-permissions/templates/${key}`, { method: 'PUT', body: { permissions } }) : api(`/workspace-permissions/templates/${key}`, { method: 'DELETE' })), permissions ? 'Template saved. New workspaces start from it.' : 'Template reset to the SampCrew defaults.'));
