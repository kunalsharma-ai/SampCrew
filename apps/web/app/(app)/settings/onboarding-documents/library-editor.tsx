'use client';
import { ONBOARDING_REQUIREMENT_LABEL, ONBOARDING_REQUIREMENTS, REQUEST_FILE_FORMAT_KEYS, REQUEST_FILE_LABEL, type OnboardingRequirement, type RequestFileFormat } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, Field, Input, Select, Textarea } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/api';
import {
  addCategoryAction, addItemAction, addTemplateAction, archiveCategoryAction, archiveItemAction, archiveTemplateAction, decideLibraryRequestAction,
  requestToSuperAction, updateCategoryAction, updateItemAction, updateTemplateAction,
} from '../../onboarding-documents/actions';
import type { Library, LibraryItem, LibraryTemplate } from '../../onboarding-documents/types';

const EMPLOYMENT_TYPES = [['full_time', 'Full-time'], ['part_time', 'Part-time'], ['contract', 'Contract'], ['intern', 'Intern'], ['temporary', 'Temporary']] as const;
type Dept = { id: string; name: string };

/** Runs a library change and shows what happened. */
function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult<unknown>>, after?: () => void) => start(async () => {
    setError(null);
    const r = await fn();
    if (!r.ok) return setError(r.message);
    after?.();
    router.refresh();
  });
  return { pending, error, run };
}

export function LibraryEditor({ library, departments }: { library: Library; departments: Dept[] }) {
  const manage = library.canManage;
  return (
    <div className="grid gap-6" data-testid="onboarding-library">
      <Requests library={library} />
      <Templates library={library} departments={departments} />
      <Card>
        <CardHeader title="Document library" description={`${library.items.length} documents in ${library.categories.length} categories.`} action={manage ? <span className="flex gap-2"><CategoryDialog /><ItemDialog library={library} /></span> : null} />
        <div className="grid gap-5 px-5 pb-5">
          {library.categories.map((c) => (
            <section key={c.id} className="grid gap-2" data-testid={`library-category-${c.key}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{c.name} <span className="font-normal text-fg-subtle">· {c.items} document{c.items === 1 ? '' : 's'}</span></h3>
                {manage && <span className="flex gap-2"><CategoryDialog category={c} />{c.items === 0 && <ArchiveButton label="Remove category" onArchive={() => archiveCategoryAction(c.id)} />}</span>}
              </div>
              {c.description && <p className="text-xs text-fg-subtle">{c.description}</p>}
              <ul className="grid gap-1.5">
                {library.items.filter((i) => i.categoryId === c.id).map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm" data-testid={`library-item-${i.key}`}>
                    <span className="min-w-0">
                      <span className="font-medium">{i.name}</span>{!i.active && <Badge className="ml-2">Inactive</Badge>}{i.sensitive && <Badge tone="warning" className="ml-2">Sensitive</Badge>}
                      <span className="block text-xs text-fg-subtle">{i.requirementLabel} · {i.formats.map((f) => REQUEST_FILE_LABEL[f]).join(', ')} · up to {i.maxMb} MB{i.multiple ? ` · up to ${i.maxFiles} files` : ''}</span>
                    </span>
                    {manage && <span className="flex gap-2"><ItemDialog library={library} item={i} /><ArchiveButton label="Remove" onArchive={() => archiveItemAction(i.id)} /></span>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Card>
    </div>
  );
}

function ArchiveButton({ label, onArchive }: { label: string; onArchive: () => Promise<ActionResult<unknown>> }) {
  const { pending, error, run } = useRun();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{label}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} size="sm" title={`${label}?`} description="It is taken out of the library and kept in the records. Documents already asked for keep their requests and history."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Back</Button><Button variant="danger" loading={pending} onClick={() => run(onArchive, () => setOpen(false))}>{label}</Button></>}>
        {error && <Alert tone="danger">{error}</Alert>}
      </Dialog>
    </>
  );
}

function CategoryDialog({ category }: { category?: Library['categories'][number] }) {
  const { pending, error, run } = useRun();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(category?.name ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const body = { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) };
  return (
    <>
      <Button size="sm" variant={category ? 'ghost' : 'secondary'} onClick={() => setOpen(true)}>{category ? 'Rename' : 'Add category'}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={category ? 'Edit category' : 'Add category'}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={name.trim().length < 2} onClick={() => run(() => (category ? updateCategoryAction(category.id, body) : addCategoryAction(body)), () => setOpen(false))}>Save</Button></>}>
        <div className="grid gap-3">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Name" required>{(p) => <Input {...p} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Description">{(p) => <Textarea {...p} rows={2} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        </div>
      </Dialog>
    </>
  );
}

function ItemDialog({ library, item }: { library: Library; item?: LibraryItem }) {
  const { pending, error, run } = useRun();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    categoryId: item?.categoryId ?? library.categories[0]?.id ?? '', name: item?.name ?? '', requirement: item?.requirement ?? ('optional' as OnboardingRequirement),
    description: item?.description ?? '', instructions: item?.instructions ?? '', formats: item?.formats ?? (['pdf', 'image'] as RequestFileFormat[]), maxMb: item?.maxMb ?? 5,
    multiple: item?.multiple ?? false, maxFiles: item?.maxFiles ?? 1, verification: item?.verification ?? '', sensitive: item?.sensitive ?? false, active: item?.active ?? true,
  });
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const hrSensitive = library.level === 'hr' && f.sensitive;
  const body = {
    ...f, name: f.name.trim(), maxFiles: f.multiple ? Math.max(2, f.maxFiles) : 1,
    description: f.description.trim() || undefined, instructions: f.instructions.trim() || undefined, verification: f.verification.trim() || undefined,
  };
  return (
    <>
      <Button size="sm" variant={item ? 'ghost' : 'primary'} onClick={() => setOpen(true)} data-testid={item ? undefined : 'library-add-document'}>{item ? 'Edit' : 'Add document'}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} size="lg" title={item ? `Edit ${item.name}` : 'Add a document to the library'}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={f.name.trim().length < 2 || !f.formats.length || !f.categoryId} onClick={() => run(() => (item ? updateItemAction(item.id, body) : addItemAction(body)), () => setOpen(false))} data-testid="library-save-document">Save</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          {error && <Alert tone="danger" className="sm:col-span-2">{error}</Alert>}
          <Field label="Document name" required className="sm:col-span-2">{(p) => <Input {...p} maxLength={160} value={f.name} onChange={(e) => set({ name: e.target.value })} data-testid="library-document-name" />}</Field>
          <Field label="Category" required>{(p) => <Select {...p} value={f.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>{library.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
          <Field label="Requirement" required hint={hrSensitive ? 'Only the Super Workspace can make a sensitive document mandatory.' : undefined}>{(p) => (
            <Select {...p} value={f.requirement} onChange={(e) => set({ requirement: e.target.value as OnboardingRequirement })}>
              {ONBOARDING_REQUIREMENTS.map((r) => <option key={r} value={r} disabled={hrSensitive && r === 'mandatory'}>{ONBOARDING_REQUIREMENT_LABEL[r]}</option>)}
            </Select>
          )}</Field>
          <fieldset className="grid gap-1 sm:col-span-2">
            <legend className="mb-1 text-sm font-medium">Accepted files</legend>
            <div className="flex flex-wrap gap-4">
              {REQUEST_FILE_FORMAT_KEYS.map((k) => <Checkbox key={k} label={REQUEST_FILE_LABEL[k]} checked={f.formats.includes(k)} onChange={(e) => set({ formats: e.target.checked ? [...f.formats, k] : f.formats.filter((x) => x !== k) })} />)}
            </div>
          </fieldset>
          <Field label="Largest file (MB)">{(p) => <Input {...p} type="number" min={1} max={25} value={f.maxMb} onChange={(e) => set({ maxMb: Number(e.target.value) || 1 })} />}</Field>
          <div className="grid gap-2">
            <Checkbox label="Takes several files" description="For example the front and back of a card, or each semester's mark sheet." checked={f.multiple} onChange={(e) => set({ multiple: e.target.checked, maxFiles: e.target.checked ? Math.max(2, f.maxFiles) : 1 })} />
            {f.multiple && <Field label="Up to how many files">{(p) => <Input {...p} type="number" min={2} max={10} value={f.maxFiles} onChange={(e) => set({ maxFiles: Number(e.target.value) || 2 })} />}</Field>}
          </div>
          <Field label="Description" className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} maxLength={600} value={f.description} onChange={(e) => set({ description: e.target.value })} />}</Field>
          <Field label="Upload instructions for the employee" className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} maxLength={600} value={f.instructions} onChange={(e) => set({ instructions: e.target.value })} />}</Field>
          <Field label="Verification notes for HR" hint="Only HR and the Super Workspace see these." className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} maxLength={600} value={f.verification} onChange={(e) => set({ verification: e.target.value })} />}</Field>
          <Checkbox label="Sensitive document" description="Identity numbers, bank details or medical records. Previews and downloads follow the stricter access rules." checked={f.sensitive} disabled={library.level === 'hr' && !!item?.sensitive} onChange={(e) => set({ sensitive: e.target.checked, requirement: library.level === 'hr' && e.target.checked && f.requirement === 'mandatory' ? 'optional' : f.requirement })} />
          <Checkbox label="Active" description="Inactive documents stay in the library but cannot be assigned." checked={f.active} onChange={(e) => set({ active: e.target.checked })} />
        </div>
      </Dialog>
    </>
  );
}

function Templates({ library, departments }: { library: Library; departments: Dept[] }) {
  const names = new Map(library.items.map((i) => [i.id, i.name]));
  return (
    <Card>
      <CardHeader title="Onboarding templates" description="HR picks one in the Add Employee form and can add or leave out optional documents. A template's mandatory documents are always asked for." action={library.canManage ? <TemplateDialog library={library} departments={departments} /> : null} />
      <ul className="grid gap-3 px-5 pb-5 md:grid-cols-2">
        {library.templates.map((t) => (
          <li key={t.id} className="grid gap-2 rounded-xl border border-border p-4" data-testid={`library-template-${t.key}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span>
                <span className="font-medium">{t.name}</span>{t.isDefault && <Badge tone="accent" className="ml-2">Default</Badge>}{!t.active && <Badge className="ml-2">Inactive</Badge>}
                <span className="block text-xs text-fg-subtle">{t.items.length} documents, {t.items.filter((x) => x.required).length} mandatory{t.employmentTypes.length ? ` · ${t.employmentTypes.map((x) => EMPLOYMENT_TYPES.find((e) => e[0] === x)?.[1] ?? x).join(', ')}` : ''}{t.departments.length ? ` · ${t.departments.map((d) => d.name).filter(Boolean).join(', ')}` : ''}</span>
              </span>
              {library.canManage && <span className="flex gap-1"><TemplateDialog library={library} departments={departments} template={t} />{!t.isDefault && <ArchiveButton label="Remove" onArchive={() => archiveTemplateAction(t.id)} />}</span>}
            </div>
            {t.description && <p className="text-xs text-fg-muted">{t.description}</p>}
            <details className="text-xs">
              <summary className="cursor-pointer text-accent">Documents</summary>
              <ul className="mt-2 grid gap-0.5">{t.items.map((x) => <li key={x.itemId}>{x.required ? '● ' : '○ '}{names.get(x.itemId) ?? 'Removed document'}</li>)}</ul>
            </details>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TemplateDialog({ library, departments, template }: { library: Library; departments: Dept[]; template?: LibraryTemplate }) {
  const { pending, error, run } = useRun();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [items, setItems] = useState<Map<string, boolean>>(new Map((template?.items ?? []).map((x) => [x.itemId, x.required])));
  const [types, setTypes] = useState<string[]>(template?.employmentTypes ?? []);
  const [depts, setDepts] = useState<string[]>(template?.departments.map((d) => d.id) ?? []);
  const [isDefault, setDefault] = useState(template?.isDefault ?? false);
  const [active, setActive] = useState(template?.active ?? true);
  const byId = new Map(library.items.map((i) => [i.id, i]));
  const toggle = (id: string, on: boolean, required = false) => { const m = new Map(items); if (on) m.set(id, required); else m.delete(id); setItems(m); };
  const body = {
    name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), items: [...items.entries()].map(([itemId, required]) => ({ itemId, required })),
    employmentTypes: types, departmentIds: depts, isDefault, active,
  };
  return (
    <>
      <Button size="sm" variant={template ? 'ghost' : 'secondary'} onClick={() => setOpen(true)}>{template ? 'Edit' : 'Add template'}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} size="lg" title={template ? `Edit ${template.name}` : 'Add an onboarding template'}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={name.trim().length < 2 || !items.size} onClick={() => run(() => (template ? updateTemplateAction(template.id, body) : addTemplateAction(body)), () => setOpen(false))}>Save template</Button></>}>
        <div className="grid gap-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Template name" required>{(p) => <Input {...p} maxLength={160} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Description">{(p) => <Input {...p} maxLength={400} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
          </div>
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-sm font-medium">Suggested for employment types</legend>
            <div className="flex flex-wrap gap-4">{EMPLOYMENT_TYPES.map(([k, l]) => <Checkbox key={k} label={l} checked={types.includes(k)} onChange={(e) => setTypes(e.target.checked ? [...types, k] : types.filter((x) => x !== k))} />)}</div>
          </fieldset>
          {departments.length > 0 && (
            <fieldset className="grid gap-1">
              <legend className="mb-1 text-sm font-medium">Suggested for departments</legend>
              <div className="flex max-h-32 flex-wrap gap-4 overflow-y-auto">{departments.map((d) => <Checkbox key={d.id} label={d.name} checked={depts.includes(d.id)} onChange={(e) => setDepts(e.target.checked ? [...depts, d.id] : depts.filter((x) => x !== d.id))} />)}</div>
            </fieldset>
          )}
          <div className="grid max-h-80 gap-3 overflow-y-auto rounded-xl border border-border p-3">
            {library.categories.map((c) => (
              <fieldset key={c.id} className="grid gap-1">
                <legend className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{c.name}</legend>
                {library.items.filter((i) => i.categoryId === c.id && i.active).map((i) => {
                  const on = items.has(i.id);
                  const lockedOptional = library.level === 'hr' && i.sensitive;
                  return (
                    <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <label className="flex items-center gap-2"><input type="checkbox" checked={on} onChange={(e) => toggle(i.id, e.target.checked, i.requirement === 'mandatory' && !lockedOptional)} />{i.name}</label>
                      {on && (
                        <Select aria-label={`${i.name}: mandatory or optional`} className="h-8 w-36 text-xs" value={items.get(i.id) ? 'required' : 'optional'} onChange={(e) => toggle(i.id, true, e.target.value === 'required')}>
                          <option value="required" disabled={lockedOptional}>Mandatory</option>
                          <option value="optional">Optional</option>
                        </Select>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            ))}
          </div>
          <p className="text-xs text-fg-subtle">{items.size} documents, {[...items.values()].filter(Boolean).length} mandatory{[...items.keys()].some((x) => !byId.has(x)) ? '. Some documents were removed from the library and will be dropped.' : '.'}</p>
          <div className="flex flex-wrap gap-6">
            <Checkbox label="Default template" description="Suggested when no other template fits the employee." checked={isDefault} onChange={(e) => setDefault(e.target.checked)} />
            <Checkbox label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} />
          </div>
        </div>
      </Dialog>
    </>
  );
}

function Requests({ library }: { library: Library }) {
  const { pending, error, run } = useRun();
  const [open, setOpen] = useState<null | 'document' | 'permission'>(null);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState(library.categories[0]?.id ?? '');
  const [requirement, setRequirement] = useState<OnboardingRequirement>('optional');
  const [reason, setReason] = useState('');
  const waiting = library.requests.filter((r) => r.status === 'open');
  if (library.level === 'super' && !library.requests.length) return null;
  return (
    <Card>
      <CardHeader
        title={library.level === 'super' ? 'Requests from HR Workspaces' : 'Requests to the Super Workspace'}
        description={library.level === 'super' ? `${waiting.length} waiting for your decision.` : 'Ask for a document the library does not have, or for permission to manage the library yourselves.'}
        action={library.level === 'hr' ? <span className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => setOpen('document')}>Ask for a document</Button>{!library.canManage && <Button size="sm" variant="ghost" onClick={() => setOpen('permission')}>Ask for permission</Button>}</span> : null}
      />
      <div className="grid gap-2 px-5 pb-5">
        {error && <Alert tone="danger">{error}</Alert>}
        {library.requests.length === 0 && <p className="text-sm text-fg-muted">No requests yet.</p>}
        {library.requests.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm" data-testid="library-request">
            <span className="min-w-0">
              <span className="font-medium">{r.kind === 'permission' ? 'Permission to manage the library' : r.name}</span>
              <span className="block text-xs text-fg-subtle">{[r.hrWorkspace, r.reason, r.decisionNote ? `Note: ${r.decisionNote}` : null].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="flex items-center gap-2">
              <Badge tone={r.status === 'approved' ? 'success' : r.status === 'declined' ? 'danger' : 'info'} className="capitalize">{r.status === 'open' ? 'Waiting' : r.status}</Badge>
              {library.level === 'super' && r.status === 'open' && (
                <>
                  <Button size="sm" loading={pending} onClick={() => run(() => decideLibraryRequestAction(r.id, 'approve'))} data-testid="library-request-approve">Approve</Button>
                  <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => decideLibraryRequestAction(r.id, 'decline'))}>Decline</Button>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open === 'permission' ? 'Ask for permission to manage the library' : 'Ask for a new document'}
        footer={<><Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button><Button loading={pending} disabled={reason.trim().length < 5 || (open === 'document' && name.trim().length < 2)} onClick={() => run(() => requestToSuperAction(open === 'permission' ? { kind: 'permission', reason: reason.trim() } : { kind: 'document', name: name.trim(), categoryId, requirement, reason: reason.trim() }), () => { setOpen(null); setName(''); setReason(''); })}>Send</Button></>}>
        <div className="grid gap-3">
          {open === 'document' && (
            <>
              <Field label="Document name" required>{(p) => <Input {...p} maxLength={160} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Category">{(p) => <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{library.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
                <Field label="Requirement">{(p) => <Select {...p} value={requirement} onChange={(e) => setRequirement(e.target.value as OnboardingRequirement)}>{ONBOARDING_REQUIREMENTS.map((r) => <option key={r} value={r}>{ONBOARDING_REQUIREMENT_LABEL[r]}</option>)}</Select>}</Field>
              </div>
            </>
          )}
          <Field label="Why it is needed" required>{(p) => <Textarea {...p} rows={3} maxLength={600} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        </div>
      </Dialog>
    </Card>
  );
}
