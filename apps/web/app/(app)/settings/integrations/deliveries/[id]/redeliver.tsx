'use client';
import { Button } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useRunner } from '../../../../recruitment/use-runner';
import { redeliverAction } from '../../actions';

export function Redeliver({ id }: { id: string }) {
  const router = useRouter();
  const { pending, notice, run } = useRunner();
  return (
    <div className="flex items-center gap-3">
      {notice && <span role="status" className={notice.tone === 'danger' ? 'text-[0.8125rem] text-danger' : 'text-[0.8125rem] text-fg-muted'}>{notice.text}</span>}
      <Button loading={pending} onClick={() => run(() => redeliverAction(id), () => setTimeout(() => router.refresh(), 3000))}>Send again</Button>
    </div>
  );
}
