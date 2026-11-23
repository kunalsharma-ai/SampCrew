import { Badge, Card, CardBody, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Building2 } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LocalTime } from '@/components/local-time';
import { load } from '@/lib/api';
import { fmtMoneyMap } from '@/lib/format';
import { AddWorkspaceButton, MoveWorkspaceButton } from '../client-controls';
import { ClientHeader } from '../client-header';
import { loadClient } from '../load-client';

export const metadata: Metadata = { title: 'Company workspaces' };

/** The company's structure: each Super Workspace, its HR Workspaces and how many people are in each. */
export default async function ClientWorkspacesPage({ params }: { params: Promise<{ id: string }> }) {
  const r = await loadClient((await params).id);
  if (!r) notFound();
  const { c, caps, canManage } = r;
  const [plans, options] = canManage ? await Promise.all([
    load<{ key: string; name: string; archivedAt: string | null; retiredAt?: string | null }[]>('/platform/plans').catch(() => []),
    load<{ id: string; name: string }[]>('/platform/clients/options').catch(() => []),
  ]) : [[], []];
  const open = plans.filter((p) => !p.archivedAt && !p.retiredAt).map((p) => ({ key: p.key, name: p.name }));
  return (
    <>
      <ClientHeader c={c} current="workspaces" caps={caps} actions={canManage && !c.profile.archivedAt ? <AddWorkspaceButton c={c} plans={open} /> : undefined} />
      {!c.workspaces.length ? <Card><EmptyState icon={<Building2 className="size-6" />} title="No Super Workspace yet" description="Add one to start the subscription." /></Card> : (
        <div className="grid gap-5">
          {c.workspaces.map((w) => (
            <Card key={w.id} data-testid="client-workspace">
              <CardHeader
                title={<span className="flex flex-wrap items-center gap-2"><Link href={`/tenants/${w.id}`} className="hover:underline">{w.name}</Link><Badge tone={w.status === 'active' ? 'success' : 'danger'} dot>{w.status}</Badge>{!w.setupDone && <Badge tone="accent">Setup pending</Badge>}{w.isDemo && <Badge tone="ember">Demo</Badge>}</span>}
                description={<>Super Workspace · <span className="font-mono">{w.slug}</span> · {w.plan?.name ?? 'No plan'} · created <LocalTime value={w.createdAt} dateOnly />{w.lastActivityAt ? <> · active <LocalTime value={w.lastActivityAt} relative /></> : null}</>}
                action={canManage && options.length > 1 ? <MoveWorkspaceButton tenantId={w.id} name={w.name} from={c.profile.id} options={options} /> : undefined}
              />
              <CardBody className="grid gap-4">
                <div className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-5">
                  <Stat label="Users" value={w.counts.users} hint={`${w.counts.activeUsers} active`} />
                  <Stat label="Invited" value={w.counts.invited} />
                  <Stat label="HR and admin users" value={w.counts.hrUsers} />
                  <Stat label="Employees" value={w.counts.employees} />
                  <Stat label="Employee Workspaces" value={w.counts.employeeWorkspaces} />
                </div>
                {w.revenue && <p className="text-[12.5px] text-fg-muted">Paid {fmtMoneyMap(w.revenue)} · outstanding {fmtMoneyMap(w.outstanding, 'nothing')}{w.overdue ? <Badge tone="danger" className="ml-2">Overdue</Badge> : null}</p>}
                <Table aria-label={`HR Workspaces in ${w.name}`}>
                  <THead><TR><TH>HR Workspace</TH><TH>Status</TH><TH className="text-right">People</TH></TR></THead>
                  <TBody>
                    {w.hrWorkspaces.map((h) => <TR key={h.id ?? 'central'}><TD>{h.name}</TD><TD><Badge tone={h.status === 'active' ? 'success' : 'neutral'}>{h.status}</Badge></TD><TD className="text-right tabular">{h.people}</TD></TR>)}
                  </TBody>
                </Table>
                <div className="flex flex-wrap gap-3 text-[12.5px]">
                  <Link href={`/tenants/${w.id}`} className="text-accent hover:underline">Account details</Link>
                  {caps.includes('users:read') && <Link href={`/tenants/${w.id}/users`} className="text-accent hover:underline">Users</Link>}
                  {caps.includes('billing:read') && <Link href={`/tenants/${w.id}/billing`} className="text-accent hover:underline">Billing</Link>}
                  <Link href={`/tenants/${w.id}/access`} className="text-accent hover:underline">Features &amp; permissions</Link>
                  {caps.includes('support:chat') && <Link href={`/support?tenant=${w.id}&start=1`} className="text-accent hover:underline">Message this Super Workspace</Link>}
                  {caps.includes('support:request') && <Link href={`/tenants/${w.id}/view-as`} className="text-accent hover:underline">View as (support access)</Link>}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return <div className="rounded-lg border border-border px-3 py-2"><div className="text-[11.5px] text-fg-subtle">{label}</div><div className="text-[18px] font-semibold tabular">{value}</div>{hint && <div className="text-[11px] text-fg-subtle">{hint}</div>}</div>;
}
