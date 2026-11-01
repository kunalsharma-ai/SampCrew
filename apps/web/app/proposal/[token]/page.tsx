import { formatAmount, type PublicProposal } from '@crew/contracts';
import { Badge, Card, CardHeader, Table, TBody, TD, TH, THead, TR, buttonClass } from '@crew/ui';
import { Download } from 'lucide-react';
import type { Metadata } from 'next';
import { publicLoad } from '../../careers/public-api';
import { Respond } from './respond';

export const dynamic = 'force-dynamic';

const load = (token: string) => publicLoad<PublicProposal>(`/public/proposals/${/^[A-Za-z0-9_-]{32}$/.test(token) ? token : 'invalid'}`);

export async function generateMetadata(): Promise<Metadata> {
  return { title: { absolute: 'Staffing proposal' } };
}

const date = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export default async function ProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = await load(token);
  const money = (v: string) => `${p.currency} ${formatAmount(v, p.currency)}`;
  return (
    <div className="grid gap-8">
      <header className="grid gap-2">
        <p className="text-sm font-medium text-accent">{p.organisation}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{p.title}</h1>
        <p className="text-fg-muted">
          Proposal <span className="font-mono">{p.code}</span>, version {p.version}, for {p.clientName}. Issued {date(p.issuedOn)}
          {p.validUntil ? `, valid until ${date(p.validUntil)}` : ''}. Prepared by {p.preparedBy}.
        </p>
        <div><a href={`/proposal/${token}/pdf`} target="_blank" rel="noreferrer" className={buttonClass('secondary', 'sm')}><Download className="size-3.5" /> {p.status === 'accepted' ? 'Download the signed copy' : 'Download the PDF'}</a></div>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Figure label="People" value={String(p.headcount)} />
        <Figure label="Monthly total" value={money(p.monthlyRevenue)} />
        <Figure label={`Contract value, ${p.durationMonths} months`} value={money(p.contractRevenue)} />
      </div>

      <Card>
        <CardHeader title="Team and rates" description={`From ${date(p.startDate)} for ${p.durationMonths} months.`} />
        <div className="overflow-x-auto">
          <Table aria-label="Team and rates">
            <THead><TR><TH>Role</TH><TH>Location</TH><TH className="text-right">People</TH><TH className="text-right">Monthly rate each</TH><TH className="text-right">Per month</TH></TR></THead>
            <TBody>
              {p.lines.map((l, i) => (
                <TR key={i}>
                  <TD className="font-medium">{l.roleTitle}</TD>
                  <TD>{l.location ?? ''}</TD>
                  <TD className="text-right tabular-nums">{l.headcount}</TD>
                  <TD className="text-right tabular-nums whitespace-nowrap">{money(l.billMonthly)}</TD>
                  <TD className="text-right tabular-nums whitespace-nowrap">{money(l.monthlyRevenue)}</TD>
                </TR>
              ))}
              <TR><TD className="font-medium">Total</TD><TD /><TD className="text-right tabular-nums font-medium">{p.headcount}</TD><TD /><TD className="text-right tabular-nums font-medium whitespace-nowrap">{money(p.monthlyRevenue)}</TD></TR>
            </TBody>
          </Table>
        </div>
      </Card>

      {p.coverNote && <section className="grid gap-2"><h2 className="text-lg font-semibold">About this proposal</h2><p className="whitespace-pre-wrap text-[0.9375rem] leading-relaxed">{p.coverNote}</p></section>}
      {p.terms && <section className="grid gap-2"><h2 className="text-lg font-semibold">Terms</h2><p className="whitespace-pre-wrap text-sm leading-relaxed text-fg-muted">{p.terms}</p></section>}

      <Respond token={token} proposal={p} />
      {p.status === 'open' && <p className="text-xs text-fg-subtle">This link was sent only to you and works until {date(p.expiresAt)}. <Badge>Private</Badge></p>}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-fg-subtle">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </Card>
  );
}
