'use server';
import type { ConsoleAlerts } from '@crew/contracts';
import { api } from '@/lib/api';

export async function consoleAlertsAction(): Promise<ConsoleAlerts | null> {
  return api<ConsoleAlerts>('/platform/alerts').catch(() => null);
}

export async function markConsoleAlertsSeenAction(): Promise<ConsoleAlerts | null> {
  return api<ConsoleAlerts>('/platform/alerts/seen', { method: 'POST' }).catch(() => null);
}
