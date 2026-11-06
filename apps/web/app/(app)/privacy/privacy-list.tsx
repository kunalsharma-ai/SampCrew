'use client';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, StatusPill, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useRunner } from '../recruitment/use-runner';
import { createPrivacyRequestAction } from './actions';
import { KIND, type PrivacyRequestRow } from './types';

export function PrivacyList({ requests, people }: { requests: PrivacyRequestRow[]; people: { id: string; name: string; status: string }[] }) {
  const router = useRouter();
  const { pending, notice, run } = useRunner();
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [kind, setKind] = useState<'access' | 'erasure'>('access');
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const valid = Boolean(employeeId) && source.trim().length >= 3;

  const submit = () =>
    run(async () => {
      const r = await createPrivacyRequestAction({ employeeId, kind, source: source.trim() });
      if (r.ok) {
        setOpen(false);
        router.push(`/privacy/${r.data!.id}`);
      } else setError(r.message);
      return r;
    });

  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader title="Requests" action={<Button size="sm" onClick={() => { setError(null); setOpen(true); }}><Plus className="size-3.5" /> Log a request</Button>} />
        {requests.length ? (
          <Table>
            <THead><tr><TH>Person</TH><TH>Request</TH><TH>Status</TH><TH>Due</TH><TH>Logged</TH></tr></THead>
            <TBody>
              {requests.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link className="font-medium text-accent hover:underline" href={`/privacy/${r.id}`}>{r.employeeName}</Link>
                    <div className="text-xs text-fg-muted">{r.employeeCode} · {r.employeeStatus}</div>
                  </TD>
                  <TD>{KIND[r.kind]}</TD>
                  <TD><StatusPill status={r.status} /></TD>
                  <TD className="whitespace-nowrap">{r.dueOn}{r.overdue && <Badge tone="danger" className="ml-2">Overdue</Badge>}</TD>
                  <TD className="text-fg-muted">{new Date(r.createdAt).toLocaleDateString()}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No privacy requests" description="Requests you log appear here with their due date." />}
      </Card>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Log a privacy request"
        description="Record who asked and how. You can prepare the export or erase the data from the request page."
        size="lg"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!valid} onClick={submit}>Log request</Button></>}
      >
        <div className="grid gap-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Person" required>
            {(p) => (
              <Select {...p} name="employeeId" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">Choose someone</option>
                {people.map((e) => <option key={e.id} value={e.id}>{e.name}{e.status === 'exited' ? ', has left' : ''}</option>)}
              </Select>
            )}
          </Field>
          <Field label="They asked for">
            {(p) => (
              <Select {...p} name="kind" value={kind} onChange={(e) => setKind(e.target.value as 'access' | 'erasure')}>
                <option value="access">A copy of their data</option>
                <option value="erasure">Their data to be erased</option>
              </Select>
            )}
          </Field>
          <Field label="How the request arrived" hint="For example: Email to hr@ on 3 March, identity checked against their ID" required>
            {(p) => <Input {...p} name="source" value={source} maxLength={300} onChange={(e) => setSource(e.target.value)} />}
          </Field>
          {kind === 'erasure' && <Alert tone="info">Erasure is possible only after the person&apos;s last working day. While someone works here, SampCrew needs their details to employ and pay them.</Alert>}
        </div>
      </Dialog>
    </div>
  );
}
