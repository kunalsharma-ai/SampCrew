'use server';
import type { MobileAppConfig, MobileAppPublishInput } from '@crew/contracts';
import { act, api } from '@/lib/api';
import type { MobileAppOverview } from './types';

export async function saveMobileDraftAction(config: MobileAppConfig) {
  return act(() => api<MobileAppOverview>('/mobile-app/draft', { method: 'PUT', body: { config } }), 'Draft saved. Phones keep the published version until you publish.');
}

export async function discardMobileDraftAction() {
  return act(() => api<MobileAppOverview>('/mobile-app/draft/discard', { method: 'POST' }), 'Draft discarded.');
}

export async function publishMobileAction(input: MobileAppPublishInput) {
  return act(() => api<MobileAppOverview & { published: { version: number } }>('/mobile-app/publish', { method: 'POST', body: input }));
}

export async function restoreMobileVersionAction(version: number) {
  return act(() => api<MobileAppOverview & { published: { version: number } }>(`/mobile-app/versions/${version}/restore`, { method: 'POST', body: {} }));
}

export async function mobileVersionsAction() {
  return act(() => api<MobileAppVersion[]>('/mobile-app/versions'));
}

export interface MobileAppVersion { version: number; publishedAt: string; publishedBy: string | null; note: string; changes: string[]; restoredFrom: number | null }
