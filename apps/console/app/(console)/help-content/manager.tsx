'use client';
import {
  BOOLEAN_FEATURES, FEATURE_PARTS, HELP_ARTICLE_KINDS, HELP_AUDIENCE_LABEL, HELP_AUDIENCES, HELP_ICON_KEYS, HELP_ICONS, HELP_KIND_LABEL, HELP_OTHER_CATEGORY, PERMISSIONS,
  type HelpArticleKind, type HelpArticleSummary, type HelpAudience, type HelpCategoryView, type HelpIcon, type HelpInsights, type HelpQueryCategoryView, type HelpSettings,
} from '@crew/contracts';
import { Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, Field, Input, Select, Stat, Switch, Table, TBody, TD, TH, THead, TR, Textarea, buttonClass, cn } from '@crew/ui';
import { BarChart3, BookOpen, Eye, EyeOff, FolderTree, Pencil, Plus, Search, Settings2, Tags, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import {
  articleStatusAction, deleteArticleAction, deleteCategoryAction, deleteQueryCategoryAction, saveCategoryAction, saveHelpSettingsAction, saveQueryCategoryAction,
} from '../help/actions';

export type ManagedArticle = HelpArticleSummary & { status: string; feature: string | null; permission: string | null; builtin: boolean; customised: boolean; updatedAt: string; views: number; yes: number; no: number };
export interface ManageData { categories: HelpCategoryView[]; articles: ManagedArticle[]; queryCategories: HelpQueryCategoryView[]; settings: HelpSettings }

const TABS = [
  { key: 'articles', label: 'Articles', icon: BookOpen },
  { key: 'categories', label: 'Categories', icon: FolderTree },
  { key: 'queries', label: 'Query categories', icon: Tags },
  { key: 'settings', label: 'Settings', icon: Settings2 },
  { key: 'insights', label: 'Insights', icon: BarChart3 },
] as const;
export type ManagerTab = (typeof TABS)[number]['key'];

/** Feature keys and parts, for the "shown only while this feature is on" pickers. */
export const FEATURE_OPTIONS = [...BOOLEAN_FEATURES.map((f) => ({ key: f.key, label: f.name })), ...FEATURE_PARTS.map((p) => ({ key: p.key, label: p.name }))];
export const PERMISSION_OPTIONS = PERMISSIONS.map((p) => ({ key: p.key, label: p.description }));

const levelText = (a: HelpAudience[]) => a.map((x) => HELP_AUDIENCE_LABEL[x].replace(' Workspace', '')).join(', ');

type Run = (fn: () => Promise<{ ok: boolean; message?: string }>, after?: () => void) => void;

/** The Console's help content manager: articles, categories and subcategories, query categories, settings and insights. */
export function HelpContentManager({ data, insights, tab }: { data: ManageData; insights: HelpInsights; tab: ManagerTab }) {
  const router = useRouter();
  const [note, setNote] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const run: Run = (fn, after) => start(async () => {
    const r = await fn();
    setNote(r.ok ? (r.message ? { tone: 'success', text: r.message } : null) : { tone: 'danger', text: r.message ?? 'Something went wrong' });
    if (r.ok) after?.();
    router.refresh();
  });
  return (
    <div className="grid gap-4" data-testid="help-content-manager">
      <nav className="flex flex-wrap gap-1 border-b border-border" aria-label="Help content">
        {TABS.map((t) => (
          <Link key={t.key} href={`/help-content?tab=${t.key}`} aria-current={tab === t.key ? 'page' : undefined} data-testid={`help-tab-${t.key}`} className={cn('-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm', tab === t.key ? 'border-accent font-medium text-accent' : 'border-transparent text-fg-muted hover:text-fg')}>
            <t.icon className="size-4" aria-hidden />{t.label}
          </Link>
        ))}
      </nav>
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      {tab === 'articles' && <ArticlesTab data={data} run={run} pending={pending} />}
      {tab === 'categories' && <CategoriesTab data={data} run={run} pending={pending} />}
      {tab === 'queries' && <QueryCategoriesTab items={data.queryCategories} run={run} pending={pending} />}
      {tab === 'settings' && <SettingsTab settings={data.settings} run={run} pending={pending} />}
      {tab === 'insights' && <InsightsTab insights={insights} />}
    </div>
  );
}

function Confirm({ open, title, body, onClose, onConfirm, pending }: { open: boolean; title: string; body: string; onClose: () => void; onConfirm: () => void; pending: boolean }) {
  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" onClick={onConfirm} loading={pending} data-testid="confirm-delete">Delete</Button></>}>
      <p className="text-sm text-fg-muted">{body}</p>
    </Dialog>
  );
}

function ArticlesTab({ data, run, pending }: { data: ManageData; run: Run; pending: boolean }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [cat, setCat] = useState('');
  const [status, setStatus] = useState('');
  const [level, setLevel] = useState('');
  const [del, setDel] = useState<ManagedArticle | null>(null);
  const rows = useMemo(() => data.articles.filter((a) =>
    (!q || `${a.title} ${a.slug} ${a.summary}`.toLowerCase().includes(q.toLowerCase())) && (!kind || a.kind === kind) && (!cat || a.categoryId === cat || data.categories.find((c) => c.id === a.categoryId)?.parentId === cat)
    && (!status || a.status === status) && (!level || a.audiences.includes(level as HelpAudience))), [data, q, kind, cat, status, level]);
  return (
    <Card className="p-0">
      <div className="flex flex-col gap-2 border-b border-border p-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-fg-subtle" aria-hidden />
          <Input aria-label="Search articles" placeholder="Search titles" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8" data-testid="manage-search" />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} className="h-8 text-xs"><option value="">All kinds</option>{HELP_ARTICLE_KINDS.map((k) => <option key={k} value={k}>{HELP_KIND_LABEL[k]}</option>)}</Select>
          <Select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} className="h-8 text-xs"><option value="">All categories</option>{data.categories.map((c) => <option key={c.id} value={c.id}>{c.parentId ? '· ' : ''}{c.name}</option>)}</Select>
          <Select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)} className="h-8 text-xs"><option value="">All levels</option>{HELP_AUDIENCES.map((l) => <option key={l} value={l}>{HELP_AUDIENCE_LABEL[l]}</option>)}</Select>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 text-xs"><option value="">Published and drafts</option><option value="published">Published</option><option value="draft">Drafts</option></Select>
        </div>
        <Link href="/help-content/articles/new?kind=feature&audience=public" className={buttonClass('secondary', 'sm')} data-testid="new-feature-brief"><Plus className="size-3.5" aria-hidden />New feature brief</Link>
        <Link href="/help-content/articles/new?kind=faq&audience=public" className={buttonClass('secondary', 'sm')} data-testid="new-public-faq"><Plus className="size-3.5" aria-hidden />New public FAQ</Link>
        <Link href="/help-content/articles/new" className={buttonClass('primary', 'sm')} data-testid="new-article"><Plus className="size-3.5" aria-hidden />New article</Link>
      </div>
      <p className="px-4 py-2 text-xs text-fg-muted">{rows.length} of {data.articles.length} articles</p>
      <div className="overflow-x-auto">
        <Table>
          <THead><TR><TH>Article</TH><TH>Category</TH><TH>Levels</TH><TH>Status</TH><TH className="text-right">Views</TH><TH className="text-right">Helpful</TH><TH className="text-right">Actions</TH></TR></THead>
          <TBody>
            {rows.map((a) => (
              <TR key={a.id} data-testid="manage-article-row">
                <TD className="max-w-[22rem]">
                  <div className="flex flex-wrap items-center gap-1.5"><Badge tone="info">{HELP_KIND_LABEL[a.kind as HelpArticleKind]}</Badge>{a.builtin && <Badge tone="neutral">{a.customised ? 'Built-in, edited' : 'Built-in'}</Badge>}</div>
                  <Link href={`/help-content/articles/${a.id}`} className="mt-1 block truncate font-medium text-fg hover:text-accent" data-testid="manage-article-title">{a.title}</Link>
                  <span className="block truncate text-[11px] text-fg-subtle">{a.slug}{a.feature ? ` · ${a.feature}` : ''}{a.permission ? ` · ${a.permission}` : ''}</span>
                </TD>
                <TD className="text-xs">{a.categoryName}</TD>
                <TD className="text-xs">{levelText(a.audiences)}</TD>
                <TD><Badge tone={a.status === 'published' ? 'success' : 'neutral'} dot>{a.status === 'published' ? 'Published' : 'Draft'}</Badge></TD>
                <TD className="text-right tabular-nums">{a.views}</TD>
                <TD className="whitespace-nowrap text-right text-xs tabular-nums"><ThumbsUp className="inline size-3 text-success" aria-label="Yes" /> {a.yes} <ThumbsDown className="ml-1 inline size-3 text-danger" aria-label="No" /> {a.no}</TD>
                <TD className="text-right">
                  <div className="flex justify-end gap-1">
                    <Link href={`/help-content/articles/${a.id}`} className={buttonClass('ghost', 'sm', 'h-7 px-2')} aria-label={`Edit ${a.title}`}><Pencil className="size-3.5" /></Link>
                    <Button size="sm" variant="ghost" className="h-7 px-2" disabled={pending} onClick={() => run(() => articleStatusAction(a.id, a.status === 'published' ? 'draft' : 'published'))} aria-label={a.status === 'published' ? `Unpublish ${a.title}` : `Publish ${a.title}`} data-testid="toggle-publish">
                      {a.status === 'published' ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-danger" onClick={() => setDel(a)} aria-label={`Delete ${a.title}`}><Trash2 className="size-3.5" /></Button>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      {!rows.length && <EmptyState title="No articles match" />}
      <Confirm open={!!del} onClose={() => setDel(null)} pending={pending} title="Delete this article?" body={`“${del?.title}” disappears from Help & Support at every level.${del?.builtin ? ' It is built in: deleting it keeps it from coming back with updates.' : ''}`} onConfirm={() => del && run(() => deleteArticleAction(del.id), () => setDel(null))} />
    </Card>
  );
}

type CatForm = { key: string; name: string; description: string; icon: HelpIcon; parentId: string | null; audiences: HelpAudience[]; feature: string; sort: number; status: 'published' | 'draft' };
const emptyCat: CatForm = { key: '', name: '', description: '', icon: 'book', parentId: null, audiences: ['employee'], feature: '', sort: 100, status: 'published' };

export function AudiencePicker({ value, onChange }: { value: HelpAudience[]; onChange: (v: HelpAudience[]) => void }) {
  return (
    <fieldset className="grid gap-1.5" data-testid="audience-picker">
      <legend className="mb-1 text-sm font-medium text-fg">Who sees it</legend>
      <div className="grid grid-cols-2 gap-1.5">
        {HELP_AUDIENCES.map((l) => (
          <Checkbox key={l} label={HELP_AUDIENCE_LABEL[l]} checked={value.includes(l)} onChange={(e) => onChange(e.target.checked ? [...value, l] : value.filter((x) => x !== l))} data-testid={`audience-${l}`} />
        ))}
      </div>
      <span className="text-[11px] text-fg-subtle">A Super Workspace also sees HR and Employee Workspace content; an HR Workspace also sees Employee Workspace content. Everyone (public) is the Help & Support page anyone can open from the sign-in pages; signed-in people see it too.</span>
    </fieldset>
  );
}

function CategoriesTab({ data, run, pending }: { data: ManageData; run: Run; pending: boolean }) {
  const [edit, setEdit] = useState<{ id: string | null; form: CatForm } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [del, setDel] = useState<HelpCategoryView | null>(null);
  const top = data.categories.filter((c) => !c.parentId);
  const open = (c?: HelpCategoryView, parentId?: string) => {
    setErrors({});
    setEdit(c ? { id: c.id, form: { key: c.key, name: c.name, description: c.description, icon: c.icon, parentId: c.parentId, audiences: c.audiences, feature: c.feature ?? '', sort: c.sort, status: c.status } } : { id: null, form: { ...emptyCat, parentId: parentId ?? null } });
  };
  const set = (patch: Partial<CatForm>) => setEdit((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));
  const save = () => {
    if (!edit) return;
    run(async () => {
      const r = await saveCategoryAction(edit.id, { ...edit.form, feature: edit.form.feature || null } as never);
      if (!r.ok) setErrors(r.fieldErrors ?? {});
      return r;
    }, () => setEdit(null));
  };
  const row = (c: HelpCategoryView, sub: boolean) => (
    <li key={c.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-2.5', sub && 'pl-12')} data-testid="manage-category-row">
      <span className="text-xl" aria-hidden>{HELP_ICONS[c.icon] ?? HELP_ICONS.book}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg">{c.name}{c.status === 'draft' && <Badge tone="neutral">Hidden</Badge>}{c.builtin && <Badge tone="neutral">Built-in</Badge>}</span>
        <span className="block truncate text-[11px] text-fg-subtle">{c.key} · {levelText(c.audiences)}{c.feature ? ` · ${c.feature}` : ''} · {c.count} articles</span>
      </span>
      <div className="flex gap-1">
        {!sub && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => open(undefined, c.id)} data-testid="add-subcategory"><Plus className="size-3" aria-hidden />Subcategory</Button>}
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => open(c)} aria-label={`Edit ${c.name}`}><Pencil className="size-3.5" /></Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-danger" onClick={() => setDel(c)} aria-label={`Delete ${c.name}`}><Trash2 className="size-3.5" /></Button>
      </div>
    </li>
  );
  return (
    <Card className="p-0">
      <div className="flex items-center justify-between gap-2 border-b border-border p-3">
        <p className="text-xs text-fg-muted">Categories group articles on the help home page. A subcategory sits inside one category.</p>
        <Button size="sm" onClick={() => open()} data-testid="new-category"><Plus className="size-3.5" aria-hidden />New category</Button>
      </div>
      <ul className="divide-y divide-border">
        {top.map((c) => [row(c, false), ...data.categories.filter((s) => s.parentId === c.id).map((s) => row(s, true))])}
      </ul>
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit category' : edit?.form.parentId ? 'New subcategory' : 'New category'} size="lg"
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save} loading={pending} data-testid="save-category">Save</Button></>}>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required error={errors.name}>{(p) => <Input {...p} value={edit.form.name} onChange={(e) => set({ name: e.target.value, ...(edit.id ? {} : { key: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }) })} data-testid="category-name" />}</Field>
            <Field label="Key" required error={errors.key} hint="Used in the address: lower-case letters, numbers and dashes.">{(p) => <Input {...p} value={edit.form.key} onChange={(e) => set({ key: e.target.value })} data-testid="category-key" />}</Field>
            <Field label="Description" className="sm:col-span-2" error={errors.description}>{(p) => <Textarea {...p} rows={2} value={edit.form.description} onChange={(e) => set({ description: e.target.value })} />}</Field>
            <Field label="Parent category" error={errors.parentId}>{(p) => (
              <Select {...p} value={edit.form.parentId ?? ''} onChange={(e) => set({ parentId: e.target.value || null })}>
                <option value="">None (a top-level category)</option>
                {top.filter((c) => c.id !== edit.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            )}</Field>
            <Field label="Shown while this feature is on" hint="Leave empty to show it on every plan." error={errors.feature}>{(p) => (
              <Select {...p} value={edit.form.feature} onChange={(e) => set({ feature: e.target.value })}>
                <option value="">Every plan</option>
                {FEATURE_OPTIONS.map((f) => <option key={f.key} value={f.key}>{f.label} ({f.key})</option>)}
              </Select>
            )}</Field>
            <fieldset className="sm:col-span-2">
              <legend className="mb-1 text-sm font-medium text-fg">Icon</legend>
              <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Icon">
                {HELP_ICON_KEYS.map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={edit.form.icon === k} aria-label={k} onClick={() => set({ icon: k })} className={cn('flex size-9 items-center justify-center rounded-lg border text-lg', edit.form.icon === k ? 'border-accent bg-accent-subtle' : 'border-border hover:border-border-strong')}>{HELP_ICONS[k]}</button>
                ))}
              </div>
            </fieldset>
            <div className="sm:col-span-2"><AudiencePicker value={edit.form.audiences} onChange={(audiences) => set({ audiences })} />{errors.audiences && <span className="text-xs text-danger">{errors.audiences}</span>}</div>
            <Field label="Order" hint="Lower numbers come first.">{(p) => <Input {...p} type="number" min={0} max={10000} value={edit.form.sort} onChange={(e) => set({ sort: Number(e.target.value) })} />}</Field>
            <div className="flex items-end pb-2"><Switch checked={edit.form.status === 'published'} onChange={(v) => set({ status: v ? 'published' : 'draft' })} label="Shown in Help & Support" /></div>
          </div>
        )}
      </Dialog>
      <Confirm open={!!del} onClose={() => setDel(null)} pending={pending} title="Delete this category?" body={`“${del?.name}” must be empty (move or delete its articles and subcategories first).`} onConfirm={() => del && run(() => deleteCategoryAction(del.id), () => setDel(null))} />
    </Card>
  );
}

type QcForm = { key: string; label: string; description: string; toConsole: boolean; active: boolean; sort: number };

function QueryCategoriesTab({ items, run, pending }: { items: HelpQueryCategoryView[]; run: Run; pending: boolean }) {
  const [edit, setEdit] = useState<{ id: string | null; form: QcForm } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [del, setDel] = useState<HelpQueryCategoryView | null>(null);
  const set = (patch: Partial<QcForm>) => setEdit((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));
  const save = () => {
    if (!edit) return;
    run(async () => {
      const r = await saveQueryCategoryAction(edit.id, edit.form);
      if (!r.ok) setErrors(r.fieldErrors ?? {});
      return r;
    }, () => setEdit(null));
  };
  return (
    <Card className="p-0">
      <div className="flex items-center justify-between gap-2 border-b border-border p-3">
        <p className="text-xs text-fg-muted">The choices on the Raise a Query form. Other is always last and cannot be removed. A SampCrew category goes straight to SampCrew Support.</p>
        <Button size="sm" onClick={() => { setErrors({}); setEdit({ id: null, form: { key: '', label: '', description: '', toConsole: false, active: true, sort: 100 } }); }} data-testid="new-query-category"><Plus className="size-3.5" aria-hidden />New query category</Button>
      </div>
      <ul className="divide-y divide-border">
        {items.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5" data-testid="manage-query-category-row">
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg">{c.label}{c.toConsole && <Badge tone="ember">To SampCrew Support</Badge>}{!c.active && <Badge tone="neutral">Hidden</Badge>}</span>
              <span className="block truncate text-[11px] text-fg-subtle">{c.key}{c.description ? ` · ${c.description}` : ''}</span>
            </span>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => { setErrors({}); setEdit({ id: c.id, form: { key: c.key, label: c.label, description: c.description, toConsole: c.toConsole, active: c.active, sort: c.sort } }); }} aria-label={`Edit ${c.label}`}><Pencil className="size-3.5" /></Button>
            {c.key !== HELP_OTHER_CATEGORY && <Button size="sm" variant="ghost" className="h-7 px-2 text-danger" onClick={() => setDel(c)} aria-label={`Delete ${c.label}`}><Trash2 className="size-3.5" /></Button>}
          </li>
        ))}
      </ul>
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit query category' : 'New query category'}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save} loading={pending} data-testid="save-query-category">Save</Button></>}>
        {edit && (
          <div className="grid gap-3">
            <Field label="Label" required error={errors.label}>{(p) => <Input {...p} value={edit.form.label} onChange={(e) => set({ label: e.target.value, ...(edit.id ? {} : { key: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }) })} data-testid="query-category-label" />}</Field>
            <Field label="Key" required error={errors.key}>{(p) => <Input {...p} value={edit.form.key} disabled={edit.form.key === HELP_OTHER_CATEGORY && !!edit.id} onChange={(e) => set({ key: e.target.value })} />}</Field>
            <Field label="Description" error={errors.description}>{(p) => <Textarea {...p} rows={2} value={edit.form.description} onChange={(e) => set({ description: e.target.value })} />}</Field>
            <Field label="Order" hint="Lower numbers come first (Other always last).">{(p) => <Input {...p} type="number" min={0} max={10000} value={edit.form.sort} onChange={(e) => set({ sort: Number(e.target.value) })} />}</Field>
            <Switch checked={edit.form.toConsole} onChange={(v) => set({ toConsole: v })} label="Send to SampCrew Support (Console Admin team)" testId="query-category-to-console" />
            <Switch checked={edit.form.active} onChange={(v) => set({ active: v })} label="Shown on the form" />
          </div>
        )}
      </Dialog>
      <Confirm open={!!del} onClose={() => setDel(null)} pending={pending} title="Delete this query category?" body={`“${del?.label}” leaves the form. Queries already raised keep it.`} onConfirm={() => del && run(() => deleteQueryCategoryAction(del.id), () => setDel(null))} />
    </Card>
  );
}

function SettingsTab({ settings, run, pending }: { settings: HelpSettings; run: Run; pending: boolean }) {
  const [s, setS] = useState(settings);
  return (
    <Card className="grid max-w-2xl gap-4 p-5" data-testid="help-settings">
      <Field label="Welcome text" hint="Shown under the heading on every Help & Support home page.">{(p) => <Textarea {...p} rows={2} maxLength={300} value={s.welcome} onChange={(e) => setS({ ...s, welcome: e.target.value })} data-testid="settings-welcome" />}</Field>
      <Field label="Days a resolved query can be reopened" hint="The person who raised it can reopen it for this many days after it is resolved. 0 turns reopening off.">{(p) => <Input {...p} type="number" min={0} max={365} value={s.reopenDays} onChange={(e) => setS({ ...s, reopenDays: Number(e.target.value) })} data-testid="settings-reopen-days" />}</Field>
      <Switch checked={s.attachments} onChange={(v) => setS({ ...s, attachments: v })} label="Allow attachments on queries and replies" testId="settings-attachments" />
      <Switch checked={s.escalation} onChange={(v) => setS({ ...s, escalation: v })} label="Allow escalation to the level above (HR Workspace to Super Workspace to SampCrew Support)" testId="settings-escalation" />
      <div><Button onClick={() => run(() => saveHelpSettingsAction(s))} loading={pending} data-testid="save-settings">Save settings</Button></div>
      <p className="text-xs text-fg-muted">Which companies have Help &amp; Support, and which parts (guides, Raise a Query, the answering inbox), is set in Feature management, per company and plan.</p>
    </Card>
  );
}

function InsightsTab({ insights }: { insights: HelpInsights }) {
  const q = insights.queries;
  return (
    <div className="grid gap-4" data-testid="help-insights">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Queries" value={q.total} />
        <Stat label="Open" value={q.open} />
        <Stat label="In Progress" value={q.inProgress} />
        <Stat label="Awaiting User" value={q.awaiting} />
        <Stat label="Resolved" value={q.resolved} />
        <Stat label="Closed" value={q.closed} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card className="p-0">
          <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Most viewed articles</h2>
          <Table>
            <THead><TR><TH>Article</TH><TH className="text-right">Views</TH><TH className="text-right">Helpful</TH><TH className="text-right">Not helpful</TH></TR></THead>
            <TBody>{insights.articles.map((a) => <TR key={a.id}><TD>{a.title} <span className="text-[11px] text-fg-subtle">{HELP_KIND_LABEL[a.kind]}</span></TD><TD className="text-right tabular-nums">{a.views}</TD><TD className="text-right tabular-nums">{a.yes}</TD><TD className="text-right tabular-nums">{a.no}</TD></TR>)}</TBody>
          </Table>
          {!insights.articles.length && <EmptyState title="No views yet" />}
        </Card>
        <Card className="p-0">
          <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Queries by category</h2>
          <ul className="divide-y divide-border">{insights.topCategories.map((c) => <li key={c.key} className="flex justify-between px-4 py-2 text-sm"><span>{c.label}</span><span className="tabular-nums text-fg-muted">{c.count}</span></li>)}</ul>
          {!insights.topCategories.length && <EmptyState title="No queries yet" />}
        </Card>
      </div>
    </div>
  );
}
