'use server';
import type { EmployeeSkill, Scenario, ScenarioInput, SetEmployeeSkillsInput } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function saveScenarioAction(id: string | null, body: ScenarioInput) {
  const r = await act(() => api<Scenario>(id ? `/insights/scenarios/${id}` : '/insights/scenarios', { method: id ? 'PUT' : 'POST', body }), 'Scenario saved.');
  revalidatePath('/insights/universe');
  return r;
}

export async function deleteScenarioAction(id: string) {
  const r = await act(() => api(`/insights/scenarios/${id}`, { method: 'DELETE' }), 'Scenario deleted.');
  revalidatePath('/insights/universe');
  return r;
}

export async function saveSkillsAction(employeeId: string, body: SetEmployeeSkillsInput) {
  const r = await act(() => api<{ skills: EmployeeSkill[]; canEdit: boolean }>(`/employees/${employeeId}/skills`, { method: 'PUT', body }), 'Skills saved.');
  revalidatePath(`/employees/${employeeId}`);
  revalidatePath('/insights/universe');
  return r;
}
