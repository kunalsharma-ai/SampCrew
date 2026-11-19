'use client';
import { Alert, Button, Card, CardHeader, Field, Textarea } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { decideProfileUpdateAction } from '../../actions';

/** HR's decision on a profile update: approve, reject with a reason, or ask the employee for more. */
export function DecidePanel({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [remarks, setRemarks] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const decide = (d: 'approve' | 'reject' | 'request_info') => start(async () => {
    const r = await decideProfileUpdateAction(id, d, remarks.trim() || undefined);
    setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Done.' } : { tone: 'danger', text: r.message });
    if (r.ok) router.refresh();
  });
  const needs = remarks.trim().length < 3;
  return (
    <Card>
      <CardHeader title="Your decision" description="Approving updates the official record at once and tells the employee. Rejecting or asking for information sends them your remarks." />
      <div className="grid gap-4 px-5 pb-5">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        <Field label="Remarks" hint="Needed to reject or to ask for information.">{(p) => <Textarea {...p} rows={3} maxLength={1000} value={remarks} onChange={(e) => setRemarks(e.target.value)} />}</Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={needs || pending} onClick={() => decide('request_info')}>Ask for information</Button>
          <Button variant="danger" disabled={needs || pending} onClick={() => decide('reject')}>Reject</Button>
          <Button loading={pending} onClick={() => decide('approve')}>Approve</Button>
        </div>
      </div>
    </Card>
  );
}
