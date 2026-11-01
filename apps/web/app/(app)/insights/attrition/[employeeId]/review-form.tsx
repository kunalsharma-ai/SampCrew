'use client';
import { Alert, Button, Field, Select, Textarea } from '@crew/ui';
import { useState } from 'react';
import { useRunner } from '../../../recruitment/use-runner';
import { reviewAttritionAction } from '../../actions';
import { OUTCOME } from '../../labels';
import type { ReviewOutcome } from '../../types';

export function ReviewForm({ employeeId }: { employeeId: string }) {
  const { pending, notice, run } = useRunner();
  const [outcome, setOutcome] = useState<ReviewOutcome>('action_planned');
  const [note, setNote] = useState('');
  return (
    <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(() => reviewAttritionAction(employeeId, { outcome, note: note.trim() }), () => setNote('')); }}>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Field label="Outcome">{(p) => <Select {...p} value={outcome} onChange={(e) => setOutcome(e.target.value as ReviewOutcome)}>{Object.entries(OUTCOME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
      <Field label="Note" hint="Optional. Keep it factual; it is visible to HR with access to this page.">{(p) => <Textarea {...p} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      <div><Button type="submit" loading={pending}>Record review</Button></div>
    </form>
  );
}
