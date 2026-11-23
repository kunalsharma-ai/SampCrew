import { CLIENT_INDUSTRY_LABEL } from '@crew/contracts';
import { Badge, Card, CardBody, CardHeader } from '@crew/ui';
import { Building2, Globe, Headset, Link2, Mail, MapPin, Phone, Ticket, Users, Wallet } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LocalTime } from '@/components/local-time';
import { Tile, TileRow } from '@/components/neon';
import { load } from '@/lib/api';
import { fmtMoneyMap } from '@/lib/format';
import { ArchiveButton, EditProfileButton, LookupCard } from './client-controls';
import { ClientHeader } from './client-header';
import { loadClient } from './load-client';

export const metadata: Metadata = { title: 'Company' };

/**
 * Company 360: who the client is, its structure (Company > Super > HR > Employee Workspaces > people), subscription
 * and money (with billing permission), support and account details. Counts only; no employee records.
 */
export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const r = await loadClient((await params).id);
  if (!r) notFound();
  const { c, caps, canManage } = r;
  const p = c.profile;
  const managers = canManage ? await load<{ id: string; name: string }[]>('/platform/clients/managers').catch(() => []) : [];
  const addr = p.address ? [p.address.line1, p.address.line2, p.address.city, p.address.state, p.address.postalCode, p.address.country].filter(Boolean).join(', ') : '';
  const src = (k: string) => (p.fieldSources[k]?.source ? <span className="ml-1 text-[10.5px] text-fg-subtle">(Brandfetch)</span> : null);
  return (
    <>
      <ClientHeader c={c} current="overview" caps={caps} actions={canManage ? <><EditProfileButton c={c} managers={managers} /><ArchiveButton c={c} /></> : undefined} />
      <TileRow>
        <Tile label="Super Workspaces" value={c.totals.superWorkspaces} tone="violet" icon={<Building2 className="size-4" />} href={`/clients/${p.id}/workspaces`} testId="client-tile-super" />
        <Tile label="HR Workspaces" value={c.totals.hrWorkspaces} tone="teal" icon={<Building2 className="size-4" />} hint={`${c.totals.employeeWorkspaces} Employee Workspaces`} />
        <Tile label="Users" value={c.totals.users} tone="green" icon={<Users className="size-4" />} hint={`${c.totals.activeUsers} active · ${c.totals.pendingInvitations} invited`} href={caps.includes('users:read') ? `/clients/${p.id}/users` : undefined} />
        <Tile label="Employees" value={c.totals.employees} tone="orange" icon={<Users className="size-4" />} hint={`${c.totals.hrUsers} HR and admin users`} />
      </TileRow>
      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <div className="grid gap-5 lg:col-span-2">
          <Card>
            <CardHeader title="Company profile" description={p.piiMasked ? 'Contact details are masked for your role.' : undefined} />
            <CardBody className="grid gap-4 text-[13px] sm:grid-cols-2">
              <div className="sm:col-span-2">{p.description ? <p className="whitespace-pre-line text-fg-muted">{p.description}{src('description')}</p> : <p className="text-fg-subtle">No description yet.</p>}</div>
              <Info label="Industry">{p.industry ? CLIENT_INDUSTRY_LABEL[p.industry as keyof typeof CLIENT_INDUSTRY_LABEL] ?? p.industry : null}</Info>
              <Info label="Size">{p.companySize ? `${p.companySize} people` : null}</Info>
              <Info label="Founded">{p.foundedYear ? <>{p.foundedYear}{src('founded_year')}</> : null}</Info>
              <Info label="Customer since">{p.createdAt ? <LocalTime value={p.createdAt} dateOnly /> : null}</Info>
              <Info label="Website" icon={<Globe className="size-3.5" />}>{p.website ? <a href={p.website} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{p.website.replace(/^https?:\/\//, '')}</a> : null}</Info>
              <Info label="LinkedIn" icon={<Link2 className="size-3.5" />}>{p.linkedin ? <a href={p.linkedin} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Company page</a> : null}{p.linkedin && src('linkedin')}</Info>
              <Info label="Email" icon={<Mail className="size-3.5" />}>{p.email}</Info>
              <Info label="Phone" icon={<Phone className="size-3.5" />}>{[p.phone, p.whatsapp ? `WhatsApp ${p.whatsapp}` : null].filter(Boolean).join(' · ') || null}</Info>
              <Info label="Address" icon={<MapPin className="size-3.5" />} wide>{addr ? <>{addr}{src('address')}</> : null}</Info>
              <Info label="Primary contact" wide>{p.primaryContact?.name ? [p.primaryContact.name, p.primaryContact.title, p.primaryContact.email, p.primaryContact.phone].filter(Boolean).join(' · ') : null}</Info>
            </CardBody>
          </Card>
          <LookupCard c={c} canManage={canManage} />
        </div>
        <div className="grid content-start gap-5">
          {c.money && (
            <Card>
              <CardHeader title="Money" action={<Link href={`/clients/${p.id}/billing`} className="text-[12px] text-accent hover:underline">Billing</Link>} />
              <CardBody className="grid gap-2 text-[13px]">
                <Row icon={<Wallet className="size-3.5" />} label="Monthly recurring">{fmtMoneyMap(c.money.mrr)}</Row>
                <Row label="Paid to date">{fmtMoneyMap(c.money.revenue)}</Row>
                <Row label="Outstanding"><span className={Object.values(c.money.outstanding).some((v) => Number(v) > 0) ? 'font-medium text-warning' : undefined}>{fmtMoneyMap(c.money.outstanding, 'Nothing due')}</span></Row>
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="Subscriptions" />
            <CardBody className="grid gap-2 text-[13px]">
              {c.workspaces.map((w) => (
                <div key={w.id} className="flex items-start justify-between gap-2">
                  <span className="min-w-0"><Link href={`/tenants/${w.id}`} className="font-medium hover:underline">{w.name}</Link><span className="block text-[11.5px] text-fg-subtle">{w.plan?.name ?? 'No plan'}{w.subscription ? ` · ${w.subscription.seats} seats · ${w.subscription.billingCycle}` : ''}</span></span>
                  <span className="text-right">
                    <Badge tone={w.subscription?.status === 'active' ? 'success' : w.subscription?.status === 'trialing' ? 'info' : w.subscription?.status === 'past_due' ? 'warning' : 'neutral'}>{w.subscription?.status.replace('_', ' ') ?? 'none'}</Badge>
                    <span className="block text-[11px] text-fg-subtle">{w.subscription ? (w.subscription.status === 'trialing' ? `Trial ends ${w.subscription.trialEndsOn}` : w.subscription.cancelAtPeriodEnd ? `Ends ${w.subscription.currentPeriodEnd}` : `Renews ${w.subscription.currentPeriodEnd}`) : ''}</span>
                  </span>
                </div>
              ))}
              {!c.workspaces.length && <p className="text-fg-muted">No Super Workspace yet.</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Support" />
            <CardBody className="grid gap-2 text-[13px]">
              <Row icon={<Headset className="size-3.5" />} label="Open conversations">{caps.includes('support:chat') ? <Link href="/support" className="text-accent hover:underline">{c.support.openConversations}</Link> : c.support.openConversations}</Row>
              <Row icon={<Ticket className="size-3.5" />} label="Open tickets">{caps.includes('help:answer') ? <Link href="/help-queries" className="text-accent hover:underline">{c.support.openTickets}</Link> : c.support.openTickets}</Row>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Super Workspace Admins" description={p.piiMasked ? 'Emails masked for your role.' : undefined} />
            <CardBody className="grid gap-1.5 text-[13px]">
              {c.superWorkspaceAdmins.map((a) => <div key={`${a.workspaceId}${a.name}`}><span className="font-medium">{a.name}</span><span className="block text-[11.5px] text-fg-subtle">{a.email} · {c.workspaces.find((w) => w.id === a.workspaceId)?.name}</span></div>)}
              {!c.superWorkspaceAdmins.length && <p className="text-fg-muted">None active.</p>}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

function Info({ label, icon, wide, children }: { label: string; icon?: React.ReactNode; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <div className="flex items-center gap-1 text-[11.5px] text-fg-subtle">{icon}{label}</div>
      <div className="mt-0.5">{children ?? <span className="text-fg-subtle">Not set</span>}</div>
    </div>
  );
}

function Row({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-fg-muted">{icon}{label}</span><span className="text-right tabular">{children}</span></div>;
}
