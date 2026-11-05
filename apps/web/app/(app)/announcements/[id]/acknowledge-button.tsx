'use client';
import { Alert, Button } from '@crew/ui';
import { useRunner } from '../../recruitment/use-runner';
import { acknowledgeAction } from '../../helpdesk/actions';

export function AcknowledgeButton({ id }: { id: string }) {
  const { pending, notice, run } = useRunner();
  return (
    <>
      {notice?.tone === 'danger' && <Alert tone="danger">{notice.text}</Alert>}
      <Button loading={pending} onClick={() => run(() => acknowledgeAction(id))}>I have read this</Button>
    </>
  );
}
