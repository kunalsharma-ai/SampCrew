import { Injectable } from '@nestjs/common';
import {
  HELP_AUDIENCE_LABEL,
  HELP_ARTICLE_KINDS,
  HELP_DEFAULT_SETTINGS,
  HELP_OTHER_CATEGORY,
  helpAudiencesFor,
  type HelpArticleInput,
  type HelpArticleKind,
  type HelpArticleSummary,
  type HelpArticleView,
  type HelpAudience,
  type HelpCategoryInput,
  type HelpCategoryView,
  type HelpHome,
  type HelpIcon,
  type HelpInsights,
  type HelpQueryCategoryInput,
  type HelpQueryCategoryView,
  type HelpSearchQuery,
  type HelpSearchResult,
  type HelpSettings,
  type HelpStep,
  type PublicHelpArticle,
  type PublicHelpEntry,
  type PublicHelpHome,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantsFor, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type AnyTx, type PlatformTx, type TenantTx } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Who is looking: their level and what lets them see an article (features and permissions). */
export interface HelpViewer {
  level: HelpAudience;
  audiences: HelpAudience[];
  /** null for a Console Admin: every feature and permission counts as held. */
  features: Set<string> | null;
  subject: Subject | null;
}

/** Whether a viewer may see an item with these audiences, feature and permission. */
export function visibleTo(v: HelpViewer, item: { audiences?: string[] | null; feature?: string | null; permission?: string | null; status?: string; deleted_at?: unknown }): boolean {
  if (item.deleted_at || item.status !== 'published') return false;
  if (!(item.audiences ?? []).some((a) => v.audiences.includes(a as HelpAudience))) return false;
  if (v.features && item.feature && !v.features.has(item.feature)) return false;
  // A permission counts when the person holds any grant of it (pages that need two-step verification ask for it there).
  if (v.subject && item.permission && !grantsFor(v.subject, item.permission).length) return false;
  return true;
}

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s_-]/gu, ' ').split(/[\s_-]+/).filter((w) => w.length > 1);
const STOP = new Set(['the', 'and', 'for', 'how', 'can', 'what', 'why', 'does', 'do', 'is', 'my', 'to', 'of', 'in', 'on', 'an', 'it', 'me', 'we', 'our', 'with', 'where', 'who', 'when', 'are', 'am', 'be', 'this', 'that', 'there', 'from']);

/**
 * Search score of an article for a question: words found in the title count most, then keywords and the category,
 * then the summary, then the body and steps. A word matches the start of a word ("approv" finds "approval"), and the
 * whole phrase in the title or keywords adds a bonus, so error messages and feature names find their article.
 */
/** Quick starts in the order of the levels the viewer covers (own level first, then the levels below), one each. */
function quickstartsFor(v: HelpViewer, list: Doc[]): Doc[] {
  const out: Doc[] = [];
  for (const level of v.audiences) {
    const pick = list.filter((a) => (a.audiences ?? []).includes(level) && !out.includes(a)).sort((x, y) => Number((x.audiences ?? []).length) - Number((y.audiences ?? []).length) || (x.sort ?? 0) - (y.sort ?? 0))[0];
    if (pick) out.push(pick);
  }
  return out.slice(0, 3);
}

export function scoreArticle(a: { title: string; summary: string; body: string; keywords: string[]; steps: { title: string; body: string }[] }, category: string, q: string): number {
  const phrase = q.trim().toLowerCase();
  const terms = [...new Set(words(q).filter((w) => !STOP.has(w)))];
  if (!terms.length && !phrase) return 0;
  const fields: [string[], number][] = [
    [words(a.title), 6],
    [a.keywords.flatMap(words), 5],
    [words(category), 3],
    [words(a.summary), 2],
    [words(`${a.body} ${a.steps.map((s) => `${s.title} ${s.body}`).join(' ')}`), 1],
  ];
  let score = 0;
  let matched = 0;
  for (const t of terms) {
    let best = 0;
    for (const [list, weight] of fields) {
      if (list.some((w) => w === t)) best = Math.max(best, weight * 2);
      else if (t.length >= 3 && list.some((w) => w.startsWith(t))) best = Math.max(best, weight);
    }
    if (best) matched += 1;
    score += best;
  }
  if (terms.length && !matched) return 0;
  // Every word found counts more than many hits of one word.
  score *= terms.length ? matched / terms.length : 1;
  if (phrase.length >= 4) {
    if (a.title.toLowerCase().includes(phrase)) score += 20;
    if (a.keywords.some((k) => k.toLowerCase().includes(phrase) || phrase.includes(k.toLowerCase()))) score += 12;
    if (a.body.toLowerCase().includes(phrase)) score += 4;
  }
  return Math.round(score * 10) / 10;
}

/** A short piece of the text around the first word found, for search results. */
function snippet(a: Doc, q: string): string {
  const text = [a.summary, a.body, ...(a.steps as HelpStep[]).map((s) => `${s.title}: ${s.body}`)].filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const terms = words(q).filter((w) => !STOP.has(w));
  const low = text.toLowerCase();
  const at = terms.map((t) => low.indexOf(t)).filter((i) => i >= 0).sort((x, y) => x - y)[0] ?? 0;
  const start = Math.max(0, at - 60);
  return `${start ? '…' : ''}${text.slice(start, start + 220).trim()}${text.length > start + 220 ? '…' : ''}`;
}

function settingsView(row: Doc | undefined): HelpSettings {
  if (!row) return { ...HELP_DEFAULT_SETTINGS };
  return { attachments: row.attachments !== false, reopenDays: (row.reopen_days as number) ?? 14, escalation: row.escalation !== false, welcome: (row.welcome as string) || HELP_DEFAULT_SETTINGS.welcome };
}

/**
 * Help & Support content: the help centre each person sees (filtered on the server by level, features and
 * permissions), search, articles with "Was this helpful?" and tutorial progress, and the Console's content manager.
 */
@Injectable()
export class HelpContentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------------------------------- the viewer

  /** The level of a workspace member: Super Workspace, HR Workspace (any grant) or Employee Workspace. */
  static levelOf(subject: Subject): Exclude<HelpAudience, 'console' | 'public'> {
    if (subject.grants.some((g) => g.roleKey === 'super_workspace')) return 'super';
    if (subject.grants.some((g) => g.roleKey === 'hr_workspace')) return 'hr';
    return 'employee';
  }

  async tenantViewer(tx: TenantTx): Promise<HelpViewer> {
    const subject = await this.authz.subject(tx);
    const ent = await this.entitlements.current(tx);
    const level = HelpContentService.levelOf(subject);
    return { level, audiences: helpAudiencesFor(level), features: ent.features, subject };
  }

  consoleViewer(): HelpViewer {
    return { level: 'console', audiences: ['console'], features: null, subject: null };
  }

  /** Someone who has not signed in: only content with the public audience (no feature or permission can be held). */
  publicViewer(): HelpViewer {
    return { level: 'public', audiences: ['public'], features: new Set<string>(), subject: null };
  }

  // ------------------------------------------------------------------------------------------- loading

  private async load(tx: AnyTx) {
    // One after the other: a transaction's session cannot run two commands at once.
    const cats = await tx.collection('help_categories').find({ deleted_at: null }, { sort: { sort: 1, name: 1 } });
    const arts = await tx.collection('help_articles').find({ deleted_at: null }, { sort: { sort: 1, title: 1 } });
    return { cats, arts };
  }

  /** The categories and articles the viewer may see. A category hidden from them hides its articles too. */
  private async visible(tx: AnyTx, v: HelpViewer) {
    const { cats, arts } = await this.load(tx);
    const byId = new Map(cats.map((c) => [c.id as string, c]));
    const catOk = (c: Doc | undefined): boolean => !!c && visibleTo(v, c) && (!c.parent_id || catOk(byId.get(c.parent_id)));
    const okCats = cats.filter(catOk);
    const okIds = new Set(okCats.map((c) => c.id as string));
    const okArts = arts.filter((a) => okIds.has(a.category_id) && visibleTo(v, a));
    return { cats: okCats, arts: okArts, byId };
  }

  private summary(a: Doc, byId: Map<string, Doc>): HelpArticleSummary {
    const c = byId.get(a.category_id);
    return {
      id: a.id, slug: a.slug, categoryId: a.category_id, categoryKey: (c?.key as string) ?? '', categoryName: (c?.name as string) ?? '',
      kind: a.kind as HelpArticleKind, title: a.title, summary: a.summary ?? '', audiences: a.audiences ?? [], href: a.href ?? null,
      hasVideo: !!a.video_url, steps: (a.steps as unknown[] | undefined)?.length ?? 0,
      icon: ((a.icon as HelpIcon | null) ?? (c?.icon as HelpIcon | undefined)) || 'book',
    };
  }

  private categoryViews(cats: Doc[], arts: Doc[]): HelpCategoryView[] {
    const direct = new Map<string, number>();
    for (const a of arts) direct.set(a.category_id, (direct.get(a.category_id) ?? 0) + 1);
    const children = new Map<string, string[]>();
    for (const c of cats) if (c.parent_id) children.set(c.parent_id, [...(children.get(c.parent_id) ?? []), c.id]);
    const total = (id: string): number => (direct.get(id) ?? 0) + (children.get(id) ?? []).reduce((n, k) => n + total(k), 0);
    return cats.map((c) => ({
      id: c.id, key: c.key, name: c.name, description: c.description ?? '', icon: (c.icon as HelpIcon) ?? 'book', parentId: c.parent_id ?? null,
      audiences: c.audiences ?? [], feature: c.feature ?? null, sort: c.sort ?? 100, status: c.status, count: total(c.id), builtin: !!c.builtin_key,
    }));
  }

  private async settings(tx: AnyTx): Promise<HelpSettings> {
    return settingsView(await tx.collection('help_settings').findOne({ key: 'default' }));
  }

  // ------------------------------------------------------------------------------------------- the help centre

  /** The help centre's front page for the viewer. `queries` is filled in by the caller (it knows the inbox rules). */
  async homeIn(tx: AnyTx, v: HelpViewer, membershipId: string | null): Promise<Omit<HelpHome, 'queries'>> {
    const { cats, arts, byId } = await this.visible(tx, v);
    const categories = this.categoryViews(cats, arts).filter((c) => c.count > 0);
    const sum = (a: Doc) => this.summary(a, byId);
    const ownLevelFirst = (list: Doc[]) => [...list].sort((x, y) => Number((y.audiences ?? []).includes(v.level)) - Number((x.audiences ?? []).includes(v.level)) || (x.sort ?? 0) - (y.sort ?? 0));
    const ofKind = (k: HelpArticleKind) => arts.filter((a) => a.kind === k);
    let popular: Doc[] = [];
    let recent: Doc[] = [];
    if (membershipId) {
      const visibleIds = new Set(arts.map((a) => a.id as string));
      const tops = await (tx as TenantTx).collection('help_activity').aggregate([
        { $match: { views: { $gt: 0 } } },
        { $group: { _id: '$article_id', views: { $sum: '$views' }, people: { $sum: 1 } } },
        { $sort: { people: -1, views: -1 } },
        { $limit: 40 },
      ]);
      const byArt = new Map(arts.map((a) => [a.id as string, a]));
      popular = tops.map((t) => byArt.get((t._id ?? t.id) as string)).filter((a): a is Doc => !!a && visibleIds.has(a.id)).slice(0, 6);
      const mine = await (tx as TenantTx).collection('help_activity').find({ membership_id: membershipId, last_viewed_at: { $ne: null } }, { sort: { last_viewed_at: -1 }, limit: 20 });
      recent = mine.map((m) => byArt.get(m.article_id)).filter((a): a is Doc => !!a).slice(0, 6);
    }
    // Popular falls back to the most useful FAQs while nobody has read anything yet.
    if (!popular.length) popular = ownLevelFirst(ofKind('faq')).slice(0, 6);
    const recommended = ownLevelFirst(arts.filter((a) => ['guide', 'tutorial'].includes(a.kind) && (a.audiences ?? []).includes(v.level)))
      .concat(ownLevelFirst(arts.filter((a) => ['guide', 'tutorial'].includes(a.kind) && !(a.audiences ?? []).includes(v.level))))
      .slice(0, 6);
    const counts = Object.fromEntries(HELP_ARTICLE_KINDS.map((k) => [k, ofKind(k).length])) as Record<HelpArticleKind, number>;
    const settings = await this.settings(tx);
    return {
      level: v.level, levelLabel: HELP_AUDIENCE_LABEL[v.level], welcome: settings.welcome, settings,
      categories,
      quickstarts: quickstartsFor(v, ofKind('quickstart')).map(sum),
      recommended: recommended.map(sum),
      faqs: ownLevelFirst(ofKind('faq')).slice(0, 8).map(sum),
      popular: popular.map(sum),
      recent: recent.map(sum),
      tutorials: ownLevelFirst(ofKind('tutorial')).slice(0, 6).map(sum),
      counts,
    };
  }

  async searchIn(tx: AnyTx, v: HelpViewer, q: HelpSearchQuery): Promise<HelpSearchResult> {
    const { cats, arts, byId } = await this.visible(tx, v);
    let pool = arts;
    if (q.category) {
      const root = cats.find((c) => c.key === q.category);
      if (!root) return { items: [], total: 0 };
      const ids = new Set<string>([root.id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const c of cats) if (c.parent_id && ids.has(c.parent_id) && !ids.has(c.id)) { ids.add(c.id); grew = true; }
      }
      pool = pool.filter((a) => ids.has(a.category_id));
    }
    if (q.kind) pool = pool.filter((a) => a.kind === q.kind);
    const page = q.page?.split('?')[0]?.replace(/\/+$/, '') || null;
    const pageBonus = (a: Doc) => {
      if (!page || !a.href) return 0;
      const h = String(a.href).split('?')[0]!.replace(/\/+$/, '') || '/';
      if (h === page) return 30;
      return h !== '/' && page.startsWith(`${h}/`) ? 15 : 0;
    };
    const scored = pool.map((a) => {
      const cat = byId.get(a.category_id);
      const s = q.q ? scoreArticle({ title: a.title, summary: a.summary ?? '', body: a.body ?? '', keywords: a.keywords ?? [], steps: a.steps ?? [] }, `${cat?.name ?? ''}`, q.q) : 1;
      return { a, score: s > 0 ? s + pageBonus(a) : 0 };
    }).filter((x) => x.score > 0 && (q.q || !page || pageBonus(x.a) > 0 || q.category || q.kind));
    scored.sort((x, y) => y.score - x.score || (x.a.sort ?? 0) - (y.a.sort ?? 0));
    return { items: scored.slice(0, 50).map(({ a, score }) => ({ ...this.summary(a, byId), score, snippet: snippet(a, q.q ?? '') })), total: scored.length };
  }

  async categoryIn(tx: AnyTx, v: HelpViewer, key: string) {
    const { cats, arts, byId } = await this.visible(tx, v);
    const views = this.categoryViews(cats, arts);
    const c = views.find((x) => x.key === key);
    if (!c || c.count === 0) throw Errors.notFound('Help category');
    const parent = c.parentId ? views.find((x) => x.id === c.parentId) ?? null : null;
    return {
      category: c,
      parent,
      subcategories: views.filter((x) => x.parentId === c.id && x.count > 0),
      articles: arts.filter((a) => a.category_id === c.id).map((a) => this.summary(a, byId)),
    };
  }

  async articleIn(tx: AnyTx, v: HelpViewer, slug: string, membershipId: string | null): Promise<HelpArticleView> {
    const { arts, byId } = await this.visible(tx, v);
    const a = arts.find((x) => x.slug === slug);
    // Not visible (other level, feature off, no permission, draft) looks exactly like not there.
    if (!a) throw Errors.notFound('Help article');
    const bySlug = new Map(arts.map((x) => [x.slug as string, x]));
    let mine = { helpful: null as boolean | null, doneSteps: [] as number[], views: 0 };
    let helpful = { yes: 0, no: 0 };
    if (membershipId) {
      const t = tx as TenantTx;
      const row = await t.collection('help_activity').upsert(
        { membership_id: membershipId, article_id: a.id },
        { membership_id: membershipId, article_id: a.id, views: 1, last_viewed_at: new Date() },
        { $inc: { views: 1 }, $set: { last_viewed_at: new Date() } },
      );
      mine = { helpful: (row.helpful as boolean | null) ?? null, doneSteps: (row.done_steps as number[]) ?? [], views: row.views as number };
      helpful = { yes: await t.collection('help_activity').count({ article_id: a.id, helpful: true }), no: await t.collection('help_activity').count({ article_id: a.id, helpful: false }) };
    }
    const related = (a.related as string[] ?? []).map((s) => bySlug.get(s)).filter((x): x is Doc => !!x);
    // Fill up with articles of the same category, so every article leads somewhere.
    for (const x of arts) {
      if (related.length >= 4) break;
      if (x.id !== a.id && x.category_id === a.category_id && !related.includes(x)) related.push(x);
    }
    return {
      ...this.summary(a, byId),
      body: a.body ?? '', stepList: (a.steps as HelpStep[]) ?? [], videoUrl: a.video_url ?? null, imageUrl: a.image_url ?? null,
      keywords: a.keywords ?? [], feature: a.feature ?? null, permission: a.permission ?? null,
      related: related.map((x) => this.summary(x, byId)), mine, helpful, updatedAt: iso(a.updated_at ?? a.created_at)!,
    };
  }

  // ------------------------------------------------------------------------------------------- workspace endpoints

  home() {
    return this.db.tenant(async (tx) => this.homeIn(tx, await this.tenantViewer(tx), requestContext.tenantActor().membershipId));
  }

  search(q: HelpSearchQuery) {
    return this.db.tenant(async (tx) => this.searchIn(tx, await this.tenantViewer(tx), q));
  }

  category(key: string) {
    return this.db.tenant(async (tx) => this.categoryIn(tx, await this.tenantViewer(tx), key));
  }

  article(slug: string) {
    return this.db.tenant(async (tx) => this.articleIn(tx, await this.tenantViewer(tx), slug, requestContext.tenantActor().membershipId));
  }

  /** The visible article by slug, for feedback and progress. */
  private async ownArticle(tx: TenantTx, slug: string) {
    const v = await this.tenantViewer(tx);
    const { arts } = await this.visible(tx, v);
    const a = arts.find((x) => x.slug === slug);
    if (!a) throw Errors.notFound('Help article');
    return a;
  }

  feedback(slug: string, helpful: boolean) {
    return this.db.tenant(async (tx) => {
      const a = await this.ownArticle(tx, slug);
      const me = requestContext.tenantActor().membershipId;
      await tx.collection('help_activity').upsert({ membership_id: me, article_id: a.id }, { membership_id: me, article_id: a.id, helpful }, { $set: { helpful } });
      return { yes: await tx.collection('help_activity').count({ article_id: a.id, helpful: true }), no: await tx.collection('help_activity').count({ article_id: a.id, helpful: false }), helpful };
    });
  }

  progress(slug: string, step: number, done: boolean) {
    return this.db.tenant(async (tx) => {
      const a = await this.ownArticle(tx, slug);
      const count = (a.steps as unknown[] | undefined)?.length ?? 0;
      if (step >= count) throw Errors.badRequest('no_such_step', 'That step is not part of this guide');
      const me = requestContext.tenantActor().membershipId;
      const row = await tx.collection('help_activity').upsert({ membership_id: me, article_id: a.id }, { membership_id: me, article_id: a.id, done_steps: done ? [step] : [] });
      const set = new Set<number>((row.done_steps as number[]) ?? []);
      if (done) set.add(step); else set.delete(step);
      const doneSteps = [...set].sort((x, y) => x - y);
      await tx.collection('help_activity').updateOne({ id: row.id }, { $set: { done_steps: doneSteps } });
      return { doneSteps, total: count, complete: doneSteps.length === count };
    });
  }

  /** Active query categories, Other last. */
  async queryCategoriesIn(tx: AnyTx, all = false): Promise<HelpQueryCategoryView[]> {
    const rows = await tx.collection('help_query_categories').find({ deleted_at: null, ...(all ? {} : { active: true }) }, { sort: { sort: 1, label: 1 } });
    const views = rows.map((r) => ({ id: r.id, key: r.key, label: r.label, description: r.description ?? '', toConsole: !!r.to_console, active: r.active !== false, sort: r.sort ?? 100, builtin: !!r.builtin_key }));
    return [...views.filter((v) => v.key !== HELP_OTHER_CATEGORY), ...views.filter((v) => v.key === HELP_OTHER_CATEGORY)];
  }

  settingsIn(tx: AnyTx) {
    return this.settings(tx);
  }

  // ------------------------------------------------------------------------------------------- public Help & Support

  /**
   * The public Help & Support page, for anyone before signing in: feature briefs and FAQs with their text, articles
   * and guides. Read-only, and nothing about the reader is stored.
   */
  publicHome(): Promise<PublicHelpHome> {
    return this.db.platform(async (tx) => {
      const v = this.publicViewer();
      const { cats, arts, byId } = await this.visible(tx, v);
      const entry = (a: Doc): PublicHelpEntry => ({ ...this.summary(a, byId), body: a.body ?? '', keywords: a.keywords ?? [] });
      const ofKind = (...k: HelpArticleKind[]) => arts.filter((a) => k.includes(a.kind));
      const settings = await this.settings(tx);
      return {
        welcome: settings.welcome,
        categories: this.categoryViews(cats, arts).filter((c) => c.count > 0),
        features: ofKind('feature').map(entry),
        faqs: ofKind('faq', 'troubleshooting').map(entry),
        articles: ofKind('article').map((a) => this.summary(a, byId)),
        guides: ofKind('guide', 'tutorial', 'quickstart').map((a) => this.summary(a, byId)),
        counts: Object.fromEntries(HELP_ARTICLE_KINDS.map((k) => [k, ofKind(k).length])) as Record<HelpArticleKind, number>,
      };
    });
  }

  publicSearch(q: HelpSearchQuery) {
    return this.db.platform(async (tx) => this.searchIn(tx, this.publicViewer(), q));
  }

  publicArticle(slug: string): Promise<PublicHelpArticle> {
    return this.db.platform(async (tx) => {
      const { mine: _mine, helpful: _helpful, ...rest } = await this.articleIn(tx, this.publicViewer(), slug, null);
      return rest;
    });
  }

  // ------------------------------------------------------------------------------------------- Console: own help

  consoleHome() {
    return this.db.platform(async (tx) => this.homeIn(tx, this.consoleViewer(), null));
  }

  consoleSearch(q: HelpSearchQuery) {
    return this.db.platform(async (tx) => this.searchIn(tx, this.consoleViewer(), q));
  }

  consoleCategory(key: string) {
    return this.db.platform(async (tx) => this.categoryIn(tx, this.consoleViewer(), key));
  }

  consoleArticle(slug: string) {
    return this.db.platform(async (tx) => this.articleIn(tx, this.consoleViewer(), slug, null));
  }

  // ------------------------------------------------------------------------------------------- Console: content manager

  private adminId() {
    return requestContext.platformActor().adminId;
  }

  /** Every category and article, drafts included, with the numbers the manager shows. */
  manageList() {
    return this.db.platform(async (tx) => {
      const { cats, arts } = await this.load(tx);
      const byId = new Map(cats.map((c) => [c.id as string, c]));
      const views = this.categoryViews(cats, arts).map((c) => ({ ...c, count: arts.filter((a) => a.category_id === c.id).length }));
      const activity = await tx.collection('help_activity').aggregate([
        { $group: { _id: '$article_id', views: { $sum: '$views' }, yes: { $sum: { $cond: [{ $eq: ['$helpful', true] }, 1, 0] } }, no: { $sum: { $cond: [{ $eq: ['$helpful', false] }, 1, 0] } } } },
      ]);
      const stats = new Map(activity.map((s) => [(s._id ?? s.id) as string, s]));
      return {
        categories: views,
        articles: arts.map((a) => ({
          ...this.summary(a, byId), status: a.status as string, feature: a.feature ?? null, permission: a.permission ?? null, builtin: !!a.builtin_key,
          customised: !!a.customised_at, updatedAt: iso(a.updated_at ?? a.created_at)!,
          views: (stats.get(a.id)?.views as number) ?? 0, yes: (stats.get(a.id)?.yes as number) ?? 0, no: (stats.get(a.id)?.no as number) ?? 0,
        })),
        queryCategories: await this.queryCategoriesIn(tx, true),
        settings: await this.settings(tx),
      };
    });
  }

  manageArticle(id: string) {
    return this.db.platform(async (tx) => {
      const a = await tx.collection('help_articles').findOne({ id, deleted_at: null });
      if (!a) throw Errors.notFound('Help article');
      return {
        id: a.id, slug: a.slug, categoryId: a.category_id, kind: a.kind, title: a.title, summary: a.summary ?? '', body: a.body ?? '',
        steps: a.steps ?? [], audiences: a.audiences ?? [], feature: a.feature ?? null, permission: a.permission ?? null, keywords: a.keywords ?? [],
        href: a.href ?? null, videoUrl: a.video_url ?? null, imageUrl: a.image_url ?? null, related: a.related ?? [], icon: a.icon ?? null, sort: a.sort ?? 100,
        status: a.status, builtin: !!a.builtin_key, customised: !!a.customised_at, updatedAt: iso(a.updated_at ?? a.created_at),
      };
    });
  }

  private categoryRow(input: HelpCategoryInput) {
    return { key: input.key, name: input.name, description: input.description, icon: input.icon, parent_id: input.parentId, audiences: input.audiences, feature: input.feature, sort: input.sort, status: input.status };
  }

  private async checkParent(tx: PlatformTx, id: string | null, parentId: string | null) {
    if (!parentId) return;
    if (parentId === id) throw Errors.badRequest('invalid_parent', 'A category cannot be its own parent');
    const parent = await tx.collection('help_categories').findOne({ id: parentId, deleted_at: null });
    if (!parent) throw Errors.badRequest('invalid_parent', 'Choose an existing parent category');
    // One level of subcategories keeps navigation simple.
    if (parent.parent_id) throw Errors.badRequest('invalid_parent', 'A subcategory cannot have subcategories of its own');
  }

  createCategory(input: HelpCategoryInput) {
    return this.db.platform(async (tx) => {
      await this.checkParent(tx, null, input.parentId);
      if (await tx.collection('help_categories').exists({ key: input.key })) throw Errors.conflict('key_taken', 'Another category already uses this key');
      const row = await tx.collection('help_categories').insert({ ...this.categoryRow(input), updated_by_admin_id: this.adminId() });
      await this.audit.record(tx, { tenantId: null, action: 'help.category_created', resourceType: 'help_category', resourceId: row.id, changes: { key: input.key, name: input.name } });
      return { id: row.id as string };
    });
  }

  updateCategory(id: string, input: HelpCategoryInput) {
    return this.db.platform(async (tx) => {
      const c = await tx.collection('help_categories').findOne({ id, deleted_at: null });
      if (!c) throw Errors.notFound('Help category');
      await this.checkParent(tx, id, input.parentId);
      if (input.parentId && (await tx.collection('help_categories').exists({ parent_id: id, deleted_at: null }))) throw Errors.badRequest('invalid_parent', 'This category has subcategories, so it cannot become a subcategory');
      if (input.key !== c.key && (await tx.collection('help_categories').exists({ key: input.key }))) throw Errors.conflict('key_taken', 'Another category already uses this key');
      await tx.collection('help_categories').updateOne({ id }, { $set: { ...this.categoryRow(input), customised_at: new Date(), updated_by_admin_id: this.adminId() } });
      await this.audit.record(tx, { tenantId: null, action: 'help.category_updated', resourceType: 'help_category', resourceId: id, changes: { from: { name: c.name, status: c.status }, to: { name: input.name, status: input.status } } });
      return { ok: true };
    });
  }

  deleteCategory(id: string) {
    return this.db.platform(async (tx) => {
      const c = await tx.collection('help_categories').findOne({ id, deleted_at: null });
      if (!c) throw Errors.notFound('Help category');
      if (await tx.collection('help_categories').exists({ parent_id: id, deleted_at: null })) throw Errors.conflict('category_not_empty', 'Move or delete its subcategories first');
      if (await tx.collection('help_articles').exists({ category_id: id, deleted_at: null })) throw Errors.conflict('category_not_empty', 'Move or delete its articles first');
      // Built-in rows are kept as deleted, so the next update of SampCrew does not bring them back.
      if (c.builtin_key) await tx.collection('help_categories').updateOne({ id }, { $set: { deleted_at: new Date(), updated_by_admin_id: this.adminId() } });
      else await tx.collection('help_categories').deleteOne({ id });
      await this.audit.record(tx, { tenantId: null, action: 'help.category_deleted', resourceType: 'help_category', resourceId: id, changes: { key: c.key, name: c.name } });
      return { ok: true };
    });
  }

  private articleRow(input: HelpArticleInput) {
    return {
      slug: input.slug, category_id: input.categoryId, kind: input.kind, title: input.title, summary: input.summary, body: input.body, steps: input.steps,
      audiences: input.audiences, feature: input.feature, permission: input.permission, keywords: input.keywords, href: input.href,
      video_url: input.videoUrl, image_url: input.imageUrl, related: input.related, icon: input.icon, sort: input.sort, status: input.status,
    };
  }

  private async checkArticle(tx: PlatformTx, input: HelpArticleInput, id: string | null) {
    if (!(await tx.collection('help_categories').exists({ id: input.categoryId, deleted_at: null }))) throw Errors.badRequest('invalid_category', 'Choose an existing category');
    const taken = await tx.collection('help_articles').findOne({ slug: input.slug });
    if (taken && taken.id !== id) throw Errors.conflict('slug_taken', 'Another article already uses this web address (slug)');
    if ((input.kind === 'guide' || input.kind === 'tutorial' || input.kind === 'quickstart') && !input.steps.length) throw Errors.badRequest('steps_required', 'Guides, tutorials and quick starts need at least one step');
    if ((input.kind === 'faq' || input.kind === 'troubleshooting') && !input.body) throw Errors.badRequest('body_required', 'Write the answer');
    if ((input.kind === 'feature' || input.kind === 'article') && !input.body) throw Errors.badRequest('body_required', input.kind === 'feature' ? 'Write the feature brief' : 'Write the article');
  }

  createArticle(input: HelpArticleInput) {
    return this.db.platform(async (tx) => {
      await this.checkArticle(tx, input, null);
      const row = await tx.collection('help_articles').insert({ ...this.articleRow(input), updated_by_admin_id: this.adminId() });
      await this.audit.record(tx, { tenantId: null, action: 'help.article_created', resourceType: 'help_article', resourceId: row.id, changes: { slug: input.slug, title: input.title, status: input.status } });
      return { id: row.id as string };
    });
  }

  updateArticle(id: string, input: HelpArticleInput) {
    return this.db.platform(async (tx) => {
      const a = await tx.collection('help_articles').findOne({ id, deleted_at: null });
      if (!a) throw Errors.notFound('Help article');
      await this.checkArticle(tx, input, id);
      await tx.collection('help_articles').updateOne({ id }, { $set: { ...this.articleRow(input), customised_at: new Date(), updated_by_admin_id: this.adminId() } });
      await this.audit.record(tx, { tenantId: null, action: 'help.article_updated', resourceType: 'help_article', resourceId: id, changes: { from: { title: a.title, status: a.status }, to: { title: input.title, status: input.status } } });
      return { ok: true };
    });
  }

  setArticleStatus(id: string, status: 'published' | 'draft') {
    return this.db.platform(async (tx) => {
      const a = await tx.collection('help_articles').findOne({ id, deleted_at: null });
      if (!a) throw Errors.notFound('Help article');
      await tx.collection('help_articles').updateOne({ id }, { $set: { status, customised_at: new Date(), updated_by_admin_id: this.adminId() } });
      await this.audit.record(tx, { tenantId: null, action: status === 'published' ? 'help.article_published' : 'help.article_unpublished', resourceType: 'help_article', resourceId: id });
      return { ok: true, status };
    });
  }

  deleteArticle(id: string) {
    return this.db.platform(async (tx) => {
      const a = await tx.collection('help_articles').findOne({ id, deleted_at: null });
      if (!a) throw Errors.notFound('Help article');
      if (a.builtin_key) await tx.collection('help_articles').updateOne({ id }, { $set: { deleted_at: new Date(), updated_by_admin_id: this.adminId() } });
      else await tx.collection('help_articles').deleteOne({ id });
      await this.audit.record(tx, { tenantId: null, action: 'help.article_deleted', resourceType: 'help_article', resourceId: id, changes: { slug: a.slug, title: a.title } });
      return { ok: true };
    });
  }

  createQueryCategory(input: HelpQueryCategoryInput) {
    return this.db.platform(async (tx) => {
      if (await tx.collection('help_query_categories').exists({ key: input.key })) throw Errors.conflict('key_taken', 'Another query category already uses this key');
      const row = await tx.collection('help_query_categories').insert({ key: input.key, label: input.label, description: input.description, to_console: input.toConsole, active: input.active, sort: input.sort });
      await this.audit.record(tx, { tenantId: null, action: 'help.query_category_created', resourceType: 'help_query_category', resourceId: row.id, changes: { key: input.key, label: input.label } });
      return { id: row.id as string };
    });
  }

  updateQueryCategory(id: string, input: HelpQueryCategoryInput) {
    return this.db.platform(async (tx) => {
      const c = await tx.collection('help_query_categories').findOne({ id, deleted_at: null });
      if (!c) throw Errors.notFound('Query category');
      if (c.key === HELP_OTHER_CATEGORY && (input.key !== HELP_OTHER_CATEGORY || !input.active)) throw Errors.badRequest('other_required', 'Other is always offered, so people can raise any question');
      if (input.key !== c.key && (await tx.collection('help_query_categories').exists({ key: input.key }))) throw Errors.conflict('key_taken', 'Another query category already uses this key');
      await tx.collection('help_query_categories').updateOne({ id }, { $set: { key: input.key, label: input.label, description: input.description, to_console: input.toConsole, active: input.active, sort: input.sort, customised_at: new Date() } });
      await this.audit.record(tx, { tenantId: null, action: 'help.query_category_updated', resourceType: 'help_query_category', resourceId: id, changes: { from: { label: c.label, active: c.active }, to: { label: input.label, active: input.active } } });
      return { ok: true };
    });
  }

  deleteQueryCategory(id: string) {
    return this.db.platform(async (tx) => {
      const c = await tx.collection('help_query_categories').findOne({ id, deleted_at: null });
      if (!c) throw Errors.notFound('Query category');
      if (c.key === HELP_OTHER_CATEGORY) throw Errors.badRequest('other_required', 'Other is always offered, so people can raise any question');
      // Queries keep the category's name (category_label), so removing it never changes old queries.
      if (c.builtin_key) await tx.collection('help_query_categories').updateOne({ id }, { $set: { deleted_at: new Date(), active: false } });
      else await tx.collection('help_query_categories').deleteOne({ id });
      await this.audit.record(tx, { tenantId: null, action: 'help.query_category_deleted', resourceType: 'help_query_category', resourceId: id, changes: { key: c.key } });
      return { ok: true };
    });
  }

  updateSettings(input: HelpSettings) {
    return this.db.platform(async (tx) => {
      const before = await this.settings(tx);
      await tx.collection('help_settings').upsert(
        { key: 'default' },
        { key: 'default', attachments: input.attachments, reopen_days: input.reopenDays, escalation: input.escalation, welcome: input.welcome },
        { $set: { attachments: input.attachments, reopen_days: input.reopenDays, escalation: input.escalation, welcome: input.welcome } },
      );
      await this.audit.record(tx, { tenantId: null, action: 'help.settings_updated', resourceType: 'help_settings', resourceId: null, changes: { from: before, to: input } });
      return input;
    });
  }

  insights(): Promise<HelpInsights> {
    return this.db.platform(async (tx) => {
      const arts = await tx.collection('help_articles').find({ deleted_at: null }, { projection: { title: 1, kind: 1 } });
      const byId = new Map(arts.map((a) => [a.id as string, a]));
      const stats = await tx.collection('help_activity').aggregate([
        { $group: { _id: '$article_id', views: { $sum: '$views' }, yes: { $sum: { $cond: [{ $eq: ['$helpful', true] }, 1, 0] } }, no: { $sum: { $cond: [{ $eq: ['$helpful', false] }, 1, 0] } } } },
        { $sort: { views: -1 } },
        { $limit: 30 },
      ]);
      const statuses = await tx.collection('help_queries').aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
      const n = (s: string) => (statuses.find((x) => (x._id ?? x.id) === s)?.n as number) ?? 0;
      const cats = await tx.collection('help_queries').aggregate([{ $group: { _id: { key: '$category_key', label: '$category_label' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]);
      return {
        articles: stats.map((s) => ({ id: (s._id ?? s.id) as string, title: (byId.get((s._id ?? s.id) as string)?.title as string) ?? 'Deleted article', kind: (byId.get((s._id ?? s.id) as string)?.kind as HelpArticleKind) ?? 'faq', views: s.views as number, yes: s.yes as number, no: s.no as number })),
        queries: { open: n('open'), inProgress: n('in_progress'), awaiting: n('awaiting_user'), resolved: n('resolved'), closed: n('closed'), total: statuses.reduce((t, x) => t + (x.n as number), 0) },
        topCategories: cats.map((c) => { const k = (c._id ?? c.id) as { key: string; label: string }; return { key: k.key, label: k.label, count: c.n as number }; }),
      };
    });
  }
}
