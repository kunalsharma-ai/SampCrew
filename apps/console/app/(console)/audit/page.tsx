import { Badge, Card, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';

export const metadata: Metadata = { title: 'Platform audit' };

interface Entry { id: string; actorType: string; actorLabel: string | null; action: string; resourceType: string; resourceId: string | null; changes: unknown; metadata: unknown; ip: string | null; createdAt: string }

export default async function PlatformAuditPage() {
  const rows = await load<Entry[]>('/platform/audit');
  return (
    <>
      <PageHeader title="Platform audit" description="Actions by SAMPLEDGE staff and the platform itself, newest first (last 100). Actions inside a customer workspace also appear in that customer's own audit trail." />
      <Card>
        {rows.length === 0 ? <EmptyState title="No platform activity yet" /> : (
          <Table>
            <THead><TR><TH>When</TH><TH>Actor</TH><TH>Action</TH><TH>Resource</TH><TH>Details</TH></TR></THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</TD>
                  <TD>{r.actorLabel ?? 'System'} <Badge className="ml-1">{r.actorType}</Badge></TD>
                  <TD><code className="text-xs">{r.action}</code></TD>
                  <TD className="text-fg-muted">
                    {r.resourceType === 'tenant' && r.resourceId ? <Link className="hover:underline" href={`/tenants/${r.resourceId}`}>workspace</Link> : r.resourceType}
                  </TD>
                  <TD className="max-w-md truncate font-mono text-[11px] text-fg-subtle">{JSON.stringify(r.changes ?? r.metadata ?? {})}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
