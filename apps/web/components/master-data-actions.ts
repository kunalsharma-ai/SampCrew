'use server';
import { act, api } from '@/lib/api';

/** Active values of a master data list for a dropdown (anyone signed in). */
export async function masterOptionsAction(list: string) {
  return act(() => api<{ value: string; label: string; category: string | null }[]>(`/master-data/${encodeURIComponent(list)}/options`));
}

/**
 * "Other / add new": a value typed in a form joins the list for everyone, when the person may change the list. When
 * they may not, the record keeps the text they typed and the list stays as it is.
 */
export async function addTypedMasterValue(list: string, label: string) {
  const text = label.trim();
  if (!text) return;
  try {
    const have = await api<{ label: string }[]>(`/master-data/${encodeURIComponent(list)}/options`);
    if (have.some((o) => o.label.toLowerCase() === text.toLowerCase())) return;
    await api(`/master-data/${encodeURIComponent(list)}`, { method: 'POST', body: { label: text } });
  } catch {
    // No master data access, or it was added a moment ago: the record is saved either way.
  }
}
