'use client';
import type { HierarchyMemberRow } from '@crew/contracts';
import { Alert, Button, Card, CardBody, CardHeader, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { ArrowRightLeft, Search, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { assignToHrWorkspaceAction } from '../actions';

export function CentralView({ rows, query, spaces, canTransfer }: { rows: HierarchyMemberRow[]; query: string; spaces: { id: string; name: string }[]; canTransfer: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState(query);
  const [chosen, setChosen] = useState<string[]>([]);
  const [moving, setMoving] = useState(false);
  const all = rows.length > 0 && chosen.length === rows.length;
  return (
    <Card>
      <CardHeader
        title="People in the central group"
        description="Tick people to move them into an HR Workspace. Their records and history go with them, and they then get the modules that HR Workspace holds."
        action={canTransfer && spaces.length > 0 ? <Button disabled={!chosen.length} onClick={() => setMoving(true)}><ArrowRightLeft className="size-4" aria-hidden />Move {chosen.length || ''} to an HR Workspace</Button> : undefined}
      />
      <CardBody>
        <form className="flex max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); router.push(`/hr-workspaces/central${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`); }}>
          <Input aria-label="Search people" placeholder="Name, code or email" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" variant="secondary"><Search className="size-4" aria-hidden />Search</Button>
        </form>
        {canTransfer && spaces.length === 0 && <p className="mt-3 text-[0.8125rem] text-fg-muted">Create an HR Workspace first to move people into it.</p>}
      </CardBody>
      {rows.length === 0 ? (
        <EmptyState icon={<Users className="size-5" />} title={query ? 'Nobody matches' : 'Nobody is in the central group'} description="Everyone belongs to an HR Workspace." />
      ) : (
        <Table aria-label="Central group">
          <THead>
            <tr>
              {canTransfer && <TH className="w-10"><input type="checkbox" aria-label="Choose everyone" className="size-4 accent-[var(--accent)]" checked={all} onChange={(e) => setChosen(e.target.checked ? rows.map((r) => r.employeeId) : [])} /></TH>}
              <TH>Person</TH><TH>Department</TH><TH>Status</TH><TH>Modules</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.employeeId}>
                {canTransfer && <TD><input type="checkbox" aria-label={`Choose ${r.name}`} className="size-4 accent-[var(--accent)]" checked={chosen.includes(r.employeeId)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, r.employeeId] : c.filter((x) => x !== r.employeeId)))} /></TD>}
                <TD><Link href={`/employees/${r.employeeId}`} className="font-medium hover:underline">{r.name}</Link><div className="text-xs text-fg-muted">{r.code}{r.email ? ` · ${r.email}` : ''}</div></TD>
                <TD className="text-fg-muted">{r.department ?? '—'}</TD>
                <TD className="text-fg-muted">{r.status.replace(/_/g, ' ')}</TD>
                <TD>{r.modules.length}{r.withheld.length > 0 && <span className="ml-2 text-xs text-fg-muted">{r.withheld.length} held back</span>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {moving && <MoveMany ids={chosen} spaces={spaces} onClose={() => setMoving(false)} onDone={() => { setChosen([]); setMoving(false); router.refresh(); }} />}
    </Card>
  );
}

function MoveMany({ ids, spaces, onClose, onDone }: { ids: string[]; spaces: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState(spaces[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = () => start(async () => {
    if (reason.trim().length < 3) { setError('Give a reason of at least 3 characters'); return; }
    const r = await assignToHrWorkspaceAction(to, ids, reason.trim());
    if (!r.ok) { setError(r.message); return; }
    onDone();
  });
  return (
    <Dialog open onClose={onClose} size="sm" title={`Move ${ids.length} ${ids.length === 1 ? 'person' : 'people'}`} description="Into the HR Workspace you choose. You can move them back at any time."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={go} loading={pending}>Move</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="HR Workspace">{(f) => <Select {...f} value={to} onChange={(e) => setTo(e.target.value)}>{spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        <Field label="Reason" required>{(f) => <Input {...f} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Joined the Pune branch" />}</Field>
      </div>
    </Dialog>
  );
}
