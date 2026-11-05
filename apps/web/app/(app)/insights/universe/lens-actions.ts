'use server';
import type { EmployeeSkill, RequisitionSkills, RequisitionSkillsInput, Scenario, ScenarioInput, SetEmployeeSkillsInput, SkillCreateInput, SkillUpdateInput } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function saveScenarioAction(id: string | null, body: ScenarioInput) {
  const r = await act(() => api<Scenario>(id ? `/insights/scenarios/${id}` : '/insights/scenarios', { method: id ? 'PUT' : 'POST', body }), 'Scenario saved.');
  revalidatePath('/insights/universe');
  return r;
}

export async function raiseScenarioRequisitionsAction(id: string) {
  const r = await act(() => api<Scenario>(`/insights/scenarios/${id}/requisitions`, { method: 'POST', body: {} }), 'Draft requisitions raised.');
  revalidatePath('/insights/universe');
  revalidatePath('/recruitment');
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

export async function createSkillAction(body: SkillCreateInput) {
  const r = await act(() => api(`/skills`, { method: 'POST', body }), 'Skill added.');
  revalidatePath('/insights/universe');
  return r;
}

export async function updateSkillAction(id: string, body: SkillUpdateInput) {
  const r = await act(() => api(`/skills/${id}`, { method: 'PATCH', body }), 'Skill saved.');
  revalidatePath('/insights/universe');
  return r;
}

export async function mergeSkillAction(id: string, intoId: string) {
  const r = await act(() => api(`/skills/${id}/merge`, { method: 'POST', body: { intoId } }), 'Skills merged.');
  revalidatePath('/insights/universe');
  return r;
}

export async function deleteSkillAction(id: string) {
  const r = await act(() => api(`/skills/${id}`, { method: 'DELETE' }), 'Skill removed.');
  revalidatePath('/insights/universe');
  return r;
}

export async function setJobSkillsAction(requisitionId: string, body: RequisitionSkillsInput) {
  const r = await act(() => api<RequisitionSkills>(`/recruitment/requisitions/${requisitionId}/skills`, { method: 'PUT', body }), 'Skills saved.');
  revalidatePath(`/recruitment/jobs/${requisitionId}`);
  return r;
}
