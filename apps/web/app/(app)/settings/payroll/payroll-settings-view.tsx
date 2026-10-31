'use client';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import type { LegalEntity } from '@/lib/types';
import { useRunner } from '../../recruitment/use-runner';
import { archiveCategoryAction, archiveComponentAction, archiveStructureAction, saveCategoryAction, saveComponentAction, saveStructureAction } from '../../payroll/actions';
import { amount, CALC } from '../../payroll/labels';
import type { Component, ExpenseCategory, StatutoryResponse, Structure } from '../../payroll/types';
import { StatutoryEditor } from './statutory-editor';

const YES_NO = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
const yn = (b: boolean) => (b ? 'yes' : 'no');

export function PayrollSettingsView({ statutory, components, structures, categories, entities }: {
  statutory: StatutoryResponse; components: Component[]; structures: Structure[]; categories: ExpenseCategory[]; entities: LegalEntity[];
}) {
  const { pending, notice, run } = useRunner();
  const [component, setComponent] = useState<Component | 'new' | null>(null);
  const [structure, setStructure] = useState<Structure | 'new' | null>(null);
  const [category, setCategory] = useState<ExpenseCategory | 'new' | null>(null);
  const active = components.filter((c) => !c.archivedAt);
  const editingComponent = component && component !== 'new' ? component : null;

  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <StatutoryEditor statutory={statutory} entities={entities} />

      <Card>
        <CardHeader title="Pay components" description="Earnings and deductions that salary structures are built from." action={<Button size="sm" variant="secondary" onClick={() => setComponent('new')}><Plus className="size-3.5" /> Add component</Button>} />
        <Table>
          <THead><tr><TH>Code</TH><TH>Name</TH><TH>Type</TH><TH>Taxable</TH><TH>By paid days</TH><TH>PF wages</TH><TH /></tr></THead>
          <TBody>
            {active.map((c) => (
              <TR key={c.id}>
                <TD className="font-mono text-[13px]">{c.code}</TD>
                <TD>{c.name}{c.isBasic && <Badge tone="accent" className="ml-2">Basic</Badge>}</TD>
                <TD>{c.kind === 'earning' ? 'Earning' : 'Deduction'}</TD>
                <TD>{c.kind === 'earning' ? (c.taxable ? 'Yes' : 'No') : '–'}</TD>
                <TD>{c.kind === 'earning' ? (c.prorate ? 'Yes' : 'No') : '–'}</TD>
                <TD>{c.pfWage ? 'Yes' : 'No'}</TD>
                <TD className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setComponent(c)}>Edit</Button>
                  {!c.isBasic && !c.inUse && <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm(`Archive ${c.name}?`) && run(() => archiveComponentAction(c.id))}>Archive</Button>}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Salary structures" description="How an annual CTC splits into components. Editing a structure affects salaries saved afterwards only." action={<Button size="sm" variant="secondary" onClick={() => setStructure('new')}><Plus className="size-3.5" /> New structure</Button>} />
        <Table>
          <THead><tr><TH>Structure</TH><TH>Components</TH><TH className="text-right">Employees</TH><TH /></tr></THead>
          <TBody>
            {structures.filter((s) => !s.archivedAt).map((s) => (
              <TR key={s.id}>
                <TD><div className="font-medium">{s.name}</div><div className="text-xs text-fg-muted">{s.description}</div></TD>
                <TD className="text-[13px]">{s.lines.map((l) => `${l.name}: ${l.calc === 'balance' ? 'balance' : l.calc === 'fixed' ? `${amount(l.value.replace(/(\.\d\d)\d+$/, '$1'))} a year` : `${Number(l.value)}${l.calc === 'percent_of_ctc' ? '% of CTC' : '% of Basic'}`}`).join(' · ')}</TD>
                <TD className="text-right tabular-nums">{s.employeeCount}</TD>
                <TD className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setStructure(s)}>Edit</Button>
                  <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm(`Archive ${s.name}? Existing salaries keep it.`) && run(() => archiveStructureAction(s.id))}>Archive</Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Expense categories" action={<Button size="sm" variant="secondary" onClick={() => setCategory('new')}><Plus className="size-3.5" /> Add category</Button>} />
        <Table>
          <THead><tr><TH>Category</TH><TH>Receipt</TH><TH className="text-right">Limit per claim</TH><TH /></tr></THead>
          <TBody>
            {categories.map((c) => (
              <TR key={c.id}>
                <TD className="font-medium">{c.name}</TD>
                <TD>{c.receiptRequired ? 'Required' : 'Optional'}</TD>
                <TD className="text-right tabular-nums">{c.maxPerClaim ? amount(c.maxPerClaim) : 'No limit'}</TD>
                <TD className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setCategory(c)}>Edit</Button>
                  <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm(`Archive ${c.name}?`) && run(() => archiveCategoryAction(c.id))}>Archive</Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <ResourceDialog
        key={editingComponent?.id ?? 'new-component'}
        open={component !== null}
        onClose={() => setComponent(null)}
        title={editingComponent ? `Edit ${editingComponent.name}` : 'Add a pay component'}
        submitLabel="Save"
        initial={editingComponent ? { ...editingComponent, taxable: yn(editingComponent.taxable), prorate: yn(editingComponent.prorate), pfWage: yn(editingComponent.pfWage) } : { kind: 'earning', taxable: 'yes', prorate: 'yes', pfWage: 'no' }}
        fields={[
          { name: 'code', label: 'Code', required: true, half: true, placeholder: 'LTA', hint: editingComponent ? 'Cannot change' : 'Capital letters, digits, _' },
          { name: 'name', label: 'Name', required: true, half: true },
          { name: 'kind', label: 'Type', type: 'select', required: true, half: true, options: [{ value: 'earning', label: 'Earning' }, { value: 'deduction', label: 'Deduction' }] },
          { name: 'taxable', label: 'Taxable', type: 'select', required: true, half: true, options: YES_NO },
          { name: 'prorate', label: 'Paid by paid days', type: 'select', required: true, half: true, options: YES_NO, hint: 'Reduced for loss-of-pay days' },
          { name: 'pfWage', label: 'Counts as PF wages', type: 'select', required: true, half: true, options: YES_NO },
          { name: 'description', label: 'Description', type: 'textarea' },
        ]}
        onSubmit={(v) => saveComponentAction(editingComponent?.id ?? null, v)}
      />

      {structure !== null && <StructureDialog structure={structure === 'new' ? null : structure} components={active} onClose={() => setStructure(null)} />}

      <ResourceDialog
        key={category && category !== 'new' ? category.id : 'new-category'}
        open={category !== null}
        onClose={() => setCategory(null)}
        title={category && category !== 'new' ? `Edit ${category.name}` : 'Add an expense category'}
        submitLabel="Save"
        initial={category && category !== 'new' ? { ...category, receiptRequired: yn(category.receiptRequired) } : { receiptRequired: 'yes' }}
        fields={[
          { name: 'name', label: 'Name', required: true },
          { name: 'receiptRequired', label: 'Receipt required', type: 'select', required: true, half: true, options: YES_NO },
          { name: 'maxPerClaim', label: 'Limit per claim', half: true, hint: 'Empty for no limit', nullable: true },
        ]}
        onSubmit={(v) => saveCategoryAction(category && category !== 'new' ? category.id : null, v)}
      />
    </div>
  );
}

function StructureDialog({ structure, components, onClose }: { structure: Structure | null; components: Component[]; onClose: () => void }) {
  const { pending, run } = useRunner();
  const basic = components.find((c) => c.isBasic);
  const [name, setName] = useState(structure?.name ?? '');
  const [description, setDescription] = useState(structure?.description ?? '');
  const [lines, setLines] = useState(structure?.lines.map((l) => ({ componentId: l.componentId, calc: l.calc, value: String(Number(l.value)) })) ?? [{ componentId: basic?.id ?? '', calc: 'percent_of_ctc', value: '50' }]);
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, k: 'componentId' | 'calc' | 'value', v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={structure ? `Edit ${structure.name}` : 'New salary structure'}
      description="Basic is required. Fixed values are annual amounts. One earning can take the balance of the CTC after the others and employer PF."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={pending} onClick={() => run(async () => {
            const r = await saveStructureAction(structure?.id ?? null, { name, description, lines });
            if (!r.ok) setError(r.message);
            return r;
          }, onClose)}>Save structure</Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Description">{(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[2fr_2fr_1fr_auto] items-end gap-2">
            <Field label={i === 0 ? 'Component' : ''}>{(p) => <Select {...p} value={l.componentId} onChange={(e) => set(i, 'componentId', e.target.value)}>{components.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
            <Field label={i === 0 ? 'Calculated as' : ''}>{(p) => <Select {...p} value={l.calc} onChange={(e) => set(i, 'calc', e.target.value)}>{Object.entries(CALC).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
            <Field label={i === 0 ? 'Value' : ''}>{(p) => <Input {...p} inputMode="decimal" value={l.value} disabled={l.calc === 'balance'} onChange={(e) => set(i, 'value', e.target.value)} />}</Field>
            <Button size="sm" variant="ghost" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
          </div>
        ))}
        <Button size="sm" variant="secondary" className="w-fit" onClick={() => setLines((ls) => [...ls, { componentId: components.find((c) => !ls.some((x) => x.componentId === c.id))?.id ?? '', calc: 'fixed', value: '0' }])}><Plus className="size-3.5" /> Add line</Button>
      </div>
    </Dialog>
  );
}
