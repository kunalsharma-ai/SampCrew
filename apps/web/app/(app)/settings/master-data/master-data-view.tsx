'use client';
import { type MasterList, type MasterListSummary, type MasterValue, systemValues } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, cn, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { BookOpen, ListTree, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { addFromLibraryAction, addMasterValueAction, masterLibraryAction, updateMasterValueAction } from './actions';

type Library = { label: string; category: string; code?: string; level?: number; present: boolean }[];
type Draft = { label: string; category: string; code: string; level: string };

const hasLevel = (l: MasterList) => l === 'job_title' || l === 'seniority_level';
const hasCode = (l: MasterList) => l === 'department' || l === 'job_title' || l === 'industry' || l === 'job_role' || l === 'education' || l === 'seniority_level' || l === 'candidate_source';

export function MasterDataView({ lists, list, data, q, category, disabled }: {
  lists: MasterListSummary[]; list: MasterList; data: { list: MasterListSummary; categories: string[]; items: MasterValue[] }; q: string; category: string; disabled: string;
}) {
  const router = useRouter();
  const path = usePathname();
  const [search, setSearch] = useState(q);
  const [editing, setEditing] = useState<MasterValue | 'new' | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const info = data.list;
  const go = (p: Record<string, string>) => {
    const qs = new URLSearchParams({ list, ...(q ? { q } : {}), ...(category ? { category } : {}), ...(disabled !== 'false' ? { disabled } : {}), ...p });
    for (const [k, v] of [...qs.entries()]) if (!v) qs.delete(k);
    router.push(`${path}?${qs}`);
  };
  const toggle = (v: MasterValue) => start(async () => {
    const r = await updateMasterValueAction(list, v.id, { disabled: !v.disabled });
    setMessage(r.ok ? { tone: 'success', text: r.message ?? 'Saved' } : { tone: 'danger', text: r.message });
    router.refresh();
  });
  const openLibrary = () => start(async () => {
    const r = await masterLibraryAction(list);
    if (r.ok && r.data) setLibrary(r.data); else if (!r.ok) setMessage({ tone: 'danger', text: r.message });
  });
  const system = info.storage === 'system' ? systemValues(list as 'employment_type' | 'employment_status') : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <nav aria-label="Lists" className="grid content-start gap-1">
        {lists.map((l) => (
          <Link key={l.key} href={`${path}?list=${l.key}`} aria-current={l.key === list ? 'page' : undefined}
            className={cn('flex items-center justify-between rounded-md px-3 py-2 text-[0.8125rem]', l.key === list ? 'bg-accent-subtle font-medium text-accent' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg')}>
            <span>{l.label}</span><span className="text-xs">{l.active}</span>
          </Link>
        ))}
      </nav>
      <div className="grid content-start gap-4">
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        <Card>
          <CardHeader title={info.label} description={<>{info.description} <span className="block text-xs">Used in: {info.usedIn}</span></>}
            action={info.editable ? (
              <div className="flex flex-wrap gap-2">
                {info.storage !== 'locations' && <Button size="sm" variant="secondary" onClick={openLibrary} loading={pending && !library}><BookOpen className="size-3.5" aria-hidden /> Add from the library</Button>}
                <Button size="sm" onClick={() => setEditing('new')} data-testid="master-add"><Plus className="size-3.5" aria-hidden /> Add {info.singular.toLowerCase()}</Button>
              </div>
            ) : info.storage === 'locations' ? <Link className="text-[0.8125rem] text-accent hover:underline" href="/organization">Manage in Organization</Link> : null} />
          {system ? (
            <CardBody>
              <p className="mb-3 text-[0.8125rem] text-fg-muted">Built in: these cannot be changed because payroll, leave and lifecycle rules depend on them.</p>
              <div className="flex flex-wrap gap-2">{system.map((s) => <Badge key={s.key}>{s.label}</Badge>)}</div>
            </CardBody>
          ) : (
            <>
              <CardBody className="flex flex-wrap items-end gap-3">
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); go({ q: search }); }}>
                  <Input aria-label="Search" placeholder="Search by name or code" value={search} onChange={(e) => setSearch(e.target.value)} className="w-64" />
                  <Button type="submit" variant="secondary" size="sm">Search</Button>
                </form>
                {data.categories.length > 0 && (
                  <Select aria-label="Category" className="w-56" value={category} onChange={(e) => go({ category: e.target.value })}>
                    <option value="">Every category</option>
                    {data.categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                )}
                <Select aria-label="Show" className="w-44" value={disabled} onChange={(e) => go({ disabled: e.target.value === 'false' ? '' : e.target.value })}>
                  <option value="false">In use</option>
                  <option value="true">Disabled</option>
                  <option value="all">All</option>
                </Select>
              </CardBody>
              {data.items.length === 0 ? <EmptyState icon={<ListTree className="size-5" />} title="Nothing here" description={q || category ? 'No value matches. Try another search.' : 'Add a value, or add ready-made ones from the library.'} /> : (
                <Table aria-label={info.label}>
                  <THead><tr><TH>Name</TH><TH>Category</TH>{hasCode(list) && <TH>Code</TH>}{hasLevel(list) && <TH>Level</TH>}<TH>Used by</TH><TH>From</TH><TH><span className="sr-only">Actions</span></TH></tr></THead>
                  <TBody>
                    {data.items.map((v) => (
                      <TR key={v.id} data-testid={`master-value-${v.key}`}>
                        <TD className="font-medium">{v.label}{v.disabled && <Badge className="ml-2">Disabled</Badge>}</TD>
                        <TD className="text-[0.8125rem] text-fg-muted">{v.category ?? ''}</TD>
                        {hasCode(list) && <TD className="text-[0.8125rem]">{v.code ?? ''}</TD>}
                        {hasLevel(list) && <TD className="text-[0.8125rem]">{v.level ?? ''}</TD>}
                        <TD className="text-[0.8125rem]">{v.usage ?? ''}</TD>
                        <TD><Badge tone={v.origin === 'custom' ? 'accent' : 'neutral'}>{v.origin === 'custom' ? 'Added by you' : v.origin === 'library' ? 'Library' : 'Built in'}</Badge></TD>
                        <TD className="text-right whitespace-nowrap">
                          {info.editable && v.origin !== 'system' && (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => setEditing(v)} aria-label={`Edit ${v.label}`}><Pencil className="size-3.5" aria-hidden /></Button>
                              <Button size="sm" variant="ghost" onClick={() => toggle(v)} disabled={pending}>{v.disabled ? 'Enable' : 'Disable'}</Button>
                            </>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </>
          )}
        </Card>
      </div>
      {editing && <ValueDialog list={list} singular={info.singular} value={editing === 'new' ? null : editing} categories={data.categories} onClose={(text) => { setEditing(null); if (text) { setMessage({ tone: 'success', text }); router.refresh(); } }} />}
      {library && <LibraryDialog list={list} label={info.label} library={library} onClose={(text) => { setLibrary(null); if (text) { setMessage({ tone: 'success', text }); router.refresh(); } }} />}
    </div>
  );
}

function ValueDialog({ list, singular, value, categories, onClose }: { list: MasterList; singular: string; value: MasterValue | null; categories: string[]; onClose: (message?: string) => void }) {
  const [d, setD] = useState<Draft>({ label: value?.label ?? '', category: value?.category ?? '', code: value?.code ?? '', level: value?.level?.toString() ?? '' });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () => start(async () => {
    setError(null);
    const body = {
      label: d.label, category: d.category.trim() || null,
      ...(hasCode(list) ? { code: d.code.trim() || null } : {}),
      ...(hasLevel(list) ? { level: d.level.trim() === '' ? null : Number(d.level) } : {}),
    };
    const r = value ? await updateMasterValueAction(list, value.id, body) : await addMasterValueAction(list, body);
    if (r.ok) onClose(value ? `${d.label} saved` : `${d.label} added`);
    else setError(r.fieldErrors ? Object.values(r.fieldErrors).join(' ') : r.message);
  });
  return (
    <Dialog open onClose={() => onClose()} title={value ? `Edit ${value.label}` : `Add ${singular.toLowerCase()}`}
      description={value ? 'Records that hold this value show the new name.' : undefined}
      footer={<><Button variant="secondary" onClick={() => onClose()}>Cancel</Button><Button onClick={save} loading={pending} data-testid="master-save">Save</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Name" required>{(p) => <Input {...p} autoFocus value={d.label} maxLength={120} onChange={(e) => setD({ ...d, label: e.target.value })} />}</Field>
        <Field label="Category" hint={categories.length ? `For example ${categories.slice(0, 3).join(', ')}` : 'Groups values in dropdowns'}>{(p) => (
          <>
            <Input {...p} list="master-categories" value={d.category} maxLength={60} onChange={(e) => setD({ ...d, category: e.target.value })} />
            <datalist id="master-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          </>
        )}</Field>
        {hasCode(list) && <Field label="Code">{(p) => <Input {...p} value={d.code} maxLength={20} onChange={(e) => setD({ ...d, code: e.target.value })} />}</Field>}
        {hasLevel(list) && <Field label="Seniority level" hint="0 (intern) to 100 (the top)">{(p) => <Input {...p} type="number" min={0} max={100} value={d.level} onChange={(e) => setD({ ...d, level: e.target.value })} />}</Field>}
      </div>
    </Dialog>
  );
}

function LibraryDialog({ list, label, library, onClose }: { list: MasterList; label: string; library: Library; onClose: (message?: string) => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shown = library.filter((v) => !filter || v.label.toLowerCase().includes(filter.toLowerCase()) || v.category.toLowerCase().includes(filter.toLowerCase()));
  const groups = [...new Set(shown.map((v) => v.category))];
  const missing = library.filter((v) => !v.present);
  const add = () => start(async () => {
    const r = await addFromLibraryAction(list, [...picked]);
    if (r.ok && r.data) onClose(`${r.data.added} added${r.data.skipped ? `, ${r.data.skipped} already there` : ''}`);
    else if (!r.ok) setError(r.message);
  });
  return (
    <Dialog open onClose={() => onClose()} size="lg" title={`${label}: library`} description={`${missing.length} ready-made values you do not have yet.`}
      footer={<><Button variant="secondary" onClick={() => onClose()}>Cancel</Button><Button onClick={add} loading={pending} disabled={picked.size === 0}>Add {picked.size || ''}</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Input aria-label="Filter the library" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-56" />
          <Button size="sm" variant="secondary" onClick={() => setPicked(new Set(missing.map((v) => v.label)))}>Choose all missing</Button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
          {groups.map((g) => (
            <fieldset key={g} className="mb-3">
              <legend className="mb-1 text-xs font-medium text-fg-muted">{g}</legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {shown.filter((v) => v.category === g).map((v) => (
                  <Checkbox key={v.label} label={v.label} description={v.present ? 'Already in your list' : undefined} disabled={v.present} checked={v.present || picked.has(v.label)}
                    onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(v.label); else n.delete(v.label); return n; })} />
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
