'use server';
import { act, apiForm } from '@/lib/api';

const FIELDS = ['firstName', 'lastName', 'email', 'phone', 'locationText', 'profileUrl', 'coverNote', 'consent', 'website'];

/** Public application. Passes only the expected fields and the CV through to the API, without any session. */
export async function applyAction(site: string, job: string, form: FormData) {
  const out = new FormData();
  for (const k of FIELDS) {
    const v = form.get(k);
    if (typeof v === 'string' && v.trim() !== '') out.set(k, v.trim());
  }
  const cv = form.get('cv');
  if (cv instanceof File && cv.size > 0) out.set('cv', cv, cv.name);
  return act(() => apiForm<{ received: boolean }>(`/public/careers/${encodeURIComponent(site)}/jobs/${encodeURIComponent(job)}/apply`, out, { auth: false }));
}
