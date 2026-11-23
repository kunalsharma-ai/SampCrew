'use client';
import type { ViewAsSession } from '@crew/contracts';
import { Button } from '@crew/ui';
import { Eye, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { exitViewAsAction } from '../../../console-actions';

/** The clear "you are viewing a client" bar: time left, and Exit, which ends the client's approval at once. */
export function ViewAsBanner({ session }: { session: ViewAsSession }) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  const [pending, start] = useTransition();
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const left = Math.max(0, new Date(session.expiresAt).getTime() - now);
  const mins = Math.ceil(left / 60_000);
  useEffect(() => { if (left === 0) router.refresh(); }, [left, router]);
  return (
    <div role="status" data-testid="view-as-banner" className="sticky top-14 z-20 -mx-4 mb-4 flex flex-wrap items-center gap-3 border-y border-warning/50 bg-warning/15 px-4 py-2 text-[13px] sm:-mx-8 sm:px-8">
      <Eye className="size-4 text-warning" aria-hidden />
      <span className="min-w-0 flex-1"><span className="font-semibold">Viewing {session.workspace} as SampCrew Support.</span> Read only, logged in their audit trail and ours. {left ? `${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`} left.` : 'Access has ended.'}</span>
      <Button size="sm" variant="danger" loading={pending} data-testid="view-as-exit" onClick={() => start(async () => { await exitViewAsAction(session.tenantId); router.push(`/tenants/${session.tenantId}`); })}><LogOut className="size-3.5" aria-hidden />Exit and end access</Button>
    </div>
  );
}
