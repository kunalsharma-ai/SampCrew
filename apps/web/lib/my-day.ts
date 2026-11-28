import type { MemberPreferences } from '@crew/contracts';
import { loadOptional } from './api';
import { canSwitchWorkView } from './nav';
import type { Me } from './types';

/**
 * My Day (28 November 2026): a Super or HR Workspace person who switches to My Day sees only their own employee view,
 * their own attendance, leave and activity, never the organization's dashboards. Pages that mix the two ask this and
 * leave the organization part out. The API still decides what each person may see.
 */
export async function inMyDay(me: Me): Promise<boolean> {
  if (!canSwitchWorkView(me)) return false;
  const prefs = await loadOptional<MemberPreferences>('/me/preferences');
  return prefs?.experience?.workView === 'myday';
}
