import { z } from 'zod';

/**
 * Help & Support: one help centre for every level (Console Admin, Super Workspace, HR Workspace, Employee Workspace)
 * and the phone app. Categories, articles (FAQs, step-by-step guides, interactive tutorials, troubleshooting and
 * quick starts), query categories and settings live in the database and are managed in the Console. A built-in
 * library is seeded with the catalogue and never overwrites what a Console Admin changed.
 *
 * Each person only sees content for their level, the features their company and level have switched on, and the
 * permissions they hold. The server filters it; the screens never receive an article the person may not see.
 *
 * Raise a Query: anyone who cannot find an answer sends a query with a category (or Other), subject, description,
 * the page or feature it is about, attachments and their contact details. It gets a ticket ID (HQ-00012) and goes to
 * the level above: an Employee Workspace member's query to the HR Workspace that looks after them, an HR Workspace's
 * to the Super Workspace, and a Super Workspace's to the SampCrew Console Admin team. Whoever handles it can escalate
 * it one level up.
 */

export const HELP_AUDIENCES = ['console', 'super', 'hr', 'employee'] as const;
export type HelpAudience = (typeof HELP_AUDIENCES)[number];
export const HELP_AUDIENCE_LABEL: Record<HelpAudience, string> = {
  console: 'Console Admin',
  super: 'Super Workspace',
  hr: 'HR Workspace',
  employee: 'Employee Workspace',
};

/** The audiences a person on a level sees: their own and every level below it (a Super Workspace also runs HR work). */
export function helpAudiencesFor(level: HelpAudience): HelpAudience[] {
  if (level === 'console') return ['console'];
  if (level === 'super') return ['super', 'hr', 'employee'];
  if (level === 'hr') return ['hr', 'employee'];
  return ['employee'];
}

export const HELP_ARTICLE_KINDS = ['faq', 'guide', 'tutorial', 'troubleshooting', 'quickstart'] as const;
export type HelpArticleKind = (typeof HELP_ARTICLE_KINDS)[number];
export const HELP_KIND_LABEL: Record<HelpArticleKind, string> = {
  faq: 'FAQ',
  guide: 'Guide',
  tutorial: 'Tutorial',
  troubleshooting: 'Troubleshooting',
  quickstart: 'Quick start',
};
export const HELP_KIND_PLURAL: Record<HelpArticleKind, string> = {
  faq: 'FAQs',
  guide: 'Help guides',
  tutorial: 'Tutorials',
  troubleshooting: 'Troubleshooting',
  quickstart: 'Quick starts',
};

/** Icons a category can use (lucide names on the web; the phone shows the glyph). */
export const HELP_ICONS = {
  rocket: '🚀', user: '👤', shield: '🛡️', home: '🏠', inbox: '📥', messages: '💬', megaphone: '📣', users: '👥',
  network: '🧭', toggle: '🎚️', clock: '⏱️', calendar: '📅', wallet: '💰', receipt: '🧾', briefcase: '💼',
  handshake: '🤝', target: '🎯', graduation: '🎓', heart: '💜', file: '📄', laptop: '💻', checklist: '✅',
  chart: '📊', sparkles: '✨', scroll: '📜', card: '💳', settings: '⚙️', phone: '📱', headset: '🎧', wrench: '🔧',
  building: '🏢', tag: '🏷️', key: '🔑', activity: '📈', plug: '🔌', globe: '🌐', book: '📘', upload: '📤',
} as const;
export type HelpIcon = keyof typeof HELP_ICONS;
export const HELP_ICON_KEYS = Object.keys(HELP_ICONS) as [HelpIcon, ...HelpIcon[]];

export const HELP_CONTENT_STATUSES = ['published', 'draft'] as const;
export type HelpContentStatus = (typeof HELP_CONTENT_STATUSES)[number];

export const HELP_QUERY_STATUSES = ['open', 'in_progress', 'awaiting_user', 'resolved', 'closed'] as const;
export type HelpQueryStatus = (typeof HELP_QUERY_STATUSES)[number];
export const HELP_QUERY_STATUS_LABEL: Record<HelpQueryStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  awaiting_user: 'Awaiting User Response',
  resolved: 'Resolved',
  closed: 'Closed',
};

/** Who handles a query: the HR Workspace, the Super Workspace or the SampCrew Console Admin team. */
export const HELP_ROUTES = ['hr', 'super', 'console'] as const;
export type HelpRoute = (typeof HELP_ROUTES)[number];
export const HELP_ROUTE_LABEL: Record<HelpRoute, string> = {
  hr: 'HR Workspace',
  super: 'Super Workspace',
  console: 'SampCrew Support (Console Admin)',
};

/** The query's ticket ID, as people see it: HQ-00012. */
export const helpTicketId = (n: number) => `HQ-${String(n).padStart(5, '0')}`;

/** The query category every list ends with, so a question that fits nowhere can still be raised. */
export const HELP_OTHER_CATEGORY = 'other';

const slug = z.string().trim().toLowerCase().min(2).max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lower-case letters, numbers and dashes');
const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
/** A feature or feature part key, such as leave or leave.requests. */
const featureKey = z.string().trim().max(80).regex(/^[a-z_]+(\.[a-z_]+)?$/, 'Use a feature key such as leave or leave.requests').optional().nullable().transform((v) => (v ? v : null));
const permissionKey = z.string().trim().max(80).regex(/^[a-z_-]+:[a-z_-]+$/, 'Use a permission key such as leave:approve').optional().nullable().transform((v) => (v ? v : null));
const url = z.string().trim().max(500).regex(/^(https:\/\/|\/)/, 'Use an https:// link or a path inside SampCrew').optional().nullable().transform((v) => (v ? v : null));

export const helpStepInput = z.object({
  title: z.string().trim().min(2).max(160),
  body: z.string().trim().max(2000).default(''),
  /** A page to open for this step (a path inside the app, such as /leave). */
  href: url,
});
export type HelpStep = z.infer<typeof helpStepInput>;

export const helpCategoryInput = z.object({
  key: slug,
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).default(''),
  icon: z.enum(HELP_ICON_KEYS).default('book'),
  /** A subcategory names its parent category. */
  parentId: z.uuid().optional().nullable().transform((v) => v ?? null),
  audiences: z.array(z.enum(HELP_AUDIENCES)).min(1, 'Choose at least one level').max(4),
  /** Shown only while this feature (or part) is switched on for the person. */
  feature: featureKey,
  sort: z.coerce.number().int().min(0).max(10000).default(100),
  status: z.enum(HELP_CONTENT_STATUSES).default('published'),
});
export type HelpCategoryInput = z.infer<typeof helpCategoryInput>;

export const helpArticleInput = z.object({
  slug,
  categoryId: z.uuid(),
  kind: z.enum(HELP_ARTICLE_KINDS),
  title: z.string().trim().min(3).max(200),
  summary: z.string().trim().max(500).default(''),
  /** The answer or explanation. Paragraphs are separated by a blank line; lines starting with "- " are a list. */
  body: z.string().trim().max(20000).default(''),
  steps: z.array(helpStepInput).max(30).default([]),
  audiences: z.array(z.enum(HELP_AUDIENCES)).min(1, 'Choose at least one level').max(4),
  feature: featureKey,
  permission: permissionKey,
  keywords: z.array(z.string().trim().min(1).max(60)).max(40).default([]),
  /** The page this article is about, opened from "Go to page". */
  href: url,
  videoUrl: z.string().trim().max(500).regex(/^https:\/\//, 'Use an https:// link').optional().nullable().transform((v) => (v ? v : null)),
  imageUrl: z.string().trim().max(500).regex(/^https:\/\//, 'Use an https:// link').optional().nullable().transform((v) => (v ? v : null)),
  related: z.array(slug).max(12).default([]),
  sort: z.coerce.number().int().min(0).max(10000).default(100),
  status: z.enum(HELP_CONTENT_STATUSES).default('published'),
});
export type HelpArticleInput = z.infer<typeof helpArticleInput>;

export const helpQueryCategoryInput = z.object({
  key: slug,
  label: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).default(''),
  /** Queries in this category go straight to the SampCrew Console Admin team (for example billing or a product bug). */
  toConsole: z.boolean().default(false),
  active: z.boolean().default(true),
  sort: z.coerce.number().int().min(0).max(10000).default(100),
});
export type HelpQueryCategoryInput = z.infer<typeof helpQueryCategoryInput>;

export const helpSettingsInput = z.object({
  /** People may attach screenshots or files to queries and replies. */
  attachments: z.boolean(),
  /** Days after resolving that the person who raised a query may reopen it (0: never). */
  reopenDays: z.coerce.number().int().min(0).max(365),
  /** Handlers may escalate a query to the level above (up to the Console Admin team). */
  escalation: z.boolean(),
  /** Text shown at the top of the help centre. */
  welcome: z.string().trim().max(300),
});
export type HelpSettings = z.infer<typeof helpSettingsInput>;
export const HELP_DEFAULT_SETTINGS: HelpSettings = { attachments: true, reopenDays: 14, escalation: true, welcome: 'Search guides, FAQs and tutorials, or raise a query and we will get back to you.' };

export const helpSearchQuery = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  kind: z.enum(HELP_ARTICLE_KINDS).optional(),
  /** A page path: articles about it come first ("help for this page"). */
  page: z.string().trim().max(200).optional(),
});
export type HelpSearchQuery = z.infer<typeof helpSearchQuery>;

export const helpFeedbackInput = z.object({ helpful: z.boolean() });
export const helpProgressInput = z.object({ step: z.coerce.number().int().min(0).max(29), done: z.boolean() });

const fileIds = z.array(z.uuid()).max(5, 'Attach up to 5 files').default([]);

export const helpQueryInput = z.object({
  categoryKey: slug,
  subject: z.string().trim().min(5, 'Give your query a short subject').max(150),
  description: z.string().trim().min(10, 'Describe your question or problem in a sentence or two').max(5000),
  /** The page or feature it is about, such as "Leave > Apply for leave". */
  page: z.string().trim().max(200).optional().nullable().transform((v) => (v ? v : null)),
  feature: featureKey,
  /** The article the person read before raising it ("Still need help?"). */
  articleId: z.uuid().optional().nullable().transform((v) => v ?? null),
  contactPhone: z.string().trim().max(30).regex(/^[0-9+()\-\s]*$/, 'Use digits, spaces, +, - and brackets').optional().nullable().transform((v) => (v ? v : null)),
  fileIds,
  /** Sent by the app so a retried submit does not raise the query twice. */
  clientId: z.string().trim().max(64).optional(),
});
export type HelpQueryInput = z.infer<typeof helpQueryInput>;

export const helpReplyInput = z.object({
  body: z.string().trim().min(1, 'Write a reply').max(5000),
  fileIds,
  /** Handlers only: a note the person who raised the query does not see. */
  internal: z.boolean().default(false),
  /** Handlers only: the status to set with the reply (default: Awaiting User Response for a handler's reply). */
  status: z.enum(HELP_QUERY_STATUSES).optional(),
  clientId: z.string().trim().max(64).optional(),
});
export type HelpReplyInput = z.infer<typeof helpReplyInput>;

export const helpStatusInput = z.object({
  status: z.enum(HELP_QUERY_STATUSES),
  note: z.string().trim().max(1000).optional().nullable().transform((v) => (v ? v : null)),
});
export const helpAssignInput = z.object({ assigneeId: z.uuid().nullable() });
export const helpEscalateInput = z.object({ reason: z.string().trim().min(5, 'Say why it needs the level above').max(1000) });
export const helpRateInput = z.object({ rating: z.coerce.number().int().min(1).max(5), comment: optText(500) });

export const helpQueryListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(HELP_QUERY_STATUSES).optional(),
  /** Inbox: only queries assigned to me / unassigned. */
  assigned: z.enum(['me', 'none']).optional(),
  /** Console: one company's queries. */
  tenantId: z.uuid().optional(),
});
export type HelpQueryListQuery = z.infer<typeof helpQueryListQuery>;

// --------------------------------------------------------------------------------------------- views

export interface HelpCategoryView {
  id: string;
  key: string;
  name: string;
  description: string;
  icon: HelpIcon;
  parentId: string | null;
  audiences: HelpAudience[];
  feature: string | null;
  sort: number;
  status: HelpContentStatus;
  /** Articles the viewer can see in it (and its subcategories). */
  count: number;
  builtin: boolean;
}

export interface HelpArticleSummary {
  id: string;
  slug: string;
  categoryId: string;
  categoryKey: string;
  categoryName: string;
  kind: HelpArticleKind;
  title: string;
  summary: string;
  audiences: HelpAudience[];
  href: string | null;
  hasVideo: boolean;
  steps: number;
}

export interface HelpArticleView extends HelpArticleSummary {
  body: string;
  stepList: HelpStep[];
  videoUrl: string | null;
  imageUrl: string | null;
  keywords: string[];
  feature: string | null;
  permission: string | null;
  related: HelpArticleSummary[];
  /** The viewer's own activity: helpful vote and the tutorial steps they finished. */
  mine: { helpful: boolean | null; doneSteps: number[]; views: number };
  helpful: { yes: number; no: number };
  updatedAt: string;
}

export interface HelpHome {
  level: HelpAudience;
  levelLabel: string;
  welcome: string;
  settings: HelpSettings;
  categories: HelpCategoryView[];
  quickstarts: HelpArticleSummary[];
  recommended: HelpArticleSummary[];
  faqs: HelpArticleSummary[];
  popular: HelpArticleSummary[];
  recent: HelpArticleSummary[];
  tutorials: HelpArticleSummary[];
  counts: Record<HelpArticleKind, number>;
  /** What the person may do with queries (the parts their level has on). */
  queries: { raise: boolean; open: number; inbox: boolean; waiting: number };
}

export interface HelpSearchResult {
  items: (HelpArticleSummary & { score: number; snippet: string })[];
  total: number;
}

export interface HelpQueryCategoryView {
  id: string;
  key: string;
  label: string;
  description: string;
  toConsole: boolean;
  active: boolean;
  sort: number;
  builtin: boolean;
}

export interface HelpFileView { id: string; name: string; type: string; size: number; href: string }

export interface HelpQueryMessageView {
  id: string;
  kind: 'message' | 'note' | 'event';
  body: string;
  author: { name: string; level: HelpAudience; levelLabel: string; workspace: string | null } | null;
  /** Written by the person who raised the query. */
  fromRaiser: boolean;
  mine: boolean;
  files: HelpFileView[];
  createdAt: string;
}

export interface HelpQueryView {
  id: string;
  ticketId: string;
  number: number;
  subject: string;
  description: string;
  category: { key: string; label: string };
  page: string | null;
  feature: string | null;
  status: HelpQueryStatus;
  statusLabel: string;
  route: HelpRoute;
  routeLabel: string;
  /** The HR Workspace it went to (route hr), or null for the company-wide HR team. */
  hrWorkspace: { id: string; name: string } | null;
  raisedBy: { name: string; level: HelpAudience; levelLabel: string; workspace: string | null; email: string | null; phone: string | null };
  assignee: { id: string; name: string } | null;
  workspace: { id: string; name: string };
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Unseen replies for the viewer. */
  unread: boolean;
  rating: number | null;
  /** What the viewer may do. */
  can: { reply: boolean; reopen: boolean; close: boolean; rate: boolean; handle: boolean; escalate: boolean };
}

export interface HelpQueryDetail extends HelpQueryView {
  messages: HelpQueryMessageView[];
  files: HelpFileView[];
  /** Handlers: people this query can be assigned to. */
  assignees: { id: string; name: string }[];
  article: { id: string; title: string } | null;
}

export interface HelpQueryList {
  items: HelpQueryView[];
  counts: Record<HelpQueryStatus | 'all', number>;
}

export interface HelpInsights {
  articles: { id: string; title: string; kind: HelpArticleKind; views: number; yes: number; no: number }[];
  queries: { open: number; inProgress: number; awaiting: number; resolved: number; closed: number; total: number };
  topCategories: { key: string; label: string; count: number }[];
}
