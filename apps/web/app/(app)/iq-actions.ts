'use server';
import type { IqAnswer } from '@crew/contracts';
import { act, api } from '@/lib/api';

export async function askIqAction(question: string, path: string) {
  return act(() => api<IqAnswer>('/iq/ask', { method: 'POST', body: { question, path: path.slice(0, 200) } }));
}
