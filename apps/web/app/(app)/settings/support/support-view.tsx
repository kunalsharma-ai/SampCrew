'use client';
import { Alert, Badge, Button, Card, EmptyState, Table, TBody, TD, TH, THead, TR, type Tone } from '@crew/ui';
import { LifeBuoy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { supportDecisionAction } from '../actions';

export interface Grant { id: string; reason: string; durationMinutes: number; status: string; effectiveStatus: string; createdAt: string; decidedAt: string | null; expiresAt: string | null }

const TONE: Record<string, Tone> = { pending: 'warning', approved: 'success', rejected: 'neutral', revoked: 'neutral', expired: 'neutral' };

export function SupportView({ grants, canManage }: { grants: Grant[]; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = (id: string, d: 'approve' | 'reject' | 'revoke') => {
    setBusy(`${id}:${d}`);
    start(async () => {
      const r = await supportDecisionAction(id, d);
      setBusy(null);
      if (!r.ok) setError(r.message);
      else { setError(null); router.refresh(); }
    });
  };

  return (
    <Card>
      {error && <Alert tone="danger" className="m-4">{error}</Alert>}
      {grants.length === 0 ? (
        <EmptyState icon={<LifeBuoy className="size-6" />} title="No support requests" description="When SAMPLEDGE support asks to look at your workspace, the request appears here for you to approve or reject." />
      ) : (
        <Table>
          <THead>
            <TR><TH>Requested</TH><TH>Reason</TH><TH>Duration</TH><TH>Status</TH><TH>Expires</TH>{canManage && <TH />}</TR>
          </THead>
          <TBody>
            {grants.map((g) => (
              <TR key={g.id}>
                <TD className="whitespace-nowrap">{new Date(g.createdAt).toLocaleString()}</TD>
                <TD className="max-w-md">{g.reason}</TD>
                <TD className="tabular">{g.durationMinutes >= 60 ? `${g.durationMinutes / 60} h` : `${g.durationMinutes} min`}</TD>
                <TD><Badge tone={TONE[g.effectiveStatus] ?? 'neutral'} dot>{g.effectiveStatus}</Badge></TD>
                <TD className="whitespace-nowrap text-fg-muted">{g.expiresAt ? new Date(g.expiresAt).toLocaleString() : '—'}</TD>
                {canManage && (
                  <TD className="text-right">
                    {g.effectiveStatus === 'pending' && (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" loading={pending && busy === `${g.id}:approve`} onClick={() => decide(g.id, 'approve')}>Approve</Button>
                        <Button size="sm" variant="secondary" loading={pending && busy === `${g.id}:reject`} onClick={() => decide(g.id, 'reject')}>Reject</Button>
                      </div>
                    )}
                    {g.effectiveStatus === 'approved' && (
                      <Button size="sm" variant="danger" loading={pending && busy === `${g.id}:revoke`} onClick={() => confirm('End this support session now?') && decide(g.id, 'revoke')}>End access</Button>
                    )}
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
