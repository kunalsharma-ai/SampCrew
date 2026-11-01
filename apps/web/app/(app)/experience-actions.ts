'use server';
import type { AppearancePatch, DashboardLayout, MemberPreferences, SavedView, ViewPage, ViewState } from '@crew/contracts';
import { act, api } from '@/lib/api';
import { writeAppearanceCookie } from '@/lib/appearance-cookie';

export async function saveAppearanceAction(patch: AppearancePatch) {
  const r = await act(() => api<MemberPreferences>('/me/preferences/appearance', { method: 'PUT', body: patch }), 'Appearance saved');
  if (r.ok && r.data) await writeAppearanceCookie(r.data.appearance);
  return r;
}

export async function resetAppearanceAction() {
  const r = await act(() => api<MemberPreferences>('/me/preferences/appearance/reset', { method: 'POST' }), 'Back to the default appearance');
  if (r.ok && r.data) await writeAppearanceCookie(r.data.appearance);
  return r;
}

/** The shell calls this when the saved preference (database) and this browser's cookie copy differ. */
export async function syncAppearanceCookieAction(prefs: MemberPreferences['appearance']) {
  await writeAppearanceCookie(prefs);
}

export async function saveFavouritesAction(hrefs: string[]) {
  return act(() => api<MemberPreferences>('/me/preferences/favourites', { method: 'PUT', body: { hrefs } }));
}

export async function recordVisitAction(href: string, label: string) {
  return act(() => api<MemberPreferences>('/me/preferences/recents', { method: 'POST', body: { href, label } }));
}

export async function saveDashboardAction(layout: DashboardLayout) {
  return act(() => api<MemberPreferences>('/me/preferences/dashboard', { method: 'PUT', body: layout }), 'Layout saved');
}

export async function saveNotesAction(notes: string) {
  return act(() => api<MemberPreferences>('/me/preferences/notes', { method: 'PUT', body: { notes } }), 'Notes saved');
}

export async function decideApprovalAction(id: string, decision: 'approve' | 'reject', comment?: string) {
  return act(() => api(`/approvals/${id}/${decision}`, { method: 'POST', body: comment ? { comment } : {} }), decision === 'approve' ? 'Approved' : 'Rejected');
}

interface SearchHit { kind: 'employee' | 'candidate'; id: string; title: string; detail: string | null; href: string }

/** Command palette search across people the member can see. Each source applies its own permission checks. */
export async function paletteSearchAction(q: string, sources: { employees: boolean; candidates: boolean }): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const hits: SearchHit[] = [];
  const enc = encodeURIComponent(term);
  const [emps, cands] = await Promise.all([
    sources.employees ? api<{ items: { id: string; displayName: string; employeeCode: string; designationName: string | null; departmentName: string | null }[] }>(`/employees?q=${enc}&limit=6`).catch(() => null) : null,
    sources.candidates ? api<{ id: string; firstName: string; lastName: string }[]>(`/recruitment/candidates?q=${enc}`).catch(() => null) : null,
  ]);
  for (const e of emps?.items ?? []) hits.push({ kind: 'employee', id: e.id, title: e.displayName, detail: [e.employeeCode, e.designationName ?? e.departmentName].filter(Boolean).join(' · ') || null, href: `/employees/${e.id}` });
  const candList = cands ?? [];
  for (const c of candList.slice(0, 6)) hits.push({ kind: 'candidate', id: c.id, title: `${c.firstName} ${c.lastName}`, detail: 'Candidate', href: `/recruitment/candidates/${c.id}` });
  return hits;
}

// Saved table views ---------------------------------------------------------------------------------------

export async function createViewAction(page: ViewPage, name: string, state: ViewState, isDefault: boolean) {
  return act(() => api<SavedView>('/me/views', { method: 'POST', body: { page, name, state, isDefault } }), 'View saved');
}

export async function updateViewAction(id: string, patch: { name?: string; state?: ViewState; isDefault?: boolean }) {
  return act(() => api<SavedView>(`/me/views/${id}`, { method: 'PATCH', body: patch }), 'View updated');
}

export async function deleteViewAction(id: string) {
  return act(() => api(`/me/views/${id}`, { method: 'DELETE' }), 'View deleted');
}
