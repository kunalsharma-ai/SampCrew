'use client';
import { Button } from '@crew/ui';
import { Check, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { DecisionDialog } from '../[id]/request-actions';

/** Approve, reject or request changes from the My Approvals table, each with its confirmation dialog. */
export function RowActions({ id, subject }: { id: string; subject: string }) {
  const [open, setOpen] = useState<'approve' | 'reject' | 'changes' | null>(null);
  return (
    <div className="flex items-center gap-1" data-testid="row-actions">
      <Button size="sm" onClick={() => setOpen('approve')} aria-label={`Approve ${subject}`} data-testid="row-approve"><Check className="size-3.5" /> Approve</Button>
      <Button size="sm" variant="secondary" onClick={() => setOpen('changes')} aria-label={`Request changes to ${subject}`} title="Request changes" data-testid="row-changes"><RotateCcw className="size-3.5" /></Button>
      <Button size="sm" variant="danger" onClick={() => setOpen('reject')} aria-label={`Reject ${subject}`} title="Reject" data-testid="row-reject"><X className="size-3.5" /></Button>
      <DecisionDialog id={id} decision={open} onClose={() => setOpen(null)} subject={subject} />
    </div>
  );
}
