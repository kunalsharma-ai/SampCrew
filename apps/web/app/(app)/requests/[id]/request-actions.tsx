'use client';
import { Button, Dialog, Field, Textarea } from '@crew/ui';
import { Ban } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useRefreshOn } from '@/components/live';
import { cancelRequestAction } from '../actions';

/** Reloads the request as approvers decide (live). */
export function LiveRefresh() {
  useRefreshOn(['approvals.changed']);
  return null;
}

export function CancelRequest({ id }: { id: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="cancel-request"><Ban className="size-4" /> Cancel request</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Cancel this request?" description="The people you looped in are told, and it leaves their Approvals."
        footer={<>
          <Button variant="ghost" onClick={() => setOpen(false)}>Keep it</Button>
          <Button variant="danger" loading={pending} onClick={() => start(async () => {
            const r = await cancelRequestAction(id, reason.trim() || undefined);
            if (!r.ok) { setError(r.message); return; }
            setOpen(false);
            router.refresh();
          })}>Cancel request</Button>
        </>}>
        <Field label="Reason (optional)" error={error ?? undefined} help={false}>
          {(a) => <Textarea {...a} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </Dialog>
    </>
  );
}
