'use client';
import { Button } from '@crew/ui';
import { MessagesSquare } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { openConversationAction } from '../../actions';

/** Opens (or starts) this employee's conversation with the HR team. */
export function HrChatButton({ membershipId }: { membershipId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" loading={pending} onClick={() => start(async () => {
      const r = await openConversationAction({ kind: 'hr', membershipId });
      if (r.ok) router.push(`/communication/chat/${r.data!.id}`);
    })}><MessagesSquare className="size-3.5" /> Message</Button>
  );
}
