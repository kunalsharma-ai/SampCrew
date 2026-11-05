'use client';
import { Alert, Button } from '@crew/ui';
import { useRunner } from '../../../recruitment/use-runner';
import { runAction } from '../../actions';

export function RunActions({ id, canRetry, canCancel }: { id: string; canRetry: boolean; canCancel: boolean }) {
  const { pending, notice, run } = useRunner();
  if (!canRetry && !canCancel && !notice) return null;
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {canRetry && <Button loading={pending} onClick={() => run(() => runAction(id, 'retry'))}>Retry from the failed step</Button>}
        {canCancel && <Button variant="danger" loading={pending} onClick={() => { if (confirm('Cancel this run? Any pending approval is withdrawn.')) run(() => runAction(id, 'cancel')); }}>Cancel run</Button>}
      </div>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
    </div>
  );
}
