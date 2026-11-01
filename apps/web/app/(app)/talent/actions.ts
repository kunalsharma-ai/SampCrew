'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

type Body = Record<string, unknown>;
const refresh = (...paths: string[]) => {
  for (const p of paths) revalidatePath(p);
};

// Goals -------------------------------------------------------------------------------------------------------

export async function saveGoalAction(id: string | null, body: Body) {
  const r = await act(() => api<{ id: string }>(id ? `/goals/${id}` : '/goals', { method: id ? 'PUT' : 'POST', body }), id ? 'Goal updated.' : 'Goal added.');
  refresh('/goals', ...(id ? [`/goals/${id}`] : []));
  return r;
}

export async function checkinAction(id: string, body: Body) {
  const r = await act(() => api<{ progress: number }>(`/goals/${id}/checkins`, { method: 'POST', body }), 'Progress updated.');
  refresh('/goals', `/goals/${id}`);
  return r;
}

export async function goalStatusAction(id: string, status: string, note = '') {
  const label = status === 'completed' ? 'Goal completed.' : status === 'cancelled' ? 'Goal cancelled.' : 'Goal reopened.';
  const r = await act(() => api(`/goals/${id}/status`, { method: 'POST', body: { status, note } }), label);
  refresh('/goals', `/goals/${id}`);
  return r;
}

export async function deleteGoalAction(id: string) {
  const r = await act(() => api(`/goals/${id}`, { method: 'DELETE' }), 'Goal deleted.');
  refresh('/goals');
  return r;
}

// Reviews -----------------------------------------------------------------------------------------------------

export async function saveCycleAction(id: string | null, body: Body) {
  const r = await act(() => api<{ id: string }>(id ? `/review-cycles/${id}` : '/review-cycles', { method: id ? 'PUT' : 'POST', body }), id ? 'Cycle updated.' : 'Draft cycle created.');
  refresh('/reviews/cycles', ...(id ? [`/reviews/cycles/${id}`] : []));
  return r;
}

export async function deleteCycleAction(id: string) {
  const r = await act(() => api(`/review-cycles/${id}`, { method: 'DELETE' }), 'Draft cycle deleted.');
  refresh('/reviews/cycles');
  return r;
}

const CYCLE_STEP: Record<string, string> = {
  launch: 'Cycle launched. Everyone in it has been asked to write.',
  calibration: 'Writing closed. Calibrate ratings, then release.',
  release: 'Results released to employees.',
};
export async function cycleStepAction(id: string, step: 'launch' | 'calibration' | 'release') {
  const r = await act(() => api(`/review-cycles/${id}/${step}`, { method: 'POST' }), CYCLE_STEP[step]);
  refresh('/reviews/cycles', `/reviews/cycles/${id}`, '/reviews');
  return r;
}

export async function writeReviewAction(id: string, part: 'self' | 'manager', body: Body) {
  const r = await act(() => api(`/reviews/${id}/${part}`, { method: 'PUT', body }), body.submit ? 'Review submitted.' : 'Draft saved.');
  refresh('/reviews', `/reviews/${id}`);
  return r;
}

export async function requestFeedbackAction(id: string, reviewerEmployeeIds: string[]) {
  const r = await act(() => api<{ requested: number }>(`/reviews/${id}/feedback-requests`, { method: 'POST', body: { reviewerEmployeeIds } }), 'Feedback requested.');
  refresh(`/reviews/${id}`);
  return r;
}

export async function withdrawFeedbackAction(id: string, feedbackId: string) {
  const r = await act(() => api(`/reviews/${id}/feedback-requests/${feedbackId}`, { method: 'DELETE' }), 'Request withdrawn.');
  refresh(`/reviews/${id}`);
  return r;
}

export async function calibrateAction(id: string, cycleId: string, finalRating: number, reason: string) {
  const r = await act(() => api(`/reviews/${id}/calibrate`, { method: 'POST', body: { finalRating, reason } }), 'Final rating changed.');
  refresh(`/reviews/${id}`, `/reviews/cycles/${cycleId}`);
  return r;
}

export async function excludeAction(id: string, cycleId: string, reason: string) {
  const r = await act(() => api(`/reviews/${id}/exclude`, { method: 'POST', body: { reason } }), 'Left out of this cycle.');
  refresh(`/reviews/${id}`, `/reviews/cycles/${cycleId}`);
  return r;
}

export async function acknowledgeAction(id: string, comment: string) {
  const r = await act(() => api(`/reviews/${id}/acknowledge`, { method: 'POST', body: { comment } }), 'Acknowledged. Thank you.');
  refresh('/reviews', `/reviews/${id}`);
  return r;
}

export async function writeFeedbackAction(id: string, answers: Record<string, string>, submit: boolean) {
  const r = await act(() => api(`/feedback/${id}`, { method: 'PUT', body: { answers, submit } }), submit ? 'Feedback sent. Thank you.' : 'Draft saved.');
  refresh('/reviews', `/reviews/feedback/${id}`);
  return r;
}

export async function declineFeedbackAction(id: string) {
  const r = await act(() => api(`/feedback/${id}/decline`, { method: 'POST' }), 'Request declined.');
  refresh('/reviews', `/reviews/feedback/${id}`);
  return r;
}

export async function searchColleaguesAction(q: string) {
  return act(() => api<{ id: string; name: string; departmentName: string | null }[]>(`/talent/colleagues?q=${encodeURIComponent(q)}`));
}

// Learning ----------------------------------------------------------------------------------------------------

export async function saveCourseAction(id: string | null, body: Body) {
  const r = await act(() => api(id ? `/learning/courses/${id}` : '/learning/courses', { method: id ? 'PUT' : 'POST', body }), id ? 'Course updated.' : 'Course added.');
  refresh('/learning', '/learning/catalogue');
  return r;
}

export async function archiveCourseAction(id: string) {
  const r = await act(() => api(`/learning/courses/${id}`, { method: 'DELETE' }), 'Course archived.');
  refresh('/learning', '/learning/catalogue');
  return r;
}

export async function savePathAction(id: string | null, body: Body) {
  const r = await act(() => api(id ? `/learning/paths/${id}` : '/learning/paths', { method: id ? 'PUT' : 'POST', body }), id ? 'Path updated.' : 'Learning path created.');
  refresh('/learning', '/learning/catalogue');
  return r;
}

export async function archivePathAction(id: string) {
  const r = await act(() => api(`/learning/paths/${id}`, { method: 'DELETE' }), 'Learning path archived.');
  refresh('/learning', '/learning/catalogue');
  return r;
}

export async function assignAction(body: Body) {
  const r = await act(() => api<{ created: number; skipped: string[] }>('/learning/assignments', { method: 'POST', body }));
  refresh('/learning');
  if (r.ok && r.data) {
    const { created, skipped } = r.data;
    r.message = `${created} assignment${created === 1 ? '' : 's'} created.${skipped.length ? ` Skipped: ${skipped.join('; ')}.` : ''}`;
  }
  return r;
}

export async function enrolAction(courseId: string) {
  const r = await act(() => api(`/learning/courses/${courseId}/enrol`, { method: 'POST' }), 'Enrolled. The course is in your learning.');
  refresh('/learning');
  return r;
}

export async function assignmentStepAction(id: string, step: 'start' | 'complete' | 'cancel', body: Body = {}) {
  const msg = { start: 'Started.', complete: 'Completion recorded.', cancel: 'Assignment removed.' }[step];
  const r = await act(() => api(`/learning/assignments/${id}/${step}`, { method: 'POST', body }), msg);
  refresh('/learning');
  return r;
}

// Surveys -----------------------------------------------------------------------------------------------------

export async function saveSurveyAction(id: string | null, body: Body) {
  const r = await act(() => api<{ id: string }>(id ? `/surveys/${id}` : '/surveys', { method: id ? 'PUT' : 'POST', body }), id ? 'Survey updated.' : 'Draft survey created.');
  refresh('/surveys/manage');
  return r;
}

export async function deleteSurveyAction(id: string) {
  const r = await act(() => api(`/surveys/${id}`, { method: 'DELETE' }), 'Draft survey deleted.');
  refresh('/surveys/manage');
  return r;
}

export async function surveyStepAction(id: string, step: 'open' | 'close') {
  const r = await act(() => api<{ invited?: number }>(`/surveys/${id}/${step}`, { method: 'POST' }), step === 'open' ? 'Survey opened. Everyone in its audience has been invited.' : 'Survey closed.');
  refresh('/surveys/manage', `/surveys/manage/${id}`, '/surveys');
  return r;
}

export async function respondAction(id: string, answers: Record<string, number | string | null>) {
  const r = await act(() => api(`/my-surveys/${id}/responses`, { method: 'POST', body: { answers } }), 'Thank you. Your answers were saved without your name.');
  refresh('/surveys', `/surveys/${id}`);
  return r;
}

// Recognition -------------------------------------------------------------------------------------------------

export async function recogniseAction(body: Body) {
  const r = await act(() => api('/recognition', { method: 'POST', body }), 'Recognition posted.');
  refresh('/recognition');
  return r;
}

export async function hideRecognitionAction(id: string, reason: string) {
  const r = await act(() => api(`/recognition/${id}/hide`, { method: 'POST', body: { reason } }), 'Hidden from the wall.');
  refresh('/recognition');
  return r;
}

export async function saveValueAction(id: string | null, body: Body) {
  const r = await act(() => api(id ? `/company-values/${id}` : '/company-values', { method: id ? 'PUT' : 'POST', body: { description: '', ...body } }), id ? 'Value updated.' : 'Value added.');
  refresh('/recognition');
  return r;
}

export async function archiveValueAction(id: string) {
  const r = await act(() => api(`/company-values/${id}`, { method: 'DELETE' }), 'Value archived.');
  refresh('/recognition');
  return r;
}
