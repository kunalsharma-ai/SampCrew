'use client';
import { HELP_ARTICLE_KINDS, HELP_ICONS, HELP_ICON_KEYS, HELP_KIND_LABEL, type HelpArticleKind, type HelpIcon, type HelpAudience, type HelpCategoryView, type HelpStep } from '@crew/contracts';
import { Alert, Button, Card, Field, HelpBody, Input, Select, Switch, Textarea, buttonClass } from '@crew/ui';
import { ArrowDown, ArrowUp, Eye, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteArticleAction, saveArticleAction } from '../../../help/actions';
import { AudiencePicker, FEATURE_OPTIONS, PERMISSION_OPTIONS } from '../../manager';

export interface EditableArticle {
  id: string; slug: string; categoryId: string; kind: HelpArticleKind; title: string; summary: string; body: string; steps: HelpStep[]; audiences: HelpAudience[];
  feature: string | null; permission: string | null; keywords: string[]; href: string | null; videoUrl: string | null; imageUrl: string | null; related: string[];
  icon: HelpIcon | null; sort: number; status: 'published' | 'draft'; builtin: boolean; customised: boolean; updatedAt: string;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** The article editor: text, steps (for guides, tutorials and quick starts), links, media, visibility and publishing. */
export function ArticleEditor({ article, categories, slugs, startKind, startPublic }: { article: EditableArticle | null; categories: HelpCategoryView[]; slugs: { slug: string; title: string }[]; startKind?: HelpArticleKind; startPublic?: boolean }) {
  // A public piece starts in a public category (Our features for a feature brief).
  const publicCats = categories.filter((c) => c.audiences.includes('public'));
  const startCat = startPublic ? (publicCats.find((c) => startKind === 'feature' ? c.key === 'our-features' : c.key !== 'our-features') ?? publicCats[0]) : undefined;
  const router = useRouter();
  const [a, setA] = useState(() => ({
    slug: article?.slug ?? '', categoryId: article?.categoryId ?? startCat?.id ?? categories[0]?.id ?? '', kind: article?.kind ?? startKind ?? ('faq' as HelpArticleKind), title: article?.title ?? '',
    summary: article?.summary ?? '', body: article?.body ?? '', steps: article?.steps ?? ([] as HelpStep[]), audiences: article?.audiences ?? ((startPublic ? ['public'] : ['employee']) as HelpAudience[]),
    feature: article?.feature ?? '', permission: article?.permission ?? '', keywords: (article?.keywords ?? []).join(', '), href: article?.href ?? '',
    videoUrl: article?.videoUrl ?? '', imageUrl: article?.imageUrl ?? '', related: (article?.related ?? []).join(', '), icon: (article?.icon ?? '') as HelpIcon | '', sort: article?.sort ?? 100, status: article?.status ?? ('draft' as 'published' | 'draft'),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [pending, start] = useTransition();
  const set = (patch: Partial<typeof a>) => setA((cur) => ({ ...cur, ...patch }));
  const step = (i: number, patch: Partial<HelpStep>) => set({ steps: a.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, d: -1 | 1) => { const s = [...a.steps]; const [x] = s.splice(i, 1); s.splice(i + d, 0, x!); set({ steps: s }); };
  const save = (status?: 'published' | 'draft') => {
    setError(null);
    start(async () => {
      const input = {
        ...a, status: status ?? a.status, feature: a.feature || null, permission: a.permission || null, keywords: list(a.keywords), related: list(a.related),
        icon: a.icon || null, href: a.href || null, videoUrl: a.videoUrl || null, imageUrl: a.imageUrl || null, steps: a.steps.map((s) => ({ ...s, href: s.href || null })),
      };
      const r = await saveArticleAction(article?.id ?? null, input as never);
      if (r.ok) { router.push('/help-content?tab=articles'); router.refresh(); } else { setError(r.message); setErrors(r.fieldErrors ?? {}); }
    });
  };
  const stepped = ['guide', 'tutorial', 'quickstart'].includes(a.kind) || a.steps.length > 0;
  const isPublic = a.audiences.includes('public');
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]" data-testid="article-editor">
      <Card className="grid gap-4 p-5">
        {article?.builtin && <Alert tone="info">This is a built-in article. Your changes are kept when SampCrew updates the built-in library.</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title" required error={errors.title} className="sm:col-span-2">{(p) => <Input {...p} value={a.title} onChange={(e) => set({ title: e.target.value, ...(article ? {} : { slug: slugify(e.target.value) }) })} data-testid="article-title" />}</Field>
          <Field label="Kind" required>{(p) => <Select {...p} value={a.kind} onChange={(e) => set({ kind: e.target.value as HelpArticleKind })} data-testid="article-kind">{HELP_ARTICLE_KINDS.map((k) => <option key={k} value={k}>{HELP_KIND_LABEL[k]}</option>)}</Select>}</Field>
          <Field label="Category" required error={errors.categoryId}>{(p) => <Select {...p} value={a.categoryId} onChange={(e) => set({ categoryId: e.target.value })} data-testid="article-category">{categories.map((c) => <option key={c.id} value={c.id}>{c.parentId ? '· ' : ''}{c.name}</option>)}</Select>}</Field>
          <Field label="Address (slug)" required error={errors.slug} hint="Lower-case letters, numbers and dashes.">{(p) => <Input {...p} value={a.slug} onChange={(e) => set({ slug: e.target.value })} data-testid="article-slug" />}</Field>
          <Field label="Card icon" hint="Shown on feature and article cards; others use their category's." error={errors.icon}>{(p) => (
            <Select {...p} value={a.icon} onChange={(e) => set({ icon: e.target.value as HelpIcon | '' })} data-testid="article-icon">
              <option value="">Category icon</option>
              {HELP_ICON_KEYS.map((k) => <option key={k} value={k}>{HELP_ICONS[k]} {k}</option>)}
            </Select>
          )}</Field>
          <Field label="Order" hint="Lower numbers come first.">{(p) => <Input {...p} type="number" min={0} max={10000} value={a.sort} onChange={(e) => set({ sort: Number(e.target.value) })} />}</Field>
          <Field label="Summary" className="sm:col-span-2" hint="One or two sentences shown in lists and search results." error={errors.summary}>{(p) => <Textarea {...p} rows={2} value={a.summary} onChange={(e) => set({ summary: e.target.value })} data-testid="article-summary" />}</Field>
        </div>
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between"><span className="text-sm font-medium text-fg">Answer or explanation</span><Button size="sm" variant="ghost" onClick={() => setPreview(!preview)}><Eye className="size-3.5" aria-hidden />{preview ? 'Edit' : 'Preview'}</Button></div>
          {preview ? <div className="rounded-lg border border-border p-4"><HelpBody text={a.body || 'Nothing written yet.'} /></div>
            : <Textarea aria-label="Answer or explanation" rows={10} value={a.body} onChange={(e) => set({ body: e.target.value })} data-testid="article-body" />}
          <span className="text-[11px] text-fg-subtle">Separate paragraphs with a blank line. Start lines with “- ” for a list or “1. ” for numbered points. **Bold** works.</span>
          {errors.body && <span className="text-xs text-danger">{errors.body}</span>}
        </div>
        {stepped && (
          <section className="grid gap-2" data-testid="article-steps">
            <div className="flex items-center justify-between"><h2 className="text-sm font-medium text-fg">Steps</h2><Button size="sm" variant="secondary" onClick={() => set({ steps: [...a.steps, { title: '', body: '', href: null }] })} data-testid="add-step"><Plus className="size-3.5" aria-hidden />Add step</Button></div>
            {!a.steps.length && <p className="text-xs text-fg-muted">Guides, tutorials and quick starts show numbered steps the reader can tick off.</p>}
            {a.steps.map((s, i) => (
              <div key={i} className="grid gap-2 rounded-lg border border-border p-3" data-testid="step-row">
                <div className="flex items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded-full bg-accent-subtle text-xs font-semibold text-accent">{i + 1}</span>
                  <Input aria-label={`Step ${i + 1} title`} placeholder="Step title" value={s.title} onChange={(e) => step(i, { title: e.target.value })} className="h-8 flex-1" data-testid="step-title" />
                  <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="size-3.5" /></Button>
                  <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={i === a.steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="size-3.5" /></Button>
                  <Button size="sm" variant="ghost" className="h-7 px-1.5 text-danger" onClick={() => set({ steps: a.steps.filter((_, j) => j !== i) })} aria-label="Remove step"><Trash2 className="size-3.5" /></Button>
                </div>
                <Textarea aria-label={`Step ${i + 1} text`} rows={2} placeholder="What to do" value={s.body} onChange={(e) => step(i, { body: e.target.value })} />
                <Input aria-label={`Step ${i + 1} page`} placeholder="Page to open, such as /leave (optional)" value={s.href ?? ''} onChange={(e) => step(i, { href: e.target.value })} className="h-8" />
              </div>
            ))}
            {errors.steps && <span className="text-xs text-danger">{errors.steps}</span>}
          </section>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => save('published')} loading={pending} data-testid="article-publish">Save and publish</Button>
          <Button variant="secondary" onClick={() => save('draft')} loading={pending} data-testid="article-draft">Save as draft</Button>
          <Link href="/help-content?tab=articles" className={buttonClass('ghost', 'md')}>Cancel</Link>
          {article && <Button variant="ghost" className="ml-auto text-danger" disabled={pending} onClick={() => start(async () => { const r = await deleteArticleAction(article.id); if (r.ok) router.push('/help-content?tab=articles'); else setError(r.message); })}><Trash2 className="size-3.5" aria-hidden />Delete</Button>}
        </div>
      </Card>
      <div className="grid h-fit gap-4">
        <Card className="grid gap-3 p-4">
          <h2 className="text-sm font-semibold">Who sees it</h2>
          <AudiencePicker value={a.audiences} onChange={(audiences) => set({ audiences })} />
          {errors.audiences && <span className="text-xs text-danger">{errors.audiences}</span>}
          {isPublic && <Alert tone="info" data-testid="public-note">Everyone can read this on the public Help & Support page, before signing in. Leave Module and Permission empty, or it stays hidden there.</Alert>}
          <Field label="Module or feature" hint="Shown only while it is switched on for the person." error={errors.feature}>{(p) => (
            <Select {...p} value={a.feature} onChange={(e) => set({ feature: e.target.value })} data-testid="article-feature">
              <option value="">Every plan</option>
              {FEATURE_OPTIONS.map((f) => <option key={f.key} value={f.key}>{f.label} ({f.key})</option>)}
            </Select>
          )}</Field>
          <Field label="Permission" hint="Shown only to people who hold it (any scope)." error={errors.permission}>{(p) => (
            <Select {...p} value={a.permission} onChange={(e) => set({ permission: e.target.value })} data-testid="article-permission">
              <option value="">Anyone at the levels above</option>
              {PERMISSION_OPTIONS.map((x) => <option key={x.key} value={x.key}>{x.key}: {x.label}</option>)}
            </Select>
          )}</Field>
          <Switch checked={a.status === 'published'} onChange={(v) => set({ status: v ? 'published' : 'draft' })} label="Published" />
        </Card>
        <Card className="grid gap-3 p-4">
          <h2 className="text-sm font-semibold">Links, media and search</h2>
          <Field label="Page it is about" hint="Opens from “Go to this page”, such as /leave." error={errors.href}>{(p) => <Input {...p} value={a.href} onChange={(e) => set({ href: e.target.value })} data-testid="article-href" />}</Field>
          <Field label="Video link" hint="An https:// link, such as a YouTube or Vimeo video." error={errors.videoUrl}>{(p) => <Input {...p} value={a.videoUrl} onChange={(e) => set({ videoUrl: e.target.value })} />}</Field>
          <Field label="Image or screenshot link" hint="An https:// link to a picture shown in the article." error={errors.imageUrl}>{(p) => <Input {...p} value={a.imageUrl} onChange={(e) => set({ imageUrl: e.target.value })} />}</Field>
          <Field label="Search words" hint="Comma separated: other names, error messages people may type." error={errors.keywords}>{(p) => <Textarea {...p} rows={2} value={a.keywords} onChange={(e) => set({ keywords: e.target.value })} data-testid="article-keywords" />}</Field>
          <Field label="Related articles" hint="Comma separated article addresses (slugs)." error={errors.related}>{(p) => <Input {...p} list="help-slugs" value={a.related} onChange={(e) => set({ related: e.target.value })} />}</Field>
          <datalist id="help-slugs">{slugs.map((s) => <option key={s.slug} value={s.slug}>{s.title}</option>)}</datalist>
        </Card>
      </div>
    </div>
  );
}
