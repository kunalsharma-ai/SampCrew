'use client';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { addCategoryAction, addTypeAction } from './actions';
import type { Catalogue } from './types';

const keyOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'd$1').slice(0, 60);

/** Document categories and types: the built-in list plus the company's own (Super Workspace adds categories). */
export function CatalogueManager({ catalogue, canAddType }: { catalogue: Catalogue; canAddType: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [catName, setCatName] = useState('');
  const [typeName, setTypeName] = useState('');
  const [typeCat, setTypeCat] = useState(catalogue.groups[0]?.key ?? 'other');
  const [sensitive, setSensitive] = useState(false);
  const [owners, setOwners] = useState<('employee' | 'hr_workspace')[]>(['employee']);

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, reset: () => void) => start(async () => {
    const r = await fn();
    setMsg({ ok: r.ok, text: r.message ?? (r.ok ? 'Saved.' : 'Could not save.') });
    if (r.ok) {
      reset();
      router.refresh();
    }
  });

  return (
    <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
      <Card>
        <CardHeader title="Document types" description="What people can be asked for. Sensitive types hide file names from anyone not allowed to download them." />
        <Table aria-label="Document types">
          <THead><tr><TH>Type</TH><TH>Category</TH><TH>Asked of</TH><TH /></tr></THead>
          <TBody>
            {catalogue.types.map((t) => (
              <TR key={t.key}>
                <TD className="font-medium">{t.name}</TD>
                <TD className="text-fg-muted">{catalogue.groups.find((g) => g.key === t.category)?.name ?? t.category}</TD>
                <TD className="text-fg-muted">{t.owners.map((o) => (o === 'employee' ? 'Employees' : 'HR Workspaces')).join(', ')}</TD>
                <TD>{t.sensitive && <Badge tone="warning">Sensitive</Badge>} {!t.builtIn && <Badge tone="accent">Custom</Badge>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <div className="grid content-start gap-5">
        {msg && <Alert tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Alert>}
        {canAddType && (
          <Card>
            <CardHeader title="Add a document type" description="A custom type appears in every request form straight away." />
            <form className="grid gap-3 px-5 pb-5" onSubmit={(e) => { e.preventDefault(); run(() => addTypeAction({ key: keyOf(typeName), name: typeName.trim(), category: typeCat, sensitive, owners }), () => { setTypeName(''); setSensitive(false); }); }}>
              <Field label="Name" required>{(p) => <Input {...p} value={typeName} onChange={(e) => setTypeName(e.target.value)} maxLength={120} placeholder="For example: Vaccination certificate" />}</Field>
              <Field label="Category">{(p) => (
                <Select {...p} value={typeCat} onChange={(e) => setTypeCat(e.target.value)}>
                  {catalogue.groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
                </Select>
              )}</Field>
              <Checkbox label="Asked of employees" checked={owners.includes('employee')} onChange={(e) => setOwners((o) => (e.target.checked ? [...new Set([...o, 'employee' as const])] : o.filter((x) => x !== 'employee')))} />
              <Checkbox label="Asked of HR Workspaces" checked={owners.includes('hr_workspace')} onChange={(e) => setOwners((o) => (e.target.checked ? [...new Set([...o, 'hr_workspace' as const])] : o.filter((x) => x !== 'hr_workspace')))} />
              <Checkbox label="Sensitive" description="Like Aadhaar or bank details: file names are masked for people who cannot download." checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
              <div><Button type="submit" loading={pending} disabled={typeName.trim().length < 2 || !owners.length}>Add type</Button></div>
            </form>
          </Card>
        )}
        <Card>
          <CardHeader title="Document categories" description={catalogue.canManage ? 'Group document types. Super Workspace can add categories.' : 'How document types are grouped. Super Workspace manages the list.'} />
          <ul className="grid gap-2 px-5 pb-4 text-sm">
            {catalogue.groups.map((g) => (
              <li key={g.key} className="flex items-start justify-between gap-3">
                <span><span className="font-medium">{g.name}</span>{g.description && <span className="block text-xs text-fg-muted">{g.description}</span>}</span>
                {!g.builtIn && <Badge tone="accent">Custom</Badge>}
              </li>
            ))}
          </ul>
          {catalogue.canManage && (
            <form className="flex flex-wrap items-end gap-2 border-t border-border px-5 py-4" onSubmit={(e) => { e.preventDefault(); run(() => addCategoryAction({ key: keyOf(catName), name: catName.trim() }), () => setCatName('')); }}>
              <Field label="New category" className="min-w-0 flex-1">{(p) => <Input {...p} value={catName} onChange={(e) => setCatName(e.target.value)} maxLength={80} placeholder="For example: Medical" />}</Field>
              <Button type="submit" variant="secondary" loading={pending} disabled={catName.trim().length < 2}>Add category</Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
