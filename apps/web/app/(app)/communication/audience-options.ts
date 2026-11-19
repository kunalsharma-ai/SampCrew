import 'server-only';
import type { AudienceOptions } from '@/components/audience-picker';
import { loadOptional } from '@/lib/api';
import type { Department, Designation } from '@/lib/types';
import type { Group, Person } from './types';

/** Departments, designations and HR's groups for the audience picker, and names for people already chosen. */
export async function loadAudienceOptions(): Promise<{ options: AudienceOptions; knownNames: Record<string, string> }> {
  const [departments, designations, groups, people] = await Promise.all([
    loadOptional<Department[]>('/org/departments'),
    loadOptional<Designation[]>('/designations'),
    loadOptional<{ items: Group[] }>('/communication/groups'),
    loadOptional<{ items: Person[] }>('/communication/people'),
  ]);
  return {
    options: {
      departments: (departments ?? []).map((d) => ({ id: d.id, name: d.name })),
      designations: (designations ?? []).map((d) => ({ id: d.id, name: d.name })),
      groups: (groups?.items ?? []).map((g) => ({ id: g.id, name: g.name, size: g.members.length })),
    },
    knownNames: Object.fromEntries((people?.items ?? []).map((p) => [p.membershipId, p.name])),
  };
}
