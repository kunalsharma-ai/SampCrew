'use client';
import { Alert, Badge, Button, Card, EmptyState, Input, Select, Table, TBody, TD, TH, THead, TR, buttonClass } from '@crew/ui';
import { ChevronDown, ChevronRight, ScrollText, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useState, useTransition } from 'react';
import type { Page } from '@/lib/types';
import { verifyAuditAction } from '../actions';

export interface AuditEvent {
  id: string;
  seq: number;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  changes: unknown;
  metadata: unknown;
  ip: string | null;
  requestId: string | null;
  createdAt: string;
  hash: string;
}

const RESOURCE_TYPES = ['tenant', 'membership', 'invitation', 'role', 'legal_entity', 'business_unit', 'location', 'department', 'subscription', 'support_access_grant', 'user'];

export function AuditView({ page, query, hasCursor, canExport }: { page: Page<AuditEvent>; query: { q: string; action: string; resourceType: string }; hasCursor: boolean; canExport: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [verify, setVerify] = useState<{ checked: number; intact: boolean; firstBrokenSeq: number | null; verifiedAt: string } | { error: string } | null>(null);

  const href = (extra: Record<string, string>) => {
    const p = new URLSearchParams(Object.entries({ ...query, ...extra }).filter(([, v]) => v));
    return `/settings/audit${p.size ? `?${p}` : ''}`;
  };

  return (
    <div className="grid gap-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-3 text-[0.8125rem]">
          <ShieldCheck className="size-5 text-accent" />
          <span>Check that no entry has been altered or removed since it was written.</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {canExport
            ? <a className={buttonClass('secondary', 'sm')} href={`/audit-export?${new URLSearchParams(Object.entries(query).filter(([, v]) => v))}`} download data-testid="audit-export">Download CSV</a>
            : <span className="self-center text-xs text-fg-subtle">CSV export is in plans with Audit log export</span>}
          <Button variant="secondary" size="sm" loading={pending} onClick={() => start(async () => {
            const r = await verifyAuditAction();
            setVerify(r.ok ? r.data! : { error: r.message });
          })}>Verify integrity</Button>
        </div>
        {verify && (
          <div className="w-full">
            {'error' in verify ? <Alert tone="danger">{verify.error}</Alert>
              : verify.intact ? <Alert tone="success" title="Chain intact">{verify.checked} entries checked at {new Date(verify.verifiedAt).toLocaleString()}. No tampering detected.</Alert>
              : <Alert tone="danger" title="Chain broken">Entry #{verify.firstBrokenSeq} does not match its recorded hash. Contact SAMPLEDGE support and preserve your database backups.</Alert>}
          </div>
        )}
      </Card>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          router.push(href({ q: String(f.get('q') ?? ''), action: String(f.get('action') ?? ''), resourceType: String(f.get('resourceType') ?? ''), cursor: '' }));
        }}
      >
        <Input name="q" defaultValue={query.q} placeholder="Search actor or action" className="w-64" aria-label="Search" />
        <Input name="action" defaultValue={query.action} placeholder="Action prefix, e.g. member." className="w-56" aria-label="Action prefix" />
        <Select name="resourceType" defaultValue={query.resourceType} aria-label="Resource type" className="w-48">
          <option value="">All resources</option>
          {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{t.replaceAll('_', ' ')}</option>)}
        </Select>
        <Button type="submit" variant="secondary">Filter</Button>
        {(query.q || query.action || query.resourceType) && <Link href="/settings/audit" className={buttonClass('ghost')}>Clear</Link>}
      </form>

      <Card>
        {page.items.length === 0 ? (
          <EmptyState icon={<ScrollText className="size-6" />} title="No matching entries" description="Try a broader filter." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="w-8" />
                <TH>#</TH>
                <TH>When</TH>
                <TH>Actor</TH>
                <TH>Action</TH>
                <TH>Resource</TH>
                <TH>IP</TH>
              </TR>
            </THead>
            <TBody>
              {page.items.map((e) => (
                <Fragment key={e.id}>
                  <TR className="cursor-pointer" onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <TD>{open === e.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</TD>
                    <TD className="tabular text-fg-subtle">{e.seq}</TD>
                    <TD className="whitespace-nowrap">{new Date(e.createdAt).toLocaleString()}</TD>
                    <TD>
                      {e.actorLabel ?? 'System'}
                      {e.actorType !== 'user' && <Badge tone={e.actorType === 'platform' ? 'warning' : 'neutral'} className="ml-2">{e.actorType}</Badge>}
                    </TD>
                    <TD><code className="text-xs">{e.action}</code></TD>
                    <TD className="text-fg-muted">{e.resourceType.replaceAll('_', ' ')}</TD>
                    <TD className="text-fg-subtle tabular">{e.ip ?? '—'}</TD>
                  </TR>
                  {open === e.id && (
                    <tr>
                      <td colSpan={7} className="bg-bg-subtle px-5 py-3">
                        <dl className="grid gap-2 text-xs">
                          <div><dt className="inline font-medium">Resource ID: </dt><dd className="inline font-mono">{e.resourceId ?? '—'}</dd></div>
                          <div><dt className="inline font-medium">Request ID: </dt><dd className="inline font-mono">{e.requestId ?? '—'}</dd></div>
                          <div><dt className="inline font-medium">Hash: </dt><dd className="inline break-all font-mono">{e.hash}</dd></div>
                          {e.changes != null && (
                            <div>
                              <dt className="mb-1 font-medium">Changes</dt>
                              <dd><pre className="max-h-64 overflow-auto rounded-md border border-border bg-bg p-3 font-mono">{JSON.stringify(e.changes, null, 2)}</pre></dd>
                            </div>
                          )}
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <div className="flex justify-end gap-2">
        {hasCursor && <Link href={href({ cursor: '' })} className={buttonClass('ghost', 'sm')}>Newest</Link>}
        {page.nextCursor && <Link href={href({ cursor: page.nextCursor })} className={buttonClass('secondary', 'sm')}>Older entries</Link>}
      </div>
    </div>
  );
}
