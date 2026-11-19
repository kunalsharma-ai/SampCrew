'use client';
import { ASSET_CONDITION_LABEL } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, Field, Input, Textarea } from '@crew/ui';
import { Laptop } from 'lucide-react';
import { useState, useTransition } from 'react';
import { acknowledgeAction } from '../actions';
import { dateTime, day } from '../labels';
import type { MyAsset } from '../types';

export function MineView({ employeeName, items }: { employeeName: string | null; items: MyAsset[] }) {
  const held = items.filter((x) => x.status === 'active');
  const past = items.filter((x) => x.status !== 'active');
  if (!employeeName) return <Alert tone="info">Your login is not linked to an employee record, so no assets can be assigned to you.</Alert>;
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader title="Assets I hold" description={held.length ? `${held.length} item${held.length === 1 ? '' : 's'}` : undefined} />
        <CardBody className="grid gap-4">
          {held.length ? held.map((x) => <HeldAsset key={x.assignmentId} x={x} employeeName={employeeName} />) : <EmptyState icon={<Laptop className="size-5" />} title="Nothing assigned to you" description="When HR hands you a laptop, phone or ID card it appears here." />}
        </CardBody>
      </Card>
      {past.length > 0 && (
        <Card>
          <CardHeader title="Returned" />
          <CardBody className="grid gap-2 text-[0.8125rem]">
            {past.map((x) => <div key={x.assignmentId}><span className="font-mono">{x.assetCode}</span> {x.name} · {day(x.assignedOn)} to {day(x.returnedOn)}</div>)}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function HeldAsset({ x, employeeName }: { x: MyAsset; employeeName: string }) {
  const [done, setDone] = useState<string | null>(x.acknowledgedAt);
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">{x.assetCode}</span><span className="font-semibold">{x.name}</span>
        {done ? <Badge tone="success">Acknowledged</Badge> : x.needsAcknowledgement ? <Badge tone="warning">Please acknowledge</Badge> : null}
      </div>
      <div className="text-[0.8125rem] text-fg-muted">
        {[x.category, x.brand, x.model, x.serialNumber ? `serial ${x.serialNumber}` : null].filter(Boolean).join(' · ')}. Given to you on {day(x.assignedOn)} in {(ASSET_CONDITION_LABEL[x.condition as keyof typeof ASSET_CONDITION_LABEL] ?? x.condition).toLowerCase()} condition{x.expectedReturnOn ? `, to return by ${day(x.expectedReturnOn)}` : ''}.
        {x.notes ? ` ${x.notes}` : ''}
      </div>
      {done ? <p className="text-xs text-success">You acknowledged it on {dateTime(done)}.</p> : x.needsAcknowledgement && (
        <form className="grid gap-3" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setError(null);
          start(async () => {
            const r = await acknowledgeAction(x.assignmentId, { fullName: String(f.get('fullName') ?? ''), accept, comment: String(f.get('comment') ?? '') });
            if (r.ok) setDone(new Date().toISOString()); else { setError(r.message); setFe(r.fieldErrors ?? {}); }
          });
        }}>
          {error && <Alert tone="danger">{error}</Alert>}
          <blockquote className="rounded-md bg-bg-subtle px-3 py-2 text-[0.8125rem]">{x.acceptanceText}</blockquote>
          <Checkbox label="I received it and agree to the above" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type your full name" required hint={`As on your profile: ${employeeName}`} error={fe.fullName}>{(p) => <Input {...p} name="fullName" required minLength={2} maxLength={160} autoComplete="name" />}</Field>
            <Field label="Comment" hint="For example, a scratch you noticed">{(p) => <Textarea {...p} name="comment" rows={1} maxLength={1000} />}</Field>
          </div>
          <div><Button type="submit" loading={pending} disabled={!accept}>Acknowledge</Button></div>
        </form>
      )}
    </div>
  );
}
