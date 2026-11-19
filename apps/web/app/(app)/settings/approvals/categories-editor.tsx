'use client';
import type { ApprovalCategoryInput } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Dialog, Field, Input, Select, Switch } from '@crew/ui';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteApprovalCategoryAction, saveApprovalCategoryAction } from './actions';

export interface CategoryRow {
  key: string; label: string; description: string; icon: string; color: string; builtIn: boolean; active: boolean;
  rule: { resourceTypes: string[]; leaveTypeCodes?: string[]; paid?: boolean; halfDay?: boolean; expenseCategoryIds?: string[] };
}

const ICON_CHOICES = ['inbox', 'calendar', 'clock', 'receipt', 'wallet', 'heart', 'home', 'contact', 'file-text', 'briefcase', 'shield', 'target'];

const blank = (): ApprovalCategoryInput => ({ key: '', label: '', description: '', icon: 'inbox', color: '#4f46e5', resourceTypes: ['leave_request'], leaveTypeCodes: [], paid: null, halfDay: null, expenseCategoryIds: [], active: true });

/** HR's own approval categories (cards on the Approvals page), next to the built-in ones. */
export function CategoriesEditor({ categories, types, leaveTypes, expenseCategories }: {
  categories: CategoryRow[];
  types: { key: string; label: string }[];
  leaveTypes: { code: string; name: string }[];
  expenseCategories: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ key: string | null; v: ApprovalCategoryInput } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const custom = categories.filter((c) => !c.builtIn);
  const builtIn = categories.filter((c) => c.builtIn);
  const typeLabel = (k: string) => types.find((t) => t.key === k)?.label ?? k.replace(/_/g, ' ');
  const describe = (c: CategoryRow) => [
    c.rule.resourceTypes.length ? c.rule.resourceTypes.map(typeLabel).join(', ') : 'Anything else',
    c.rule.leaveTypeCodes?.length ? `leave types ${c.rule.leaveTypeCodes.join(', ')}` : null,
    c.rule.paid === true ? 'paid' : c.rule.paid === false ? 'unpaid' : null,
    c.rule.halfDay ? 'half days' : null,
    c.rule.expenseCategoryIds?.length ? `expense categories ${c.rule.expenseCategoryIds.map((id) => expenseCategories.find((e) => e.id === id)?.name ?? '?').join(', ')}` : null,
  ].filter(Boolean).join(' · ');

  const save = () => start(async () => {
    if (!editing) return;
    const r = await saveApprovalCategoryAction(editing.key, editing.v);
    if (r.ok) {
      setEditing(null);
      setMsg({ tone: 'success', text: `${editing.v.label} saved. Requests waiting now were placed again.` });
      router.refresh();
    } else setMsg({ tone: 'danger', text: r.message });
  });
  const set = (patch: Partial<ApprovalCategoryInput>) => setEditing((e) => (e ? { ...e, v: { ...e.v, ...patch } } : e));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Card>
      <CardHeader
        title="Approval categories"
        description="Each request goes into one card on the Approvals page. Your own categories are checked first, so you can split out, say, one expense category as Reimbursement or a leave type of your own."
        action={<Button size="sm" onClick={() => { setMsg(null); setEditing({ key: null, v: blank() }); }}><Plus className="size-3.5" /> Add category</Button>}
      />
      <CardBody className="grid gap-4">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {custom.length > 0 && (
          <ul className="grid gap-2" aria-label="Your categories">
            {custom.map((c) => (
              <li key={c.key} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2" data-testid={`category-${c.key}`}>
                <span className="size-3 rounded-full" style={{ background: c.color }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[0.8125rem] font-semibold">{c.label} {!c.active && <Badge>Off</Badge>}</div>
                  <div className="truncate text-xs text-fg-muted">{describe(c)}</div>
                </div>
                <button className="rounded p-1.5 text-fg-subtle hover:text-fg" aria-label={`Edit ${c.label}`} onClick={() => setEditing({ key: c.key, v: {
                  key: c.key, label: c.label, description: c.description, icon: c.icon, color: c.color, resourceTypes: c.rule.resourceTypes, leaveTypeCodes: c.rule.leaveTypeCodes ?? [],
                  paid: c.rule.paid ?? null, halfDay: c.rule.halfDay ?? null, expenseCategoryIds: c.rule.expenseCategoryIds ?? [], active: c.active,
                } })}><Pencil className="size-4" /></button>
                <button className="rounded p-1.5 text-fg-subtle hover:text-danger" aria-label={`Remove ${c.label}`} onClick={() => start(async () => {
                  const r = await deleteApprovalCategoryAction(c.key);
                  setMsg(r.ok ? { tone: 'success', text: `${c.label} removed. Its requests moved to the built-in categories.` } : { tone: 'danger', text: r.message });
                  router.refresh();
                })}><Trash2 className="size-4" /></button>
              </li>
            ))}
          </ul>
        )}
        <details>
          <summary className="cursor-pointer text-xs font-medium text-fg-muted">Built-in categories ({builtIn.length})</summary>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {builtIn.map((c) => (
              <li key={c.key} className="flex items-start gap-2 text-xs"><span className="mt-1 size-2 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden /><span><strong>{c.label}</strong>: <span className="text-fg-muted">{describe(c)}</span></span></li>
            ))}
          </ul>
        </details>
      </CardBody>
      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing?.key ? 'Edit approval category' : 'Add approval category'} footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={pending} onClick={save}>Save category</Button></>}>
        {editing && (
          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" required>{(p) => <Input {...p} value={editing.v.label} maxLength={60} onChange={(e) => set({ label: e.target.value, ...(editing.key ? {} : { key: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'c_$1').slice(0, 40) }) })} />}</Field>
              <Field label="Key" hint="Lower-case letters, digits and _">{(p) => <Input {...p} value={editing.v.key} maxLength={40} onChange={(e) => set({ key: e.target.value })} />}</Field>
            </div>
            <Field label="Description">{(p) => <Input {...p} value={editing.v.description} maxLength={200} onChange={(e) => set({ description: e.target.value })} />}</Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Icon">{(p) => <Select {...p} value={editing.v.icon} onChange={(e) => set({ icon: e.target.value })}>{ICON_CHOICES.map((i) => <option key={i} value={i}>{i}</option>)}</Select>}</Field>
              <Field label="Colour">{(p) => <Input {...p} type="color" value={editing.v.color} onChange={(e) => set({ color: e.target.value })} className="h-9 p-1" />}</Field>
            </div>
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-xs font-medium">Request types</legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {types.map((t) => <Checkbox key={t.key} label={t.label} checked={editing.v.resourceTypes.includes(t.key)} onChange={() => set({ resourceTypes: toggle(editing.v.resourceTypes, t.key) })} />)}
              </div>
            </fieldset>
            {editing.v.resourceTypes.includes('leave_request') && (
              <fieldset className="grid gap-1.5">
                <legend className="mb-1 text-xs font-medium">Leave types (none ticked means any)</legend>
                <div className="grid gap-1 sm:grid-cols-3">
                  {leaveTypes.map((l) => <Checkbox key={l.code} label={`${l.name} (${l.code})`} checked={editing.v.leaveTypeCodes.includes(l.code)} onChange={() => set({ leaveTypeCodes: toggle(editing.v.leaveTypeCodes, l.code) })} />)}
                </div>
                <Field label="Paid or unpaid">{(p) => <Select {...p} value={editing.v.paid === null ? '' : String(editing.v.paid)} onChange={(e) => set({ paid: e.target.value === '' ? null : e.target.value === 'true' })}><option value="">Either</option><option value="true">Paid only</option><option value="false">Unpaid only</option></Select>}</Field>
              </fieldset>
            )}
            {editing.v.resourceTypes.includes('expense_claim') && expenseCategories.length > 0 && (
              <fieldset className="grid gap-1.5">
                <legend className="mb-1 text-xs font-medium">Expense categories (none ticked means any)</legend>
                <div className="grid gap-1 sm:grid-cols-3">
                  {expenseCategories.map((x) => <Checkbox key={x.id} label={x.name} checked={editing.v.expenseCategoryIds.includes(x.id)} onChange={() => set({ expenseCategoryIds: toggle(editing.v.expenseCategoryIds, x.id) })} />)}
                </div>
              </fieldset>
            )}
            <div className="flex items-center justify-between text-[0.8125rem]"><span>Category is in use</span><Switch label="Category is in use" checked={editing.v.active} onChange={(v) => set({ active: v })} /></div>
            {msg?.tone === 'danger' && <Alert tone="danger">{msg.text}</Alert>}
          </div>
        )}
      </Dialog>
    </Card>
  );
}
