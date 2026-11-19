'use client';
import { Alert, Button, Dialog, Field, Textarea } from '@crew/ui';
import { Gift } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { grantRewardsAction, revokeRewardGrantAction } from './rewards-actions';

/** Grants a rule's payout to every winner of the month who does not have it yet. */
export function GrantRewardButton({ month, ruleId, ruleName, count, payout }: { month: string; ruleId: string; ruleName: string; count: number; payout: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  return (
    <>
      {count > 0 && <Button size="sm" onClick={() => { setNotice(null); setOpen(true); }} data-testid={`grant-${ruleId}`}><Gift className="size-3.5" aria-hidden /> Grant to {count}</Button>}
      {notice && <span role="status" className={notice.tone === 'success' ? 'text-xs text-success' : 'text-xs text-danger'}>{notice.text}</span>}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Grant ${ruleName}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              loading={pending}
              onClick={() => start(async () => {
                const r = await grantRewardsAction(month, ruleId);
                setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Granted.' } : { tone: 'danger', text: r.message });
                setOpen(false);
                if (r.ok) router.refresh();
              })}
            >
              Grant
            </Button>
          </>
        }
      >
        <p className="text-sm">
          {count} {count === 1 ? 'winner gets' : 'winners get'} {payout}. A bonus is added as an earning to the next payroll run of each person’s legal entity; leave is added to the balance now. Each winner is told, and every grant is kept in the audit log.
        </p>
      </Dialog>
    </>
  );
}

/** Takes one granted reward back, with a reason. */
export function RevokeGrantButton({ grantId, name }: { grantId: string; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => { setError(null); setReason(''); setOpen(true); }}>Take back</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Take back ${name}'s reward`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={pending}
              disabled={reason.trim().length < 3}
              onClick={() => start(async () => {
                const r = await revokeRewardGrantAction(grantId, reason.trim());
                if (!r.ok) return setError(r.message);
                setOpen(false);
                router.refresh();
              })}
            >
              Take back
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          {error && <Alert tone="danger">{error}</Alert>}
          <p className="text-sm text-fg-muted">A bonus not paid yet leaves payroll; leave days are taken off the balance again. A bonus already paid has to be recovered in payroll as a deduction.</p>
          <Field label="Reason" required>{(p) => <Textarea {...p} rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        </div>
      </Dialog>
    </>
  );
}
