'use client';
import { useRefreshOn } from '@/components/live';

/** Refreshes the announcement pages when one is published, edited or deleted. */
export function LiveRefresh() {
  useRefreshOn(['announcements.changed']);
  return null;
}
