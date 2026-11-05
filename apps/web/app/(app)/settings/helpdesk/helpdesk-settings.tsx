'use client';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { useRunner } from '../../recruitment/use-runner';
import { archiveCategoryAction, articleAction, deleteArticleAction, saveArticleAction, saveCategoryAction } from '../../helpdesk/actions';
import { hours } from '../../helpdesk/labels';
import type { Article, Category, Handler } from '../../helpdesk/types';

export function HelpdeskSettings({ categories, handlers, articles }: { categories: Category[]; handlers: Handler[]; articles: Article[] }) {
  const { pending, notice, run } = useRunner();
  const [cat, setCat] = useState<Category | 'new' | null>(null);
  const [art, setArt] = useState<Article | 'new' | null>(null);
  const live = categories.filter((c) => !c.archivedAt);
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader title="Categories" description="New cases go to the category's first handler with the fewest open cases. Without handlers, anyone who can handle cases for that person picks them up." action={<Button size="sm" onClick={() => setCat('new')}>Add category</Button>} />
        <Table>
          <THead><tr><TH>Category</TH><TH>First reply</TH><TH>Resolution</TH><TH>Handlers</TH><TH /></tr></THead>
          <TBody>
            {categories.map((c) => (
              <TR key={c.id} className={c.archivedAt ? 'opacity-60' : undefined}>
                <TD>
                  <span className="font-medium">{c.name}</span>
                  {c.confidential && <Badge tone="warning" className="ml-2">Confidential</Badge>}
                  {c.archivedAt && <Badge className="ml-2">Archived</Badge>}
                  <div className="text-xs text-fg-muted">{c.description}</div>
                </TD>
                <TD>{hours(c.firstResponseHours)}</TD>
                <TD>{hours(c.resolutionHours)}</TD>
                <TD className="text-fg-muted">{c.handlers?.map((h) => h.name).join(', ') || 'Anyone in scope'}</TD>
                <TD className="whitespace-nowrap text-right">
                  {!c.archivedAt && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setCat(c)}>Edit</Button>
                      <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm(`Archive "${c.name}"? Existing cases keep it.`) && run(() => archiveCategoryAction(c.id))}>Archive</Button>
                    </>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Help articles" description="Shown to people as they write their question, and on the Ask HR page." action={<Button size="sm" onClick={() => setArt('new')}>Write article</Button>} />
        <Table>
          <THead><tr><TH>Article</TH><TH>Category</TH><TH>State</TH><TH /></tr></THead>
          <TBody>
            {articles.length === 0 && <TR><TD colSpan={4} className="text-fg-muted">No articles yet.</TD></TR>}
            {articles.map((a) => (
              <TR key={a.id}>
                <TD className="font-medium">{a.title}</TD>
                <TD className="text-fg-muted">{a.categoryName ?? 'All categories'}</TD>
                <TD><Badge tone={a.published ? 'success' : 'neutral'}>{a.published ? 'Published' : 'Draft'}</Badge></TD>
                <TD className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setArt(a)}>Edit</Button>
                  <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm(`Delete "${a.title}"?`) && run(() => deleteArticleAction(a.id))}>Delete</Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      {cat && <CategoryDialog key={cat === 'new' ? 'new' : cat.id} category={cat === 'new' ? null : cat} handlers={handlers} onClose={() => setCat(null)} />}
      {art && <ArticleDialog key={art === 'new' ? 'new' : art.id} article={art === 'new' ? null : art} categories={live} onClose={() => setArt(null)} />}
    </div>
  );
}

function useSave() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const save = (fn: () => Promise<{ ok: boolean; message?: string; fieldErrors?: Record<string, string> }>, onDone: () => void) =>
    start(async () => {
      setError(null);
      setFe({});
      const r = await fn();
      if (r.ok) {
        onDone();
        router.refresh();
      } else {
        setError(r.message ?? 'Could not save.');
        setFe(r.fieldErrors ?? {});
      }
    });
  return { pending, error, fe, save };
}

const num = (v: FormDataEntryValue | null) => (String(v ?? '').trim() === '' ? null : Number(v));

function CategoryDialog({ category, handlers, onClose }: { category: Category | null; handlers: Handler[]; onClose: () => void }) {
  const { pending, error, fe, save } = useSave();
  const [picked, setPicked] = useState<string[]>(category?.handlers?.map((h) => h.membershipId) ?? []);
  const [confidential, setConfidential] = useState(category?.confidential ?? false);
  return (
    <Dialog open onClose={onClose} title={category ? `Edit ${category.name}` : 'Add category'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="category-form" loading={pending}>Save</Button></>}>
      <form id="category-form" className="grid grid-cols-2 gap-4" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        save(() => saveCategoryAction(category?.id ?? null, {
          name: f.get('name'), description: f.get('description'), confidential,
          firstResponseHours: num(f.get('firstResponseHours')), resolutionHours: num(f.get('resolutionHours')), handlerMembershipIds: picked,
        }), onClose);
      }}>
        {error && <Alert tone="danger" className="col-span-2">{error}</Alert>}
        <Field label="Name" required error={fe.name} className="col-span-2">{(p) => <Input {...p} name="name" required defaultValue={category?.name} maxLength={80} />}</Field>
        <Field label="Description" error={fe.description} className="col-span-2">{(p) => <Textarea {...p} name="description" rows={2} defaultValue={category?.description} maxLength={500} />}</Field>
        <Field label="First reply within (hours)" hint="Empty for no target" error={fe.firstResponseHours}>{(p) => <Input {...p} name="firstResponseHours" type="number" min={1} max={2160} defaultValue={category ? category.firstResponseHours ?? '' : 24} />}</Field>
        <Field label="Resolve within (hours)" hint="Calendar hours" error={fe.resolutionHours}>{(p) => <Input {...p} name="resolutionHours" type="number" min={1} max={2160} defaultValue={category ? category.resolutionHours ?? '' : 120} />}</Field>
        <div className="col-span-2">
          <Checkbox label="Confidential" description="For example grievances. Only the handlers named below and the person who raised it can see these cases; viewing them is recorded in the audit trail." checked={confidential} onChange={(e) => setConfidential(e.target.checked)} />
        </div>
        <fieldset className="col-span-2 grid gap-1.5">
          <legend className="mb-1 text-[0.8125rem] font-medium">Handlers{confidential && <span className="text-danger"> *</span>}</legend>
          {handlers.length === 0 && <p className="text-xs text-fg-muted">Nobody has a role that can handle cases yet.</p>}
          {handlers.map((h) => (
            <Checkbox key={h.membershipId} label={h.name} description={h.scope === 'tenant' ? 'Whole organization' : 'Their legal entity'} checked={picked.includes(h.membershipId)}
              onChange={(e) => setPicked((x) => (e.target.checked ? [...x, h.membershipId] : x.filter((i) => i !== h.membershipId)))} />
          ))}
          {fe.handlerMembershipIds && <p className="text-xs text-danger">{fe.handlerMembershipIds}</p>}
        </fieldset>
      </form>
    </Dialog>
  );
}

function ArticleDialog({ article, categories, onClose }: { article: Article | null; categories: Category[]; onClose: () => void }) {
  const { pending, error, fe, save } = useSave();
  const [published, setPublished] = useState(article?.published ?? true);
  return (
    <Dialog open onClose={onClose} title={article ? 'Edit article' : 'Write article'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="article-form" loading={pending}>Save</Button></>}>
      <form id="article-form" className="grid gap-4" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        save(() => saveArticleAction(article?.id ?? null, { title: f.get('title'), body: f.get('body'), categoryId: f.get('categoryId') || null, published }), onClose);
      }}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Title" required error={fe.title}>{(p) => <Input {...p} name="title" required maxLength={200} defaultValue={article?.title} />}</Field>
        <Field label="Category" error={fe.categoryId}>{(p) => <Select {...p} name="categoryId" defaultValue={article?.categoryId ?? ''}><option value="">All categories</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        <ArticleBody id={article?.id} error={fe.body} />
        <Checkbox label="Published" description="Drafts are visible only here." checked={published} onChange={(e) => setPublished(e.target.checked)} />
      </form>
    </Dialog>
  );
}

/** The list holds an excerpt only, so the full text is fetched when editing. */
function ArticleBody({ id, error }: { id?: string; error?: string }) {
  const [body, setBody] = useState<string | null>(id ? null : '');
  useEffect(() => {
    if (!id) return;
    void articleAction(id).then((r) => setBody(r.ok ? r.data?.body ?? '' : ''));
  }, [id]);
  return (
    <Field label="Text" required error={error} hint="Plain text. Keep it short and practical.">
      {(p) => <Textarea {...p} name="body" rows={10} required minLength={10} maxLength={20000} value={body ?? ''} disabled={body === null} onChange={(e) => setBody(e.target.value)} />}
    </Field>
  );
}
