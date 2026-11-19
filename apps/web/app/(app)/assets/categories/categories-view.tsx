'use client';
import { Alert, Badge, Button, Card, CardBody, Dialog, Field, Input, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { Plus } from 'lucide-react';
import { useState, useTransition } from 'react';
import { saveCategoryAction } from '../actions';
import type { Category } from '../types';

export function CategoriesView({ categories }: { categories: Category[] }) {
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const archive = (c: Category) => start(async () => { const r = await saveCategoryAction(c.id, { archived: !c.archived }); setFlash({ tone: r.ok ? 'success' : 'danger', text: r.ok ? (c.archived ? `${c.name} restored.` : `${c.name} archived. Its assets are kept.`) : r.message }); });
  return (
    <div className="grid gap-6">
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
      <Card>
        <CardBody className="flex justify-end"><Button onClick={() => setEditing('new')}><Plus className="size-4" aria-hidden /> Add category</Button></CardBody>
        <Table aria-label="Asset categories">
          <THead><tr><TH>Category</TH><TH>Code</TH><TH>Assets</TH><TH /></tr></THead>
          <TBody>
            {categories.map((c) => (
              <TR key={c.id}>
                <TD className="font-medium">{c.name} {c.archived && <Badge>Archived</Badge>}{c.description && <div className="text-xs font-normal text-fg-muted">{c.description}</div>}</TD>
                <TD className="font-mono">{c.code}</TD>
                <TD>{c.assetCount}</TD>
                <TD className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>Edit</Button>
                  <Button size="sm" variant="ghost" loading={pending} onClick={() => archive(c)}>{c.archived ? 'Restore' : 'Archive'}</Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      {editing && <CategoryDialog c={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { setFlash({ tone: 'success', text: m }); setEditing(null); }} />}
    </div>
  );
}

function CategoryDialog({ c, onClose, onSaved }: { c: Category | null; onClose: () => void; onSaved: (m: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title={c ? `Edit ${c.name}` : 'Add an asset category'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="category-form" loading={pending}>Save</Button></>}>
      <form id="category-form" className="grid gap-4" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => {
          const r = await saveCategoryAction(c?.id ?? null, { name: String(f.get('name') ?? ''), code: String(f.get('code') ?? ''), description: String(f.get('description') ?? '') });
          if (r.ok) onSaved(r.message ?? 'Saved.'); else { setError(r.message); setFe(r.fieldErrors ?? {}); }
        });
      }}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Name" required error={fe.name}>{(p) => <Input {...p} name="name" required minLength={2} maxLength={80} defaultValue={c?.name} />}</Field>
        <Field label="Code" required hint="2 to 8 letters or numbers; new assets are numbered CODE-0001" error={fe.code}>{(p) => <Input {...p} name="code" required pattern="[A-Za-z0-9]{2,8}" defaultValue={c?.code} className="uppercase" />}</Field>
        <Field label="Description" error={fe.description}>{(p) => <Textarea {...p} name="description" rows={2} maxLength={300} defaultValue={c?.description ?? ''} />}</Field>
      </form>
    </Dialog>
  );
}
