'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

const PATHS = { entities: '/org/legal-entities', locations: '/org/locations', departments: '/org/departments', units: '/org/business-units', designations: '/designations' } as const;
export type OrgResource = keyof typeof PATHS;

export async function saveOrgAction(resource: OrgResource, id: string | null, values: Record<string, unknown>) {
  const r = await act(() => api(`${PATHS[resource]}${id ? `/${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: values }), id ? 'Saved' : 'Created');
  revalidatePath('/organization');
  return r;
}

export async function archiveOrgAction(resource: OrgResource, id: string) {
  const r = await act(() => api(`${PATHS[resource]}/${id}`, { method: 'DELETE' }), 'Archived');
  revalidatePath('/organization');
  return r;
}
