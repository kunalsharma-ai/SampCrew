import { Injectable } from '@nestjs/common';
import {
  checkFieldValue, CRM_IMPORT_FIELDS, crmCandidateInput, crmUrl, type CrmCandidateInput, type CrmImportPlanInput, crmLabel, GENDER_OPTIONS, guessImportField, normalisePhone,
  parseAmount, parseDate, parseExperience, parseNotice, phoneKey, QUALIFICATIONS, REFERENCE_TYPES, splitName,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { membershipUserNames, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { parseCsv, readXlsx, toXlsx } from '../../platform/export/tabular';
import { AppError, Errors } from '../../platform/http/errors';
import type { UploadedFile } from '../documents/documents.service';
import { definitionView } from '../custom-fields/custom-fields.service';
import { candidateName } from '../recruitment/recruitment-common';
import { type CrmActor, CrmAccessService } from './crm-access.service';
import { crmSettings, type Doc, phonePattern, recordActivity, sourcesOf, stagesOf } from './crm-common';
import { CrmFieldsService } from './crm-fields.service';
import { CrmService } from './crm.service';

export const CRM_IMPORT_MAX_ROWS = 5000;
const CRM_IMPORT_MAX_BYTES = 8 * 1024 * 1024;

type RowStatus = 'ready' | 'error' | 'duplicate';
interface Prepared {
  row: number;
  status: RowStatus;
  errors: { column: string; message: string }[];
  data: Doc;
  name: string;
  match?: { id: string; code: string | null; name: string; by: string; visible: boolean };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const splitList = (v: string) => [...new Set(v.split(/[,;|\n]/).map((x) => x.trim()).filter(Boolean))];

let countryNames: Map<string, string> | null = null;
/** "India", "IN", "india" -> "IN". */
function countryOf(raw: string): string | null {
  const s = raw.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  if (!countryNames) {
    countryNames = new Map();
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      try { const n = dn.of(code); if (n && n !== code) countryNames.set(norm(n), code); } catch { /* not a region */ }
    }
    countryNames.set('usa', 'US'); countryNames.set('uk', 'GB'); countryNames.set('uae', 'AE');
  }
  return countryNames.get(norm(s)) ?? null;
}

/** "Recruitment Agency", "agency", "Agency" -> the key of a list entry (by key or label). */
function choose(list: readonly { key: string; label: string }[], raw: string): string | null {
  const n = norm(raw);
  return list.find((x) => norm(x.key) === n || norm(x.label) === n)?.key ?? list.find((x) => norm(x.label).startsWith(n) || n.startsWith(norm(x.label)))?.key ?? null;
}
const pairs = (list: readonly (readonly [string, string, ...unknown[]])[]) => list.map(([key, label]) => ({ key, label }));

/**
 * Candidate CRM import, in the order the page walks through it: upload a file (Excel or CSV), map its columns to
 * candidate fields (guessed from the headers, or from a saved template), check every row (formats, required fields,
 * duplicates in the file and in the database), choose what to do with duplicates (skip, update, create, or decide
 * row by row), run it, and download a report of anything that did not go in. Every import is kept in the history.
 */
@Injectable()
export class CrmImportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: CrmAccessService,
    private readonly fields: CrmFieldsService,
    private readonly crm: CrmService,
    private readonly audit: AuditService,
  ) {}

  private read(file: UploadedFile | undefined): string[][] {
    if (!file?.buffer?.length) throw Errors.badRequest('file_required', 'Choose an Excel (.xlsx) or CSV file');
    if (file.size > CRM_IMPORT_MAX_BYTES) throw Errors.badRequest('file_too_large', 'The file is over 8 MB. Split it into smaller files.');
    let rows: string[][];
    if (file.buffer[0] === 0x50 && file.buffer[1] === 0x4b) {
      try { rows = readXlsx(file.buffer, CRM_IMPORT_MAX_ROWS + 10); } catch { throw Errors.badRequest('unreadable_file', 'This file could not be read as an Excel workbook. Save it as .xlsx or CSV and try again.'); }
    } else {
      if (file.buffer[0] === 0xd0 && file.buffer[1] === 0xcf) throw Errors.badRequest('unreadable_file', 'This is an old Excel file (.xls). Save it as .xlsx or CSV and try again.');
      const text = file.buffer.toString('utf8');
      if (text.includes('\u0000')) throw Errors.badRequest('unreadable_file', 'Upload an Excel workbook (.xlsx) or a CSV file');
      rows = parseCsv(text);
    }
    return rows.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  }

  private async importOf(tx: TenantTx, a: CrmActor, id: string) {
    const imp = await tx.collection('candidate_imports').findOne({ id });
    if (!imp) throw Errors.notFound('Import');
    const key = imp.hr_workspace_id ?? 'central';
    if (a.level !== 'super' && !a.keys.includes(key) && imp.created_by_membership_id !== a.membershipId) throw Errors.notFound('Import');
    return imp;
  }

  /** Fields an imported column can fill, including the custom fields marked for import. */
  private async targets(tx: TenantTx, owner: string | null) {
    const defs = await this.fields.definitionsFor(tx, owner, 'import');
    return {
      defs,
      list: [
        ...CRM_IMPORT_FIELDS.map((f) => ({ key: f.key, label: f.label, group: 'Candidate' })),
        ...defs.filter((d) => d.type !== 'file').map((d) => ({ key: `cf:${d.key}`, label: d.label as string, group: 'Custom fields' })),
      ],
    };
  }

  async upload(file: UploadedFile | undefined, hrWorkspaceId: string | null | undefined) {
    const rows = this.read(file);
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const owner = this.access.ownerFor(a, hrWorkspaceId);
      this.access.require(a, 'import', { crm_hr_workspace_id: owner, crm_shared_hr_workspace_ids: [] });
      const [head = [], ...body] = rows;
      const headers = head.map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
      if (new Set(headers.map((h) => h.toLowerCase())).size !== headers.length) throw Errors.badRequest('duplicate_columns', 'Two columns have the same heading. Rename one and upload again.');
      if (!body.length) throw Errors.badRequest('no_rows', 'The file has headings but no candidates');
      if (body.length > CRM_IMPORT_MAX_ROWS) throw Errors.badRequest('too_many_rows', `Import up to ${CRM_IMPORT_MAX_ROWS.toLocaleString('en-IN')} candidates at a time. Split the file and import each part.`);
      const data = body.map((r) => headers.map((_, i) => String(r[i] ?? '').trim()));
      const row = await tx.collection('candidate_imports').insert({
        file_name: (file!.originalname || 'import').slice(0, 200), headers, rows: data, hr_workspace_id: owner, created_by_membership_id: a.membershipId, status: 'uploaded',
        counts: { total: data.length },
      });
      return { ...(await this.describe(tx, a, row)), mapping: await this.suggest(tx, owner, headers) };
    });
  }

  /** A mapping for these headers: a saved template that covers every column, else a guess from each heading. */
  private async suggest(tx: TenantTx, owner: string | null, headers: string[]) {
    const templates = await tx.collection('candidate_import_templates').find({ hr_workspace_id: owner }, { sort: { updated_at: -1 } });
    const fit = templates.find((t) => headers.every((h) => Object.prototype.hasOwnProperty.call(t.mapping ?? {}, h)));
    if (fit) return { templateId: fit.id as string, templateName: fit.name as string, fields: Object.fromEntries(headers.map((h) => [h, (fit.mapping[h] as string | null) ?? null])) };
    const { defs } = await this.targets(tx, owner);
    const custom = defs.map((d) => ({ key: d.key as string, label: d.label as string }));
    const used = new Set<string>();
    const fields: Record<string, string | null> = {};
    for (const h of headers) {
      const g = guessImportField(h, custom);
      fields[h] = g && !used.has(g) ? g : null;
      if (g) used.add(g);
    }
    return { templateId: null, templateName: null, fields };
  }

  private async describe(tx: TenantTx, a: CrmActor, imp: Doc) {
    const owner = (imp.hr_workspace_id as string | null) ?? null;
    const { list } = await this.targets(tx, owner);
    const templates = await tx.collection('candidate_import_templates').find({ hr_workspace_id: owner }, { sort: { name: 1 } });
    const spaces = owner ? await tx.collection('hr_workspaces').findOne({ id: owner }, { projection: { name: 1 } }) : null;
    return {
      id: imp.id as string, fileName: imp.file_name as string, status: imp.status as string, headers: imp.headers as string[], rowCount: (imp.rows as unknown[]).length,
      sample: (imp.rows as string[][]).slice(0, 5), hrWorkspaceId: owner, hrWorkspaceName: owner ? spaces?.name ?? 'HR Workspace' : 'Super Workspace',
      fields: list, templates: templates.map((t) => ({ id: t.id as string, name: t.name as string, mapping: t.mapping as Record<string, string | null> })),
      savedMapping: imp.mapping ?? {}, duplicateAction: imp.duplicate_action ?? null, counts: imp.counts ?? {},
      canRun: a.canManage,
    };
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const imp = await this.importOf(tx, a, id);
      return { ...(await this.describe(tx, a, imp)), results: ((imp.results ?? []) as Doc[]).filter((r) => r.status !== 'created' && r.status !== 'ready').slice(0, 1000) };
    });
  }

  /** Reads each row with the mapping: the candidate it describes, problems found, and any record it matches. */
  private async prepare(tx: TenantTx, a: CrmActor, imp: Doc, plan: CrmImportPlanInput): Promise<Prepared[]> {
    const owner = (imp.hr_workspace_id as string | null) ?? null;
    const headers = imp.headers as string[];
    const { defs } = await this.targets(tx, owner);
    const defByKey = new Map(defs.map((d) => [`cf:${d.key}`, d]));
    const allowed = new Set([...CRM_IMPORT_FIELDS.map((f) => f.key), ...defByKey.keys()]);
    const mapping = Object.entries(plan.mapping).filter(([h, t]) => t && headers.includes(h));
    const targets = mapping.map(([, t]) => t!);
    for (const t of targets) if (!allowed.has(t)) throw Errors.validation([{ path: 'mapping', message: `Unknown field ${t}` }]);
    const dupTarget = targets.find((t, i) => targets.indexOf(t) !== i);
    if (dupTarget) throw Errors.validation([{ path: 'mapping', message: `Two columns are mapped to ${CRM_IMPORT_FIELDS.find((f) => f.key === dupTarget)?.label ?? dupTarget}` }]);
    const has = (k: string) => targets.includes(k);
    if (!has('fullName') && !has('firstName')) throw Errors.validation([{ path: 'mapping', message: 'Map a column to Full Name or First Name' }]);
    if (!has('email') && !has('phone')) throw Errors.validation([{ path: 'mapping', message: 'Map a column to Email Address or Primary Phone' }]);

    const settings = await crmSettings(tx);
    const sources = sourcesOf(settings).filter((s) => s.active);
    const stages = stagesOf(settings).filter((s) => s.active);
    const match = new Set((settings.match_fields as string[] | undefined) ?? ['email', 'phone', 'candidate_code']);
    const col = new Map(mapping.map(([h, t]) => [t!, headers.indexOf(h)]));
    const label = (t: string) => mapping.find(([, x]) => x === t)?.[0] ?? t;
    if (plan.defaults.source && !sources.some((s) => s.key === plan.defaults.source)) throw Errors.validation([{ path: 'defaults.source', message: 'Choose a source from the list' }]);
    if (plan.defaults.stage && !stages.some((s) => s.key === plan.defaults.stage)) throw Errors.validation([{ path: 'defaults.stage', message: 'Choose a stage from the pipeline' }]);

    const out: Prepared[] = [];
    const rows = imp.rows as string[][];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const v = (t: string) => (col.has(t) ? (r[col.get(t)!] ?? '').trim() : '');
      const errors: Prepared['errors'] = [];
      const bad = (t: string, message: string) => errors.push({ column: label(t), message });
      const d: Doc = { references: [], customFields: {}, fromDefaults: [] as string[] };
      if (v('fullName')) Object.assign(d, splitName(v('fullName')));
      for (const k of ['firstName', 'middleName', 'lastName', 'address', 'city', 'state', 'postalCode', 'currentLocation', 'profession', 'currentTitle', 'industry', 'department', 'jobRole', 'currentCompany', 'previousCompany', 'institution', 'remark', 'summary']) {
        if (v(k)) d[k] = v(k);
      }
      for (const k of ['email', 'alternateEmail']) {
        if (!v(k)) continue;
        const e = v(k).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) bad(k, 'Not a valid email address'); else d[k] = e;
      }
      for (const k of ['phone', 'alternatePhone', 'whatsapp', 'referencePhone']) {
        if (!v(k)) continue;
        const p = normalisePhone(v(k));
        if (!p.ok) bad(k, p.error); else d[k] = p.value;
      }
      if (v('gender')) d.gender = choose(pairs(GENDER_OPTIONS), v('gender')) ?? v('gender').slice(0, 20);
      if (v('dateOfBirth')) { const x = parseDate(v('dateOfBirth')); if (!x) bad('dateOfBirth', 'Use a date such as 15/04/1994 or 1994-04-15'); else d.dateOfBirth = x; }
      if (v('country')) { const x = countryOf(v('country')); if (!x) bad('country', 'Not a country we recognise'); else d.country = x; }
      if (v('languages')) d.languages = splitList(v('languages')).slice(0, 20);
      if (v('skills')) d.primarySkills = splitList(v('skills')).slice(0, 40);
      if (v('tags')) d.tags = splitList(v('tags')).slice(0, 20);
      if (v('preferredLocations')) d.preferences = { locations: splitList(v('preferredLocations')).slice(0, 20) };
      for (const k of ['totalExperienceMonths', 'relevantExperienceMonths']) {
        if (!v(k)) continue;
        const m = parseExperience(v(k));
        if (m === null) bad(k, 'Write experience as 5, 5.5, 5 years 4 months or 64 months'); else d[k] = m;
      }
      if (v('highestQualification')) d.highestQualification = choose(pairs(QUALIFICATIONS), v('highestQualification')) ?? 'other';
      if (v('graduationYear')) { const y = Number(v('graduationYear')); if (!Number.isInteger(y) || y < 1950 || y > 2100) bad('graduationYear', 'Use a year such as 2018'); else d.graduationYear = y; }
      const comp: Doc = {};
      for (const k of ['currentCtc', 'expectedCtc']) {
        if (!v(k)) continue;
        const m = parseAmount(v(k));
        if (m === null) bad(k, 'Write the amount as 450000, 4.5 LPA, 6 L or 50k'); else comp[k] = m;
      }
      if (v('currency')) { if (!/^[A-Za-z]{3}$/.test(v('currency'))) bad('currency', 'Use a 3-letter code such as INR'); else comp.currency = v('currency').toUpperCase(); }
      if (Object.keys(comp).length) d.compensation = comp;
      if (v('notice')) { const n = parseNotice(v('notice')); if (!n) bad('notice', 'Write the notice period as Immediate, 30 days, 2 months or Negotiable'); else d.notice = n; }
      const links: Doc = {};
      for (const k of ['linkedin', 'portfolio', 'github', 'website']) {
        if (!v(k)) continue;
        const u = crmUrl.safeParse(v(k));
        if (!u.success || !u.data) bad(k, 'Not a valid web address'); else links[k] = u.data;
      }
      if (Object.keys(links).length) d.links = links;
      if (v('source')) {
        // Job portals and referrals go by many names in recruiters' sheets; anything else is kept as "Other" with the text as the detail.
        const raw = v('source');
        const alias = /naukri|indeed|monster|shine|foundit|timesjobs|glassdoor|apna|instahyre|hirist|iimjobs|portal/i.test(raw) ? 'job_portal'
          : /^referral$|employee ref/i.test(raw) ? 'employee_referral' : /consult/i.test(raw) ? 'consultant' : /agency|vendor/i.test(raw) ? 'agency' : null;
        const s = choose(sources, raw) ?? (alias && sources.some((x) => x.key === alias) ? alias : null);
        if (s) d.source = s;
        else if (sources.some((x) => x.key === 'other')) { d.source = 'other'; d.sourceDetail ??= raw.slice(0, 120); }
        else bad('source', `Not one of the candidate sources (${sources.slice(0, 4).map((x) => x.label).join(', ')} ...)`);
        if (alias && s === alias) d.sourceDetail ??= raw.slice(0, 120);
      }
      else if (plan.defaults.source) { d.source = plan.defaults.source; d.fromDefaults.push('source'); }
      if (v('stage')) { const s = choose(stages, v('stage')); if (!s) bad('stage', 'Not one of the pipeline stages'); else d.stage = s; }
      else if (plan.defaults.stage) { d.stage = plan.defaults.stage; d.fromDefaults.push('stage'); }
      if (v('referenceType') || v('referenceName') || d.referencePhone) {
        const t = v('referenceType') ? choose(pairs(REFERENCE_TYPES), v('referenceType')) : 'other';
        if (!t) bad('referenceType', 'Not one of the reference types'); else d.references = [{ type: t, name: v('referenceName') || null, phone: d.referencePhone ?? null }];
      }
      delete d.referencePhone;
      if (plan.defaults.tag) d.tags = [...new Set([...((d.tags as string[] | undefined) ?? []), plan.defaults.tag])];
      if (plan.defaults.assignedRecruiterMembershipId) { d.assignedRecruiterMembershipId = plan.defaults.assignedRecruiterMembershipId; d.fromDefaults.push('assignedRecruiterMembershipId'); }
      for (const [t, def] of defByKey) {
        if (!v(t)) continue;
        let raw: unknown = v(t);
        if (def.type === 'multi_select') raw = splitList(v(t)).map((x) => def.options?.find((o: Doc) => norm(o.label) === norm(x) || o.value === x)?.value ?? x);
        if (['dropdown', 'searchable_dropdown', 'radio'].includes(def.type)) raw = def.options?.find((o: Doc) => norm(o.label) === norm(v(t)) || o.value === v(t))?.value ?? v(t);
        if (['checkbox', 'yes_no'].includes(def.type)) raw = /^(y|yes|true|1)$/i.test(v(t)) ? true : /^(n|no|false|0)$/i.test(v(t)) ? false : v(t);
        if (def.type === 'date') raw = parseDate(v(t)) ?? v(t);
        const c = checkFieldValue(definitionView(def), raw);
        if (!c.ok) bad(t, c.error); else d.customFields[def.key] = c.value;
      }
      if (!d.firstName) bad(has('fullName') ? 'fullName' : 'firstName', 'The name is empty');
      if (!d.email && !d.phone && !errors.some((e) => [label('email'), label('phone')].includes(e.column))) errors.push({ column: 'Email / Phone', message: 'Give an email address or a phone number' });
      if (!errors.length) {
        const { fromDefaults: _skip, ...fields } = d;
        const p = crmCandidateInput.safeParse({ ...fields, lawfulBasisConfirmed: true, hrWorkspaceId: owner });
        if (!p.success) for (const issue of p.error.issues) errors.push({ column: String(issue.path[0] ?? ''), message: issue.message });
        else Object.assign(d, { parsed: p.data });
      }
      out.push({ row: i + 2, status: errors.length ? 'error' : 'ready', errors, data: d, name: [d.firstName, d.lastName].filter(Boolean).join(' ') || '(no name)' });
    }

    // Duplicates inside the file: the second and later rows with the same email or phone.
    const seen = new Map<string, number>();
    for (const p of out) {
      for (const k of [p.data.email ? `e:${p.data.email}` : null, phoneKey(p.data.phone) ? `p:${phoneKey(p.data.phone)}` : null]) {
        if (!k) continue;
        const first = seen.get(k);
        if (first !== undefined && p.status !== 'error') { p.status = 'error'; p.errors.push({ column: k.startsWith('e:') ? label('email') : label('phone'), message: `Same ${k.startsWith('e:') ? 'email' : 'phone'} as row ${first} in this file` }); }
        if (first === undefined) seen.set(k, p.row);
      }
    }
    // Records already in the company's candidate database.
    const ready = out.filter((p) => p.status === 'ready');
    const emails = match.has('email') ? ready.map((p) => p.data.email).filter(Boolean) : [];
    const phones = match.has('phone') ? ready.map((p) => phoneKey(p.data.phone)).filter(Boolean) as string[] : [];
    const codes = match.has('candidate_code') && has('candidateCode') ? ready.map((p) => (imp.rows as string[][])[p.row - 2]![col.get('candidateCode')!]?.trim().toUpperCase()).filter(Boolean) : [];
    const or: Doc[] = [];
    if (emails.length) or.push({ email: { $in: emails } });
    if (codes.length) or.push({ candidate_code: { $in: codes } });
    for (let i = 0; i < phones.length; i += 50) or.push({ phone: { $regex: `(${phones.slice(i, i + 50).map((x) => phonePattern(x)).join('|')})` } });
    const existing = or.length ? await tx.collection('candidates').find({ $or: or, anonymized_at: null }, { projection: { email: 1, phone: 1, candidate_code: 1, first_name: 1, last_name: 1, crm_hr_workspace_id: 1, crm_shared_hr_workspace_ids: 1 } }) : [];
    const visible = new Set(existing.length ? await tx.collection('candidates').distinct<string>('id', { $and: [{ id: { $in: existing.map((e) => e.id) } }, this.access.filter(a)] }) : []);
    const byEmail = new Map(existing.filter((e) => e.email).map((e) => [e.email as string, e]));
    const byPhone = new Map(existing.filter((e) => phoneKey(e.phone)).map((e) => [phoneKey(e.phone)!, e]));
    const byCode = new Map(existing.filter((e) => e.candidate_code).map((e) => [e.candidate_code as string, e]));
    for (const p of ready) {
      const code = has('candidateCode') ? (imp.rows as string[][])[p.row - 2]![col.get('candidateCode')!]?.trim().toUpperCase() : '';
      const hit = (code && byCode.get(code) && ['candidate_code', byCode.get(code)] as const)
        || (p.data.email && byEmail.get(p.data.email) && ['email', byEmail.get(p.data.email)] as const)
        || (phoneKey(p.data.phone) && byPhone.get(phoneKey(p.data.phone)!) && ['phone', byPhone.get(phoneKey(p.data.phone)!)] as const)
        || null;
      if (!hit) continue;
      const [by, e] = hit as readonly [string, Doc];
      p.status = 'duplicate';
      p.match = { id: e.id, code: e.candidate_code ?? null, name: candidateName(e), by, visible: visible.has(e.id) };
      if (!p.match.visible) p.errors.push({ column: by === 'email' ? label('email') : by === 'phone' ? label('phone') : label('candidateCode'), message: 'This candidate is already in the company’s database under another HR Workspace' });
    }
    return out;
  }

  private summary(prepared: Prepared[]) {
    return {
      total: prepared.length,
      ready: prepared.filter((p) => p.status === 'ready').length,
      errors: prepared.filter((p) => p.status === 'error').length,
      duplicates: prepared.filter((p) => p.status === 'duplicate').length,
    };
  }

  /** Checks every row with the mapping, without importing anything. */
  async check(id: string, plan: CrmImportPlanInput) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const imp = await this.importOf(tx, a, id);
      if (!['uploaded', 'checked'].includes(imp.status)) throw Errors.conflict('import_closed', `This import is ${imp.status}`);
      const prepared = await this.prepare(tx, a, imp, plan);
      const counts = this.summary(prepared);
      const results = prepared.map((p) => ({ row: p.row, status: p.status, name: p.name, errors: p.errors, match: p.match ?? null }));
      await tx.collection('candidate_imports').updateOne({ id }, { $set: { status: 'checked', mapping: plan.mapping, duplicate_action: plan.duplicateAction, results, counts } });
      return {
        counts,
        problems: results.filter((r) => r.status !== 'ready').slice(0, 1000),
        preview: prepared.filter((p) => p.status === 'ready').slice(0, 10).map((p) => ({
          row: p.row, name: p.name, email: p.data.email ?? null, phone: p.data.phone ?? null, currentCompany: p.data.currentCompany ?? null, stage: p.data.stage ?? 'new', source: p.data.source ?? null,
        })),
      };
    });
  }

  /** Imports the rows. Each row goes in on its own, so one problem never stops the rest; the result says what happened to each. */
  async run(id: string, plan: CrmImportPlanInput) {
    if (!plan.lawfulBasisConfirmed) throw Errors.validation([{ path: 'lawfulBasisConfirmed', message: 'Confirm these candidates agreed to share their details for recruitment' }]);
    const { prepared, imp, owner } = await this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const imp = await this.importOf(tx, a, id);
      if (!['uploaded', 'checked'].includes(imp.status)) throw Errors.conflict('import_closed', `This import is ${imp.status}`);
      this.access.require(a, 'import', { crm_hr_workspace_id: imp.hr_workspace_id ?? null, crm_shared_hr_workspace_ids: [] });
      // Claim it, so a second click does not import the same rows twice.
      const claimed = await tx.collection('candidate_imports').update({ id, status: { $in: ['uploaded', 'checked'] } }, { $set: { status: 'completed', mapping: plan.mapping, duplicate_action: plan.duplicateAction } });
      if (!claimed) throw Errors.conflict('import_closed', 'This import has already run');
      return { prepared: await this.prepare(tx, a, imp, plan), imp, owner: (imp.hr_workspace_id as string | null) ?? null };
    });
    const results: Doc[] = [];
    for (const p of prepared) {
      const base = { row: p.row, name: p.name, match: p.match ?? null };
      if (p.status === 'error' || (p.match && !p.match.visible)) { results.push({ ...base, status: 'failed', errors: p.errors }); continue; }
      const action = p.status === 'duplicate' ? (plan.rowActions[String(p.row)] ?? plan.duplicateAction) : 'create';
      if (action === 'skip' || action === 'review') { results.push({ ...base, status: 'skipped', errors: [{ column: '', message: action === 'review' ? 'Possible duplicate, not decided' : `Already in the database as ${p.match?.code ?? p.match?.name}` }] }); continue; }
      try {
        if (action === 'update') {
          const patch: Doc = {};
          // An update takes what the file says; the defaults chosen for new rows (stage, source, recruiter) are left out.
          const parsed = p.data.parsed as CrmCandidateInput;
          const defaulted = new Set(p.data.fromDefaults as string[]);
          if (defaulted.has('stage')) delete (parsed as Doc).stage;
          for (const [k, val] of Object.entries(parsed)) {
            if (['references', 'remark', 'lawfulBasisConfirmed', 'hrWorkspaceId', 'requisitionId', 'allowPhoneDuplicate', 'stage'].includes(k) || defaulted.has(k)) continue;
            if (val === null || val === undefined || (Array.isArray(val) && !val.length) || (typeof val === 'object' && !Array.isArray(val) && !Object.keys(val as object).length)) continue;
            patch[k] = val;
          }
          // Sections in the file are added to what the record already holds, not swapped for it.
          await this.db.tenant(async (tx) => {
            const c = await tx.collection('candidates').findOne({ id: p.match!.id }, { projection: { compensation: 1, comp_currency: 1, comp_basis: 1, current_ctc: 1, expected_ctc: 1, links: 1, preferences: 1 } });
            const keep = (o: Doc) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== null && x !== undefined && !(Array.isArray(x) && !x.length)));
            if (patch.compensation) patch.compensation = { currency: c?.comp_currency ?? 'INR', basis: c?.comp_basis ?? 'annual', currentCtc: c?.current_ctc ?? null, expectedCtc: c?.expected_ctc ?? null, ...(c?.compensation ?? {}), ...keep(patch.compensation) };
            if (patch.links) patch.links = { other: [], ...(c?.links ?? {}), ...keep(patch.links) };
            if (patch.preferences) patch.preferences = { ...(c?.preferences ?? {}), ...keep(patch.preferences) };
          });
          await this.crm.update(p.match!.id, patch);
          await this.db.tenant(async (tx) => {
            const a = await this.access.actor(tx, 'manage');
            const c = await this.access.candidate(tx, a, p.match!.id);
            if (parsed.stage && parsed.stage !== c.crm_stage) await this.crm.stageIn(tx, a, c, parsed.stage);
            for (const r of parsed.references) await tx.collection('candidate_references').insert({ candidate_id: c.id, ...r, created_by_membership_id: a.membershipId });
            if (parsed.references.length) await tx.collection('candidates').updateOne({ id: c.id }, { $set: { reference_types: await tx.collection('candidate_references').distinct<string>('type', { candidate_id: c.id }) } });
            if (parsed.remark) await this.crm.addRemark(tx, a, c, { body: parsed.remark, category: 'general', restricted: false });
            await recordActivity(tx, c.id, 'imported', { detail: { importId: id, fileName: imp.file_name, updated: true } });
          });
          results.push({ ...base, status: 'updated', candidateId: p.match!.id });
        } else {
          const input = { ...(p.data.parsed as CrmCandidateInput), hrWorkspaceId: owner, allowPhoneDuplicate: true };
          const made = await this.db.tenant(async (tx) => this.crm.createIn(tx, await this.access.actor(tx, 'manage'), input, { importId: id, fileName: imp.file_name }));
          results.push({ ...base, status: 'created', candidateId: made.id, candidateCode: made.candidateCode });
        }
      } catch (e) {
        if (!(e instanceof AppError) || e.getStatus() >= 500) throw e;
        const body = e.getResponse() as { message: string; details?: { path: string; message: string }[] };
        results.push({ ...base, status: 'failed', errors: Array.isArray(body.details) ? body.details.map((x) => ({ column: x.path, message: x.message })) : [{ column: '', message: body.message }] });
      }
    }
    const counts = {
      total: prepared.length,
      created: results.filter((r) => r.status === 'created').length,
      updated: results.filter((r) => r.status === 'updated').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'failed').length,
    };
    await this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      await tx.collection('candidate_imports').updateOne({ id }, { $set: { results, counts, completed_at: new Date(), rows: (imp.rows as string[][]).map((r, i) => (results[i]?.status === 'created' || results[i]?.status === 'updated' ? [] : r)) } });
      if (plan.saveTemplate) {
        const name = plan.saveTemplate;
        const t = tx.collection('candidate_import_templates');
        const found = (await t.find({ hr_workspace_id: owner })).find((x) => String(x.name).toLowerCase() === name.toLowerCase());
        if (found) await t.updateOne({ id: found.id }, { $set: { mapping: plan.mapping } });
        else await t.insert({ name, mapping: plan.mapping, hr_workspace_id: owner, created_by_membership_id: a.membershipId });
      }
      await this.audit.record(tx, { action: 'candidate_crm.imported', resourceType: 'candidate_import', resourceId: id, changes: { counts }, metadata: { fileName: imp.file_name, duplicateAction: plan.duplicateAction } });
    });
    return { counts, problems: results.filter((r) => r.status === 'failed' || r.status === 'skipped').slice(0, 1000) };
  }

  async cancel(id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const imp = await this.importOf(tx, a, id);
      if (imp.status === 'completed') throw Errors.conflict('import_closed', 'This import has already run');
      await tx.collection('candidate_imports').updateOne({ id }, { $set: { status: 'cancelled', rows: [] } });
      return { cancelled: true };
    });
  }

  async history() {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const filter = a.level === 'super' ? {} : { $or: [{ created_by_membership_id: a.membershipId }, { hr_workspace_id: { $in: a.keys.filter((k) => k !== 'central') } }, ...(a.keys.includes('central') ? [{ hr_workspace_id: null }] : [])] };
      const rows = await tx.collection('candidate_imports').find(filter, { sort: { created_at: -1 }, limit: 50, projection: { file_name: 1, status: 1, counts: 1, created_at: 1, completed_at: 1, created_by_membership_id: 1, hr_workspace_id: 1, duplicate_action: 1 } });
      const names = await membershipUserNames(tx, rows.map((r) => r.created_by_membership_id));
      const spaces = new Map((await tx.collection('hr_workspaces').find({}, { projection: { name: 1 } })).map((w) => [w.id as string, w.name as string]));
      return {
        imports: rows.map((r) => ({
          id: r.id, fileName: r.file_name, status: r.status, counts: r.counts ?? {}, createdAt: r.created_at, completedAt: r.completed_at ?? null, by: names.get(r.created_by_membership_id) ?? null,
          hrWorkspace: r.hr_workspace_id ? spaces.get(r.hr_workspace_id) ?? 'HR Workspace' : 'Super Workspace', duplicateAction: r.duplicate_action ?? null,
        })),
        canImport: this.access.has(a, 'import'),
      };
    });
  }

  async deleteTemplate(id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const t = await tx.collection('candidate_import_templates').findOne({ id });
      if (!t || (a.level !== 'super' && !a.keys.includes(t.hr_workspace_id ?? 'central'))) throw Errors.notFound('Template');
      await tx.collection('candidate_import_templates').delete({ id });
      return { deleted: true };
    });
  }

  /** The rows that did not go in (or have problems), with the original columns and what is wrong, as Excel. */
  async errorReport(id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const imp = await this.importOf(tx, a, id);
      const headers = imp.headers as string[];
      const rows = imp.rows as string[][];
      const bad = ((imp.results ?? []) as Doc[]).filter((r) => !['created', 'updated', 'ready'].includes(r.status));
      const out = [['Row', 'Result', 'Problems', ...headers], ...bad.map((r) => [
        r.row, r.status === 'duplicate' ? `Possible duplicate of ${r.match?.code ?? r.match?.name ?? 'a candidate'}` : r.status,
        ((r.errors ?? []) as Doc[]).map((e) => (e.column ? `${e.column}: ${e.message}` : e.message)).join('; '), ...(rows[r.row - 2] ?? []),
      ])];
      return { fileName: `${String(imp.file_name).replace(/\.[a-z]+$/i, '')}-problems.xlsx`, content: toXlsx('Problems', out) };
    });
  }

  /** A blank workbook with the usual columns and one example row. */
  async sampleFile() {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const defs = (await this.fields.definitionsForActor(tx, a, 'import')).filter((d) => d.type !== 'file');
      const cols = ['Full Name', 'Email Address', 'Primary Phone', 'Current Company', 'Current Job Title', 'Total Experience', 'Current CTC', 'Expected CTC', 'Notice Period', 'City', 'Primary Skills', 'Candidate Source', 'Reference', 'Reference Contact Number', 'LinkedIn URL', 'Recruiter Remarks'];
      const example = ['Kunal Sharma', 'kunal.sharma@example.com', '+91 98200 11122', 'Acme Analytics', 'Senior Data Analyst', '6 years 4 months', '12 LPA', '16 LPA', '30 days', 'Pune', 'SQL, Python, Tableau', 'LinkedIn', 'Priya Nair', '+91 98200 33344', 'linkedin.com/in/kunal-sharma', 'Open to hybrid roles'];
      return { fileName: 'candidate-import-template.xlsx', content: toXlsx('Candidates', [[...cols, ...defs.map((d) => d.label as string)], [...example, ...defs.map(() => '')]]) };
    });
  }
}

export const importLabel = (key: string) => crmLabel(CRM_IMPORT_FIELDS.map((f) => [f.key, f.label] as const), key);
