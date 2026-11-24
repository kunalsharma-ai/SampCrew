import type { NotificationCategory, NotificationView } from '@crew/contracts';
import { loadOptional } from '@/lib/api';
import { ModuleNoticesList } from './module-notices-list';

/**
 * Unread notices about one module, shown at the top of its page (Leave, Attendance, Recruitment, Payroll ...), so a
 * person sees what changed and what needs them without opening the bell. The same notices as the bell and Home:
 * reading one here marks it read there too. Nothing is shown when there is nothing unread.
 */
export async function ModuleNotices({ category, label, exceptKinds = [] }: { category: NotificationCategory | NotificationCategory[]; label: string; exceptKinds?: string[] }) {
  const cats = Array.isArray(category) ? category : [category];
  const lists = await Promise.all(cats.map((c) => loadOptional<{ unread: number; items: NotificationView[] }>(`/notifications?category=${c}&unread=true&limit=5`)));
  const items = lists.flatMap((r) => r?.items ?? []).filter((n) => !exceptKinds.includes(n.kind)).sort((a, b) => Number(b.actionRequired) - Number(a.actionRequired) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  return <ModuleNoticesList categories={cats} label={label} items={items} exceptKinds={exceptKinds} />;
}
