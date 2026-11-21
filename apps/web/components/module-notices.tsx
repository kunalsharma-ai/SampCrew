import type { NotificationCategory, NotificationView } from '@crew/contracts';
import { loadOptional } from '@/lib/api';
import { ModuleNoticesList } from './module-notices-list';

/**
 * Unread notices about one module, shown at the top of its page (Leave, Attendance, Learning ...), so a person sees
 * what changed without opening the bell. Nothing is shown when there is nothing unread.
 */
export async function ModuleNotices({ category, label }: { category: NotificationCategory; label: string }) {
  const r = await loadOptional<{ unread: number; items: NotificationView[] }>(`/notifications?category=${category}&unread=true&limit=4`);
  if (!r?.items.length) return null;
  return <ModuleNoticesList category={category} label={label} items={r.items} />;
}
