'use client';
import { Alert, Button } from '@crew/ui';
import { useRunner } from '../../recruitment/use-runner';
import { recalculateAttritionAction } from '../actions';

export function RecalculateButton() {
  const { pending, notice, run } = useRunner();
  return (
    <div className="flex flex-col items-end gap-2">
      <Button variant="secondary" loading={pending} onClick={() => run(() => recalculateAttritionAction())}>Recalculate</Button>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
    </div>
  );
}
