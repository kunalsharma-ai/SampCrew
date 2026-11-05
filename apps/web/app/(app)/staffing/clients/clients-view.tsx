'use client';
import { Alert, Button, Card, EmptyState, Table, TBody, TD, TH, THead, TR, buttonClass } from '@crew/ui';
import { Building2, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useCreateParam } from '@/lib/use-create-param';
import { archiveClientAction } from '../actions';
import { NewClientDialog } from '../bid-editor';
import type { Client } from '../types';

export function ClientsView({ clients, archived, canManage }: { clients: Client[]; archived: boolean; canManage: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useCreateParam('client');
  const [editing, setEditing] = useState<Client | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 text-[0.8125rem]" role="tablist" aria-label="Show">
          <Link role="tab" aria-selected={!archived} href="/staffing/clients" className={buttonClass(archived ? 'ghost' : 'secondary', 'sm')}>Active</Link>
          <Link role="tab" aria-selected={archived} href="/staffing/clients?archived=true" className={buttonClass(archived ? 'secondary' : 'ghost', 'sm')}>Archived</Link>
        </div>
        {canManage && !archived && <Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="size-4" /> New client</Button>}
      </div>
      <Card>
        {clients.length ? (
          <div className="overflow-x-auto">
            <Table>
              <THead><TR><TH>Client</TH><TH>Contact</TH><TH>Industry</TH><TH className="text-right">Bids</TH><TH className="text-right">Won</TH><TH /></TR></THead>
              <TBody>
                {clients.map((c) => (
                  <TR key={c.id}>
                    <TD><span className="block font-medium">{c.name}</span><span className="block text-xs text-fg-subtle">{c.legalName ?? ''}{c.legalName ? ' · ' : ''}{c.currency}</span></TD>
                    <TD><span className="block">{c.contactName ?? '—'}</span><span className="block text-xs text-fg-subtle">{c.contactEmail ?? ''}</span></TD>
                    <TD className="text-fg-muted">{c.industry ?? '—'}</TD>
                    <TD className="text-right tabular-nums"><Link href={`/staffing/bids?clientId=${c.id}`} className="text-accent hover:underline">{c.bidCount}</Link></TD>
                    <TD className="text-right tabular-nums">{c.wonCount}</TD>
                    <TD className="whitespace-nowrap text-right">
                      {canManage && !archived && (
                        <div className="flex justify-end gap-1">
                          <Link href={`/staffing/bids/new?mode=quick&clientId=${c.id}`} className={buttonClass('ghost', 'sm')}>New bid</Link>
                          <Button size="sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => { setEditing(c); setOpen(true); }}><Pencil className="size-3.5" /></Button>
                          <Button size="sm" variant="ghost" loading={pending} onClick={() => {
                            if (!confirm(`Archive ${c.name}? Their bids are kept.`)) return;
                            start(async () => { const r = await archiveClientAction(c.id); setMsg(r.ok ? { tone: 'success', text: `${c.name} archived` } : { tone: 'danger', text: r.message }); router.refresh(); });
                          }}>Archive</Button>
                        </div>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        ) : (
          <EmptyState icon={<Building2 className="size-5" />} title={archived ? 'No archived clients' : 'No clients yet'} description={archived ? undefined : 'Add the companies you staff for. You can also add a client while making a bid.'} />
        )}
      </Card>
      <NewClientDialog
        open={open}
        client={editing}
        onClose={() => { setOpen(false); setEditing(null); }}
        onCreated={(c) => { setMsg({ tone: 'success', text: editing ? `${c.name} saved` : `${c.name} added` }); router.refresh(); }}
      />
    </div>
  );
}
