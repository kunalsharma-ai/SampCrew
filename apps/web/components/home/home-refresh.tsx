'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useRefreshOn } from '@/components/live';

/**
 * Keeps Home current: it re-reads its figures when a notification, an approval, leave or an announcement changes (the
 * live stream says so), and every minute on the HR and Super Workspace views, where other people's check-ins move the
 * numbers. A tab in the background does not poll.
 */
export function HomeRefresh({ poll }: { poll: boolean }) {
  const router = useRouter();
  useRefreshOn(['notification', 'approvals.changed', 'leave.changed', 'announcements.changed']);
  useEffect(() => {
    if (!poll) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [poll, router]);
  return null;
}
