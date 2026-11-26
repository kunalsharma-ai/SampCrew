'use client';
import { Alert, Button, Dialog, Field, Select, Textarea } from '@crew/ui';
import { ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { WorkModeLabels } from '@/lib/types';
import { overrideAction } from '../../work-mode-actions';

/** Verify a day waiting for verification, or correct any day's office / home / hybrid result. A reason is required. */
export function VerifyButton({ row, labels }: { row: { employeeId: string; name: string; date: string; mode: string | null; corrected: unknown }; labels: WorkModeLabels }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<string>(row.mode === 'pending_verification' ? 'office' : row.mode ?? 'office');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pendingDay = row.mode === 'pending_verification';
  const save = () => start(async () => {
    setError(null);
    const r = await overrideAction({ employeeId: row.employeeId, workDate: row.date, mode: mode === 'auto' ? null : (mode as 'office'), reason });
    if (r.ok) { setOpen(false); router.refresh(); } else setError(r.message);
  });
  return (
    <>
      <Button size="sm" variant={pendingDay ? 'primary' : 'ghost'} onClick={() => setOpen(true)} data-testid="verify-day">{pendingDay ? <><ShieldCheck className="size-4" /> Verify</> : 'Correct'}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`${pendingDay ? 'Verify' : 'Correct'} ${row.name}, ${row.date}`} description="The change is recorded in the day's history and the audit trail, and the employee is told."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save} loading={pending} disabled={reason.trim().length < 3} data-testid="verify-save">Save</Button></>}>
        <div className="grid gap-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="The day counts as">{(f) => (
            <Select {...f} value={mode} onChange={(e) => setMode(e.target.value)} data-testid="verify-mode">
              <option value="office">{labels.office}</option>
              <option value="remote">{labels.remote}</option>
              <option value="hybrid">{labels.hybrid}</option>
              {Boolean(row.corrected) && <option value="auto">Remove the correction (use the automatic result)</option>}
            </Select>
          )}</Field>
          <Field label="Reason" required>{(f) => <Textarea {...f} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} placeholder="For example: confirmed with the badge log" data-testid="verify-reason" />}</Field>
        </div>
      </Dialog>
    </>
  );
}
