'use client';
import type { SecurityOverview } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, Table, TBody, TD, TH, THead, TR, cn } from '@crew/ui';
import { AlertOctagon, AlertTriangle, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { LocalTime } from '@/components/local-time';
import { revokeAdminSessionsAction, revokeSessionAction } from '../console-actions';

export function SecurityView({ data, tab }: { data: SecurityOverview; tab: 'overview' | 'sessions' | 'logins' }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<{ kind: 'one'; id: string; label: string } | { kind: 'all'; adminId: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const active = data.sessions.filter((s) => s.active);
  return (
    <div className="grid gap-4">
      <nav className="flex gap-1 border-b border-border" aria-label="Security">
        {([['overview', 'Overview'], ['sessions', `Sessions (${active.length})`], ['logins', 'Sign-in history']] as const).map(([k, l]) => (
          <Link key={k} href={k === 'overview' ? '/security' : `/security?tab=${k}`} aria-current={tab === k ? 'page' : undefined} className={cn('-mb-px border-b-2 px-3 py-2 text-[13px]', tab === k ? 'border-accent font-medium text-accent' : 'border-transparent text-fg-muted hover:text-fg')}>{l}</Link>
        ))}
      </nav>
      {error && <Alert tone="danger">{error}</Alert>}
      {tab === 'overview' && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Num label="Console admins" value={data.admins.total} />
            <Num label="Without two-step" value={data.admins.withoutMfa} tone={data.admins.withoutMfa ? 'warning' : undefined} />
            <Num label="Locked" value={data.admins.locked} tone={data.admins.locked ? 'danger' : undefined} />
            <Num label="Disabled" value={data.admins.disabled} />
          </div>
          <Card data-testid="suspicious">
            <CardHeader title="Suspicious activity" description="Checked on each visit: failed sign-ins, unknown emails, locked admins, sign-ins from new IPs, refused actions and unusual exports." />
            <CardBody className="grid gap-2">
              {!data.suspicious.length ? <p className="flex items-center gap-2 text-[13px] text-success"><ShieldCheck className="size-4" aria-hidden />Nothing unusual found.</p> : data.suspicious.map((s) => {
                const Icon = s.level === 'critical' ? AlertOctagon : AlertTriangle;
                return (
                  <div key={s.key} className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2 text-[13px]">
                    <Icon className={cn('mt-0.5 size-4 shrink-0', s.level === 'critical' ? 'text-danger' : 'text-warning')} aria-hidden />
                    <div className="min-w-0 flex-1"><div className="font-medium">{s.title}</div><div className="text-[12px] text-fg-muted">{s.detail}</div></div>
                    <span className="whitespace-nowrap text-[11.5px] text-fg-subtle"><LocalTime value={s.at} relative /></span>
                  </div>
                );
              })}
              <p className="text-[12px] text-fg-subtle">Thresholds are set in <Link href="/settings" className="text-accent hover:underline">Settings</Link>. Every refused action is in the <Link href="/audit?status=denied" className="text-accent hover:underline">audit log</Link>.</p>
            </CardBody>
          </Card>
        </>
      )}
      {tab === 'sessions' && (
        <Card>
          {!active.length ? <EmptyState title="No open sessions" /> : (
            <Table aria-label="Open Console sessions">
              <THead><TR><TH>Admin</TH><TH>Signed in</TH><TH>Expires</TH><TH>From</TH><TH>Two-step</TH><TH /></TR></THead>
              <TBody>
                {active.map((s) => (
                  <TR key={s.id} data-testid="session-row">
                    <TD><span className="font-medium">{s.admin}</span>{s.current && <Badge tone="accent" className="ml-2">This session</Badge>}<span className="block text-[11.5px] text-fg-subtle">{s.email}</span></TD>
                    <TD className="whitespace-nowrap text-fg-muted"><LocalTime value={s.createdAt} /></TD>
                    <TD className="whitespace-nowrap text-fg-muted"><LocalTime value={s.expiresAt} relative /></TD>
                    <TD className="text-[12px] text-fg-muted">{s.ip ?? '—'}<span className="block text-[11px] text-fg-subtle">{s.device}</span></TD>
                    <TD>{s.mfa ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Not yet</Badge>}</TD>
                    <TD className="whitespace-nowrap text-right">
                      {!s.current && <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'one', id: s.id, label: `${s.admin}'s session from ${s.ip ?? 'an unknown IP'}` })}>Sign out</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'all', adminId: s.adminId, label: `every session of ${s.admin}` })}>All of theirs</Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}
      {tab === 'logins' && (
        <Card>
          {!data.logins.length ? <EmptyState title="No sign-ins yet" /> : (
            <Table aria-label="Sign-in history">
              <THead><TR><TH>When</TH><TH>Admin</TH><TH>Result</TH><TH>From</TH><TH>Detail</TH></TR></THead>
              <TBody>
                {data.logins.map((l, i) => (
                  <TR key={`${l.at}${i}`}>
                    <TD className="whitespace-nowrap text-fg-muted"><LocalTime value={l.at} /></TD>
                    <TD>{l.admin ?? 'Unknown email'}</TD>
                    <TD>{l.ok ? <Badge tone="success">Signed in</Badge> : <Badge tone="danger">Failed</Badge>}</TD>
                    <TD className="text-[12px] text-fg-muted">{l.ip ?? '—'}<span className="block text-[11px] text-fg-subtle">{l.device}</span></TD>
                    <TD className="text-[12px] text-fg-muted">{l.detail ?? ''}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}
      {confirm && (
        <Dialog open onClose={() => setConfirm(null)} title="End sessions" description={`Signs out ${confirm.label}. They can sign in again with their password and two-step code. Recorded in the audit log.`}
          footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="danger" loading={pending} onClick={() => start(async () => {
            const r = confirm.kind === 'one' ? await revokeSessionAction(confirm.id) : await revokeAdminSessionsAction(confirm.adminId);
            if (!r.ok) setError(r.message ?? 'Not signed out');
            setConfirm(null);
            router.refresh();
          })} data-testid="revoke-confirm">Sign out</Button></>}>
          <p className="text-[13px] text-fg-muted">{confirm.kind === 'all' ? 'If this includes your own session you are signed out too.' : ''}</p>
        </Dialog>
      )}
    </div>
  );
}

function Num({ label, value, tone }: { label: string; value: number; tone?: 'warning' | 'danger' }) {
  return <Card><CardBody><div className="text-[12px] text-fg-subtle">{label}</div><div className={cn('text-[22px] font-semibold tabular', tone === 'warning' && 'text-warning', tone === 'danger' && 'text-danger')}>{value}</div></CardBody></Card>;
}
