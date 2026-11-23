'use client';
import { Button } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { cancelLeaveAction } from '../../actions';

export function CancelRequest({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="secondary" loading={pending} data-feature="leave.cancel" onClick={() => {
      const reason = prompt('Cancel this application? Add a reason (optional):');
      if (reason === null) return;
      start(async () => { const r = await cancelLeaveAction(id, reason || undefined); if (r.ok) router.refresh(); else alert(r.message); });
    }}>Cancel application</Button>
  );
}
