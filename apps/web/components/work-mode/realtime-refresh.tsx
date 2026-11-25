'use client';
import { useRefreshOn } from '@/components/live';

/** Attendance pages update as check-ins, check-outs, verifications and corrections happen (no reload needed). */
export function RealtimeRefresh() {
  useRefreshOn(['attendance.changed', 'approvals.changed']);
  return null;
}
