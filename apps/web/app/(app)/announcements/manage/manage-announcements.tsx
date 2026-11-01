'use client';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Department, LegalEntity, Location } from '@/lib/types';
import { useRunner } from '../../recruitment/use-runner';
import { archiveAnnouncementAction, deleteAnnouncementAction, publishAnnouncementAction, saveAnnouncementAction } from '../../helpdesk/actions';
import { audienceLabel, dateTime } from '../../helpdesk/labels';
import type { Announcement } from '../../helpdesk/types';

const STATE_TONE = { draft: 'neutral', published: 'success', archived: 'neutral' } as const;
const STATE = { draft: 'Draft', published: 'Published', archived: 'Archived' };

export function ManageAnnouncements({ items, entities, departments, locations }: { items: Announcement[]; entities: LegalEntity[]; departments: Department[]; locations: Location[] }) {
  const { pending, notice, run } = useRunner();
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null);
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader title="Announcements" action={<Button size="sm" onClick={() => setEditing('new')}>New announcement</Button>} />
        <Table>
          <THead><tr><TH>Title</TH><TH>Audience</TH><TH>State</TH><TH>Read</TH><TH>Acknowledged</TH><TH /></tr></THead>
          <TBody>
            {items.length === 0 && <TR><TD colSpan={6} className="text-fg-muted">Nothing yet.</TD></TR>}
            {items.map((a) => (
              <TR key={a.id}>
                <TD>
                  <Link className="font-medium text-accent hover:underline" href={`/announcements/manage/${a.id}`}>{a.title}</Link>
                  {a.pinned && <Badge className="ml-2">Pinned</Badge>}
                  <div className="text-xs text-fg-muted">{a.publishedAt ? `Published ${dateTime(a.publishedAt)}` : `Created ${dateTime(a.createdAt)}`}{a.expiresOn ? ` · until ${a.expiresOn}` : ''}</div>
                </TD>
                <TD className="text-fg-muted">{audienceLabel(a)}</TD>
                <TD><Badge tone={STATE_TONE[a.status]}>{STATE[a.status]}</Badge></TD>
                <TD className="tabular-nums">{a.status === 'draft' ? '–' : `${a.readCount} of ${a.audienceSize}`}</TD>
                <TD className="tabular-nums">{a.requiresAck ? (a.status === 'draft' ? 'Asked' : `${a.ackCount} of ${a.audienceSize}`) : 'Not asked'}</TD>
                <TD className="whitespace-nowrap text-right">
                  {a.status !== 'archived' && <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>{a.status === 'draft' ? 'Edit' : 'Pin or expiry'}</Button>}
                  {a.status === 'draft' && <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm(`Publish "${a.title}" and notify ${audienceLabel(a).toLowerCase()}? The text cannot change afterwards.`) && run(() => publishAnnouncementAction(a.id))}>Publish</Button>}
                  {a.status === 'draft' && <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Delete this draft?') && run(() => deleteAnnouncementAction(a.id))}>Delete</Button>}
                  {a.status === 'published' && <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Take it off the feed? Read receipts are kept.') && run(() => archiveAnnouncementAction(a.id))}>Archive</Button>}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      {editing && <AnnouncementDialog key={editing === 'new' ? 'new' : editing.id} a={editing === 'new' ? null : editing} entities={entities} departments={departments} locations={locations} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AnnouncementDialog({ a, entities, departments, locations, onClose }: { a: Announcement | null; entities: LegalEntity[]; departments: Department[]; locations: Location[]; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [requiresAck, setRequiresAck] = useState(a?.requiresAck ?? false);
  const [pinned, setPinned] = useState(a?.pinned ?? false);
  const frozen = a !== null && a.status !== 'draft';
  return (
    <Dialog open onClose={onClose} title={a ? (frozen ? 'Pinning and expiry' : 'Edit draft') : 'New announcement'} description={frozen ? 'The announcement is published, so only pinning and the expiry date can change.' : undefined} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="announcement-form" loading={pending}>{a ? 'Save' : 'Save draft'}</Button></>}>
      <form id="announcement-form" className="grid grid-cols-2 gap-4" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const v = (k: string) => (String(f.get(k) ?? '') || null);
        const body = frozen
          ? { title: a.title, body: a.body, legalEntityId: a.legalEntityId, departmentId: a.departmentId, locationId: a.locationId, requiresAck: a.requiresAck, pinned, expiresOn: v('expiresOn') }
          : { title: f.get('title'), body: f.get('body'), legalEntityId: v('legalEntityId'), departmentId: v('departmentId'), locationId: v('locationId'), requiresAck, pinned, expiresOn: v('expiresOn') };
        setError(null);
        setFe({});
        start(async () => {
          const r = await saveAnnouncementAction(a?.id ?? null, body);
          if (r.ok) { onClose(); router.refresh(); } else { setError(r.message); setFe(r.fieldErrors ?? {}); }
        });
      }}>
        {error && <Alert tone="danger" className="col-span-2">{error}</Alert>}
        <Field label="Title" required error={fe.title} className="col-span-2">{(p) => <Input {...p} name="title" required minLength={3} maxLength={200} defaultValue={a?.title} disabled={frozen} />}</Field>
        <Field label="Message" required error={fe.body} className="col-span-2">{(p) => <Textarea {...p} name="body" rows={8} required maxLength={10000} defaultValue={a?.body} disabled={frozen} />}</Field>
        <p className="col-span-2 -mb-2 text-[13px] font-medium">Who is it for? <span className="font-normal text-fg-muted">Leave all three empty for everyone.</span></p>
        <Field label="Legal entity" error={fe.legalEntityId}>{(p) => <Select {...p} name="legalEntityId" defaultValue={a?.legalEntityId ?? ''} disabled={frozen}><option value="">Any</option>{entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        <Field label="Department" hint="Includes its sub-departments" error={fe.departmentId}>{(p) => <Select {...p} name="departmentId" defaultValue={a?.departmentId ?? ''} disabled={frozen}><option value="">Any</option>{departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        <Field label="Location" error={fe.locationId}>{(p) => <Select {...p} name="locationId" defaultValue={a?.locationId ?? ''} disabled={frozen}><option value="">Any</option>{locations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        <Field label="Take off the feed after" hint="Optional" error={fe.expiresOn}>{(p) => <Input {...p} name="expiresOn" type="date" defaultValue={a?.expiresOn ?? ''} />}</Field>
        <div className="col-span-2 grid gap-2">
          <Checkbox label="Ask people to acknowledge it" description="Each person confirms they have read it; you see who has and who has not." checked={requiresAck} disabled={frozen} onChange={(e) => setRequiresAck(e.target.checked)} />
          <Checkbox label="Pin to the top of the feed" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
        </div>
      </form>
    </Dialog>
  );
}
