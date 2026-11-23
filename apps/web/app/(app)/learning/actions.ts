'use server';
import type { LearningAudience, LearningCap, QuizAnswers } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { AttemptResult, AttemptStart, PlayerView } from './types';

type Body = Record<string, unknown>;
const refresh = (...paths: string[]) => {
  for (const p of paths) revalidatePath(p);
};

// Modules -----------------------------------------------------------------------------------------------------

export async function saveModuleAction(id: string | null, body: Body) {
  const r = await act(() => api<{ id: string }>(id ? `/learning/modules/${id}` : '/learning/modules', { method: id ? 'PUT' : 'POST', body }), id ? 'Module saved.' : 'Module created as a draft.');
  refresh('/learning/manage', '/learning/manage/library', ...(id ? [`/learning/manage/modules/${id}`] : []));
  return r;
}

export async function publishModuleAction(id: string, publishAt: string | null, note: string) {
  const r = await act(() => api<{ status: string; version?: number; publishAt?: string }>(`/learning/modules/${id}/publish`, { method: 'POST', body: { publishAt, note } }), publishAt ? 'Publication scheduled.' : 'Published. New learners get this version.');
  refresh('/learning/manage/library', `/learning/manage/modules/${id}`);
  return r;
}

export async function unscheduleModuleAction(id: string) {
  const r = await act(() => api(`/learning/modules/${id}/unschedule`, { method: 'POST' }), 'Back to draft.');
  refresh(`/learning/manage/modules/${id}`);
  return r;
}

export async function archiveModuleAction(id: string, restore: boolean) {
  const r = await act(() => api(`/learning/modules/${id}/archive`, { method: 'POST', body: { restore } }), restore ? 'Module restored.' : 'Module archived. People keep their records.');
  refresh('/learning/manage/library', `/learning/manage/modules/${id}`);
  return r;
}

export async function assignModuleAction(id: string, audience: LearningAudience, dueOn: string | null, keepEnrolling: boolean) {
  const r = await act(() => api<{ enrolled: number; alreadyEnrolled: number; reached: number; audience: string }>(`/learning/modules/${id}/assign`, { method: 'POST', body: { audience, dueOn, keepEnrolling } }));
  refresh(`/learning/manage/modules/${id}`, '/learning/manage');
  if (r.ok && r.data) r.message = `Assigned to ${r.data.enrolled} ${r.data.enrolled === 1 ? 'person' : 'people'}${r.data.alreadyEnrolled ? ` (${r.data.alreadyEnrolled} already had it)` : ''}.`;
  return r;
}

export async function stopAudienceAction(moduleId: string, audienceId: string) {
  const r = await act(() => api(`/learning/modules/${moduleId}/audiences/${audienceId}/stop`, { method: 'POST' }), 'New people will no longer be added.');
  refresh(`/learning/manage/modules/${moduleId}`);
  return r;
}

export async function cancelEnrolmentAction(id: string, reason: string, moduleId?: string) {
  const r = await act(() => api(`/learning/enrolments/${id}/cancel`, { method: 'POST', body: { reason } }), 'Removed. Their history stays.');
  refresh(...(moduleId ? [`/learning/manage/modules/${moduleId}`] : []), '/learning/manage/reports');
  return r;
}

// Settings ------------------------------------------------------------------------------------------------------

export async function setLearningPermissionsAction(hrWorkspaceId: string | null, caps: LearningCap[]) {
  const r = await act(() => api(`/learning/permissions`, { method: 'PUT', body: { hrWorkspaceId, caps } }), 'Learning powers saved.');
  refresh('/learning/manage/settings');
  return r;
}

export async function addCategoryAction(name: string) {
  const r = await act(() => api<{ id: string; name: string }>('/learning/categories', { method: 'POST', body: { name } }), 'Category added.');
  refresh('/learning/manage/settings');
  return r;
}

export async function removeCategoryAction(id: string) {
  const r = await act(() => api(`/learning/categories/${id}`, { method: 'DELETE' }), 'Category removed. Modules keep their category.');
  refresh('/learning/manage/settings');
  return r;
}

// Reviews -------------------------------------------------------------------------------------------------------

export async function reviewSubmissionAction(id: string, decision: 'approved' | 'rejected' | 'resubmit', score: number | null, feedback: string) {
  const label = { approved: 'Approved. The learner is told.', rejected: 'Marked as not passed. The learner is told.', resubmit: 'Resubmission requested. The learner is told.' }[decision];
  const r = await act(() => api(`/learning/reviews/submissions/${id}`, { method: 'POST', body: { decision, score, feedback } }), label);
  refresh('/learning/manage/reviews', '/learning/manage');
  return r;
}

export async function gradeAttemptAction(id: string, marks: Record<string, number>, feedback: string) {
  const r = await act(() => api<{ percent: number; passed: boolean }>(`/learning/reviews/attempts/${id}`, { method: 'POST', body: { marks, feedback } }), 'Marked. The learner sees the result.');
  refresh('/learning/manage/reviews');
  return r;
}

// Learner ------------------------------------------------------------------------------------------------------

export async function enrolModuleAction(moduleId: string) {
  const r = await act(() => api<{ id: string }>(`/learning/modules/${moduleId}/enrol`, { method: 'POST' }), 'Enrolled. It is in your learning now.');
  refresh('/learning');
  return r;
}

export async function progressAction(id: string, blockId: string, body: { action: 'open' | 'complete' | 'heartbeat'; position?: number; duration?: number; seconds: number }) {
  return act(() => api<PlayerView>(`/learning/my/${id}/items/${encodeURIComponent(blockId)}/progress`, { method: 'POST', body }));
}

export async function startAttemptAction(id: string, blockId: string) {
  return act(() => api<AttemptStart>(`/learning/my/${id}/items/${encodeURIComponent(blockId)}/attempts`, { method: 'POST' }));
}

export async function saveAnswersAction(id: string, blockId: string, attemptId: string, answers: QuizAnswers) {
  return act(() => api(`/learning/my/${id}/items/${encodeURIComponent(blockId)}/attempts`, { method: 'PUT', body: { attemptId, answers } }));
}

export async function submitAttemptAction(id: string, blockId: string, attemptId: string, answers: QuizAnswers) {
  const r = await act(() => api<AttemptResult>(`/learning/my/${id}/items/${encodeURIComponent(blockId)}/attempts/submit`, { method: 'POST', body: { attemptId, answers } }));
  refresh('/learning');
  return r;
}

export async function submitAssignmentAction(id: string, blockId: string, body: { text: string; link: string | null; fileIds: string[] }) {
  const r = await act(() => api<PlayerView>(`/learning/my/${id}/items/${encodeURIComponent(blockId)}/submissions`, { method: 'POST', body }), 'Submitted for review.');
  refresh('/learning');
  return r;
}
