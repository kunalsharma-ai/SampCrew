'use client';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input } from '@crew/ui';
import { Pencil, Plus, Trash2, Users, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { archiveGroupAction, saveGroupAction } from '../actions';
import { PeoplePicker } from '../people-picker';
import type { Group } from '../types';

type Editing = { id: string | null; name: string; description: string; members: { membershipId: string; name: string | null }[] };

/** HR's own lists of people, used as an audience for emails and announcements. */
export function GroupsView({ groups }: { groups: Group[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = () => start(async () => {
    if (!editing) return;
    const r = await saveGroupAction(editing.id, { name: editing.name.trim(), description: editing.description.trim(), membershipIds: editing.members.map((m) => m.membershipId) });
    if (r.ok) { setEditing(null); setMsg({ tone: 'success', text: `${editing.name.trim()} saved.` }); router.refresh(); } else setMsg({ tone: 'danger', text: r.message });
  });
  return (
    <div className="grid gap-3">
      <div className="flex justify-end"><Button size="sm" onClick={() => { setMsg(null); setEditing({ id: null, name: '', description: '', members: [] }); }}><Plus className="size-3.5" /> New group</Button></div>
      {msg && !editing && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {groups.length === 0 ? (
        <Card><EmptyState icon={<Users className="size-5" />} title="No groups yet" description="Make a list of people, for example night-shift leads or first aiders, and send emails or announcements to it." /></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="group-list">
          {groups.map((g) => (
            <Card key={g.id} className="p-4" data-testid="group-card">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{g.name}</div>
                  {g.description && <p className="text-xs text-fg-muted">{g.description}</p>}
                </div>
                <div className="flex shrink-0">
                  <button className="rounded p-1.5 text-fg-subtle hover:text-fg" aria-label={`Edit ${g.name}`} onClick={() => { setMsg(null); setEditing({ id: g.id, name: g.name, description: g.description, members: g.members }); }}><Pencil className="size-4" /></button>
                  <button className="rounded p-1.5 text-fg-subtle hover:text-danger" aria-label={`Remove ${g.name}`} onClick={() => start(async () => { const r = await archiveGroupAction(g.id); setMsg(r.ok ? { tone: 'success', text: `${g.name} removed.` } : { tone: 'danger', text: r.message }); router.refresh(); })}><Trash2 className="size-4" /></button>
                </div>
              </div>
              <p className="mt-2 text-xs text-fg-muted">{g.members.length} {g.members.length === 1 ? 'person' : 'people'}: {g.members.slice(0, 5).map((m) => m.name ?? 'Unnamed').join(', ')}{g.members.length > 5 ? ' and others' : ''}</p>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit group' : 'New group'} footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={pending} disabled={!editing || editing.name.trim().length < 2 || !editing.members.length} onClick={save}>Save group</Button></>}>
        {editing && (
          <div className="grid gap-3">
            <Field label="Name" required>{(p) => <Input {...p} value={editing.name} maxLength={80} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />}</Field>
            <Field label="Description">{(p) => <Input {...p} value={editing.description} maxLength={300} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />}</Field>
            <div className="text-xs font-medium">People ({editing.members.length})</div>
            {editing.members.length > 0 && <div className="flex flex-wrap gap-1">{editing.members.map((m) => <Badge key={m.membershipId}>{m.name ?? 'Unnamed'} <button aria-label={`Remove ${m.name}`} onClick={() => setEditing({ ...editing, members: editing.members.filter((x) => x.membershipId !== m.membershipId) })}><X className="size-3" /></button></Badge>)}</div>}
            <PeoplePicker selected={editing.members.map((m) => m.membershipId)} onToggle={(p) => setEditing({ ...editing, members: editing.members.some((m) => m.membershipId === p.membershipId) ? editing.members.filter((m) => m.membershipId !== p.membershipId) : [...editing.members, { membershipId: p.membershipId, name: p.name }] })} />
            {msg?.tone === 'danger' && <Alert tone="danger">{msg.text}</Alert>}
          </div>
        )}
      </Dialog>
    </div>
  );
}
