import { z } from 'zod';

/**
 * SampCrew IQ: the in-app assistant. A question is matched to one of a fixed set of intents by plain rules (no model),
 * so every figure it shows comes straight from the workspace, under the asker's own permissions, and the match is
 * explained. Policy questions go to the help articles (and the AI assistant, when the workspace has it on). Actions
 * are never carried out by IQ: it opens a prefilled form for a person to check and save.
 */
export const IQ_INTENTS = [
  'approvals', 'onboarding_tasks', 'on_leave', 'headcount', 'recruitment_summary', 'overtime', 'leave_trend',
  'draft_bid', 'draft_job', 'onboarding_checklist', 'payroll_summary', 'expenses_pending', 'attrition', 'probation',
  'cases', 'attendance_today', 'goals', 'learning', 'anniversaries', 'policy', 'unknown',
] as const;
export type IqIntent = (typeof IQ_INTENTS)[number];

export const iqAskInput = z.object({
  question: z.string().trim().min(2, 'Ask a question').max(500),
  /** The page the question was asked from, for context. */
  path: z.string().max(200).regex(/^\/[^\s]*$/).optional(),
  /** Continue a conversation: follow-ups such as "and last month?" reuse what was asked before. */
  conversationId: z.string().uuid().optional(),
}).strict();
export type IqAskInput = z.infer<typeof iqAskInput>;

export type IqPeriod = 'today' | 'week' | 'month' | 'quarter' | 'year';

export interface IqMatch {
  intent: IqIntent;
  /** 0 to 1: how many of the intent's signals the question contains. */
  score: number;
  /** The words that decided the match, shown to the person. */
  matched: string[];
  params: { count?: number; role?: string; title?: string; period?: IqPeriod; department?: string };
  /** True when the question was read as a follow-up to the previous one in the conversation. */
  followUp?: boolean;
}

export interface IqAnswer {
  intent: IqIntent;
  title: string;
  summary: string;
  /** exact: figures read from records; matched: help articles chosen by their words; low: not sure what was meant. */
  confidence: 'exact' | 'matched' | 'low';
  /** How the answer was produced, in one or two sentences. */
  how: string;
  table?: { columns: string[]; rows: (string | number)[][] };
  items?: { label: string; detail?: string; href?: string }[];
  sources: { label: string; href: string }[];
  /** A prefilled form to open. Nothing is saved until the person saves it there. */
  action?: { label: string; href: string; preview: { label: string; value: string }[]; note: string };
  suggestions?: string[];
  interactionId?: string;
  /** Set by the API: the conversation this answer was saved to, and the match it was answered from. */
  conversationId?: string;
  messageId?: string;
}

export interface IqConversation { id: string; title: string; updatedAt: string; questions: number }
export interface IqMessage { id: string; question: string; answer: IqAnswer; createdAt: string }

export const IQ_SUGGESTIONS = [
  'What is waiting for my approval?',
  'Show pending onboarding tasks',
  'Who is on leave this week?',
  'Headcount by department',
  'Summarize recruitment performance this quarter',
  'Show departments with increasing overtime',
  'Leave trend for the last six months',
  'Create a staffing proposal for five recruiters',
  'Prepare a draft job description for a Senior HR Manager',
  'Prepare an employee onboarding checklist',
  'What did the last payroll cost?',
  'Expense claims waiting for approval',
  'Who left this year?',
  'Whose probation ends this month?',
  'Open helpdesk cases',
  'Who is absent or late today?',
  'Goals at risk',
  'Overdue training',
  'Work anniversaries this month',
];

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, hundred: 100, a: 1, an: 1,
};

const title = (s: string) => s.replace(/\s+/g, ' ').trim().split(' ').map((w) => (/^[A-Z]{2,}$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');

/** "recruiters" -> "Recruiter", "warehouse associates" -> "Warehouse Associate". */
function singular(s: string) {
  const words = s.trim().split(/\s+/);
  const last = words.pop()!;
  const one = /ies$/i.test(last) ? last.replace(/ies$/i, 'y') : /(ss|us)$/i.test(last) ? last : last.replace(/s$/i, '');
  return title([...words, one].join(' '));
}

function period(q: string): IqPeriod | undefined {
  if (/\btoday\b/.test(q)) return 'today';
  if (/\b(this|next) week\b|\bweek\b/.test(q)) return 'week';
  if (/\bquarter\b|\bq[1-4]\b/.test(q)) return 'quarter';
  if (/\bthis year\b|\byear\b|\bytd\b/.test(q)) return 'year';
  if (/\bmonth\b/.test(q)) return 'month';
  return undefined;
}

interface Rule { intent: IqIntent; all?: RegExp[]; any: RegExp[] }

/** Most specific first. A rule matches when every `all` pattern and at least one `any` pattern is in the question. */
const RULES: Rule[] = [
  { intent: 'expenses_pending', any: [/\bexpenses?\b/, /\b(expense |reimbursement )?claims?\b/, /\breimbursements?\b/] },
  { intent: 'draft_bid', all: [/\b(create|prepare|make|draft|start|new|build)\b/], any: [/\bstaffing (proposal|bid)\b/, /\b(proposal|bid|quote)\b/] },
  { intent: 'draft_job', all: [/\b(create|prepare|make|draft|write|start|new)\b/], any: [/\bjob description\b/, /\bjd\b/, /\b(requisition|job post(ing)?)\b/] },
  { intent: 'onboarding_checklist', all: [/\bonboarding\b/], any: [/\bchecklist\b/, /\btemplate\b/] },
  { intent: 'onboarding_tasks', all: [/\bonboarding\b/], any: [/\btasks?\b/, /\bpending\b/, /\bopen\b/, /\boverdue\b/, /\bshow\b/] },
  { intent: 'payroll_summary', any: [/\bpayroll\b/, /\bpay ?runs?\b/, /\bnet pay\b/, /\bsalary (cost|bill)\b/, /\bwage bill\b/] },
  { intent: 'probation', any: [/\bprobation\b/, /\bconfirmations? due\b/] },
  { intent: 'cases', any: [/\bhelp ?desk\b/, /\b(hr |open |my )?(cases|tickets)\b/, /\bmy (hr )?requests?\b/, /\b(open|pending) (hr )?requests\b/] },
  { intent: 'approvals', any: [/\bapprov(e|al|als)\b/, /\bwaiting (for|on) me\b/, /\bmy inbox\b/, /\bpending requests?\b/] },
  { intent: 'attendance_today', any: [/\b(absent|late)\b/, /\bmissing punch(es)?\b/, /\bdid not punch\b/, /\bwho (came|is) in\b/, /\battendance (today|now)\b/] },
  { intent: 'overtime', any: [/\bover ?time\b/, /\bextra hours\b/] },
  { intent: 'leave_trend', all: [/\bleave\b/], any: [/\btrends?\b/, /\bpattern\b/, /\busage\b/, /\bby month\b/, /\banaly/] },
  { intent: 'on_leave', any: [/\bon leave\b/, /\b(away|off|out) (today|this week|next week)\b/, /\bwho is (away|off|out)\b/, /\bout of office\b/] },
  { intent: 'attrition', any: [/\battrition\b/, /\bleavers?\b/, /\bwho (has )?left\b/, /\bexits?\b/, /\bturnover\b/, /\bresign(ed|ations?)?\b/] },
  { intent: 'anniversaries', any: [/\banniversar(y|ies)\b/, /\bjoining day\b/] },
  { intent: 'goals', any: [/\bgoals?\b/, /\bokrs?\b/, /\bobjectives\b/] },
  { intent: 'learning', any: [/\btraining\b/, /\bcourses?\b/, /\blearning\b/, /\bcertifications?\b/] },
  { intent: 'recruitment_summary', any: [/\brecruit(ment|ing)?\b/, /\bhiring\b/, /\bfunnel\b/, /\bcandidates?\b/, /\bpipeline\b/, /\bapplications?\b/] },
  { intent: 'headcount', any: [/\bhead ?count\b/, /\bhow many (people|employees|staff)\b/, /\b(employees|people|staff) (by|per) (department|team)\b/, /\bworkforce size\b/] },
];

const QUESTION = /^(what|how|when|can|could|do|does|is|are|am|where|why|who|which|should|may|will)\b|\?$/;

/** Matches a question to an intent and pulls out the numbers and names it mentions. */
export function matchIq(raw: string): IqMatch {
  const q = raw.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  for (const r of RULES) {
    const all = (r.all ?? []).map((p) => q.match(p)?.[0]);
    if (all.some((m) => !m)) continue;
    const any = r.any.map((p) => q.match(p)?.[0]).filter((m): m is string => !!m);
    if (!any.length) continue;
    const matched = [...new Set([...(all as string[]), ...any])];
    const params: IqMatch['params'] = {};
    const p = period(q);
    if (p) params.period = p;
    if (r.intent === 'draft_bid') {
      const m = q.match(/\bfor (\d{1,4}|[a-z]+) ([a-z][a-z -]{1,60}?)(?: (?:in|at|from|for|starting|to)\b.*)?$/);
      if (m) {
        const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUMBERS[m[1]!];
        if (n) {
          params.count = n;
          params.role = singular(m[2]!.replace(/\b(people|staff)\b/, '').trim() || 'Associate');
        }
      }
    }
    if (r.intent === 'draft_job') {
      const m = raw.match(/\bfor (?:an? |the )?([A-Za-z][A-Za-z &/-]{1,80}?)(?: role| position)?[.?!]*$/i);
      if (m) params.title = title(m[1]!);
    }
    return { intent: r.intent, score: Math.min(1, (matched.length + 1) / 3), matched, params };
  }
  if (QUESTION.test(q)) return { intent: 'policy', score: 0.5, matched: [], params: {} };
  return { intent: 'unknown', score: 0, matched: [], params: {} };
}

/** Intents a follow-up can continue: the ones that read figures for a period or a department. */
const CONTINUABLE: IqIntent[] = ['on_leave', 'headcount', 'recruitment_summary', 'overtime', 'leave_trend', 'payroll_summary', 'expenses_pending', 'attrition', 'probation', 'cases', 'attendance_today', 'goals', 'learning', 'anniversaries'];
const FOLLOW = /^(and|what about|how about|only|just|same|now|then|also|for|in|show|but)\b/;

/**
 * Reads a question in the light of the previous one in the conversation. "And this quarter?" or "What about Sales?"
 * after "Headcount by department" keeps the subject and changes the period or the department. A question that
 * matches a subject of its own is taken as it is.
 */
export function matchInContext(raw: string, previous?: IqMatch | null, departments: string[] = []): IqMatch {
  const m = matchIq(raw);
  const q = raw.toLowerCase().replace(/[’']/g, "'").replace(/[?.!]+$/, '').replace(/\s+/g, ' ').trim();
  const dept = departments.filter((d) => new RegExp(`\\b${d.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q)).sort((a, b) => b.length - a.length)[0];
  if (dept) m.params.department = dept;
  const when = period(q);
  if (when && !m.params.period) m.params.period = when;
  const short = q.split(' ').length <= 8;
  if (previous && CONTINUABLE.includes(previous.intent) && (m.intent === 'unknown' || m.intent === 'policy') && short && (FOLLOW.test(q) || dept || m.params.period)) {
    const params = { ...previous.params, ...(m.params.period ? { period: m.params.period } : {}), ...(dept ? { department: dept } : {}) };
    if (/\b(all|every|whole|everyone)\b/.test(q) && !dept) delete params.department;
    return { intent: previous.intent, score: 0.7, matched: [...(dept ? [dept] : []), ...(m.params.period ? [m.params.period] : [])], params, followUp: true };
  }
  return m;
}

/**
 * A starting job description from a title: an honest template with the parts every description needs, for the
 * hiring manager to rewrite. It is labelled as a draft wherever it is shown.
 */
export function draftJobDescription(jobTitle: string, organisation: string) {
  return [
    `About the role`,
    `${organisation} is looking for a ${jobTitle} to join the team. [Two or three sentences on why the role exists and what success looks like in the first year.]`,
    '',
    'What you will do',
    '- [Main responsibility]',
    '- [Main responsibility]',
    '- [Who you will work with, and who you report to]',
    '',
    'What you bring',
    '- [Years and kind of experience]',
    '- [Must-have skills or qualifications]',
    '- [Nice to have]',
    '',
    'What we offer',
    '- [Pay range, benefits, working pattern and location]',
  ].join('\n');
}
