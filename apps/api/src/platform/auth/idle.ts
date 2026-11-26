import type { PlatformTx } from '../database/mongo.service';

/**
 * Automatic sign-out after inactivity (issue #89). Only the Super Workspace sets the time, for everyone in the company
 * (Super Workspace, HR Workspace and Employee Workspace people alike); null means off. The browser and the phone
 * report real use (POST /auth/activity); background refreshes and polling never count as use.
 */
export async function idleLimit(tx: PlatformTx, tenantId: string | null | undefined, client: string): Promise<number | null> {
  if (!tenantId || (client !== 'web' && client !== 'mobile')) return null;
  const t = await tx.collection('tenants').findOne({ id: tenantId }, { projection: { session_idle_minutes: 1 } });
  const m = t?.session_idle_minutes;
  return typeof m === 'number' && m > 0 ? m : null;
}

/** A minute of grace covers the browser's own timer and clock drift. */
export function isIdle(lastActiveAt: Date | string | null | undefined, minutes: number, now = Date.now()): boolean {
  if (!lastActiveAt) return false;
  return now - new Date(lastActiveAt).getTime() > (minutes + 1) * 60_000;
}
