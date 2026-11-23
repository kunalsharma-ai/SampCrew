import {
  CANDIDATE_IMPORT_FIELDS,
  CANDIDATE_SOURCE_KIND,
  CANDIDATE_SOURCES,
  candidateInput,
  CLIENT_IMPORT_FIELDS,
  clientContactInput,
  clientInput,
  CONTACT_IMPORT_FIELDS,
  DEPARTMENT_IMPORT_FIELDS,
  JOB_TITLE_IMPORT_FIELDS,
  MASTER_VALUE_IMPORT_FIELDS,
  type MasterList,
  masterNorm,
  masterValueInput,
  sheetBool,
  sheetList,
  type ValueList,
} from '@crew/contracts';
import type { AuthzService } from '../../../platform/authz/authz.service';
import type { MongoService as DatabaseService, TenantTx } from '../../../platform/database/mongo.service';
import type { BidsService } from '../../bids/bids.service';
import { matchEntry } from '../../master-data/master-data.service';
import type { MasterDataService } from '../../master-data/master-data.service';
import type { CandidatesService } from '../../recruitment/candidates.service';
import { listValue } from './lists';
import { type Checked, type Doc, digits, type ImportAdapter, issue, lc, type ListNeed, type Lookups, type MappedRow, nameParts, phoneKey, sameInFile } from './types';

interface Deps { db: DatabaseService; authz: AuthzService; master: MasterDataService; candidates: CandidatesService; bids: BidsService; audit: (tx: TenantTx, e: Doc) => Promise<unknown> }

const blank = (): Checked => ({ issues: [], label: null, match: null, uniqueMatch: false, after: [], data: {} });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const zodIssues = (c: Checked, r: MappedRow, err: { issues: { path: PropertyKey[]; message: string }[] }, map: Record<string, string> = {}) => {
  for (const i of err.issues) {
    const f = String(i.path[0] ?? 'row');
    c.issues.push(issue(r, map[f] ?? f, 'error', i.message));
  }
};
const filled = (o: Doc) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));

// Candidates ----------------------------------------------------------------------------------------------------------

interface CandidateLookups extends Lookups { byEmail: Map<string, Doc>; byPhone: Map<string, Doc[]>; requisitions: Doc[] }

export function candidateAdapter(deps: Deps): ImportAdapter<CandidateLookups> {
  return {
    type: 'candidates',
    indexFields: ['email', 'phone'],
    fields: () => CANDIDATE_IMPORT_FIELDS,
    href: (id) => `/recruitment/candidates/${id}`,
    async load(tx, _o, base) {
      const rows = await tx.collection('candidates').find({ anonymized_at: null }, { projection: { email: 1, phone: 1, first_name: 1, last_name: 1 } });
      const byPhone = new Map<string, Doc[]>();
      for (const c of rows) if (digits(c.phone).length >= 7) byPhone.set(phoneKey(c.phone), [...(byPhone.get(phoneKey(c.phone)) ?? []), c]);
      return {
        ...base,
        byEmail: new Map(rows.map((c) => [lc(c.email), c])),
        byPhone,
        requisitions: await tx.collection('job_requisitions').find({ status: { $in: ['open', 'approved', 'on_hold'] } }, { projection: { code: 1, title: 1 } }),
      };
    },
    check(r, lk, file, options) {
      const c = blank();
      const v = r.values;
      const needs: ListNeed[] = [];
      const { first, last } = nameParts(v);
      c.label = [first, last].filter(Boolean).join(' ') || v.email || null;
      if (!first) c.issues.push(issue(r, v.fullName !== undefined ? 'fullName' : 'firstName', 'error', 'Enter the name'));
      const email = (v.email ?? '').toLowerCase();
      if (!email) c.issues.push(issue(r, 'email', 'error', 'Enter the email', 'Candidates are found and contacted by email'));
      else if (!EMAIL.test(email)) c.issues.push(issue(r, 'email', 'error', `${v.email} is not an email address`));
      const twin = sameInFile(file, 'email', lc(email), r.row);
      if (twin.length) c.issues.push(issue(r, 'email', 'error', `${v.email} is also on row ${twin[0]}`));
      for (const by of options.matchBy) {
        const hit = by === 'email' ? lk.byEmail.get(lc(email)) : by === 'phone' && digits(v.phone).length >= 7 && lk.byPhone.get(phoneKey(v.phone))?.length === 1 ? lk.byPhone.get(phoneKey(v.phone))![0] : undefined;
        if (hit) { c.match = { recordId: hit.id, label: `${hit.first_name} ${hit.last_name ?? ''}`.trim() + ` (${hit.email})`, by }; c.uniqueMatch = by === 'email'; break; }
      }
      const other = lk.byEmail.get(lc(email));
      if (other && other.id !== c.match?.recordId) c.issues.push(issue(r, 'email', 'error', `${v.email} is already the candidate ${other.first_name} ${other.last_name ?? ''}`.trim(), 'Match by email to update them'));

      // Source: a value of the Candidate sources list (its category says which kind) or one of the built-in kinds.
      let source: string = 'manual';
      let sourceDetail: string | undefined;
      if (v.source) {
        const kind = CANDIDATE_SOURCES.find((k) => masterNorm(k) === masterNorm(v.source!));
        if (kind) source = kind;
        else {
          const hit = listValue(r, 'source', 'candidate_source', lk, c, needs);
          if (hit && hit !== 'new') { source = CANDIDATE_SOURCE_KIND[hit.category ?? ''] ?? 'sourced'; sourceDetail = hit.label; } else if (hit === 'new') { source = 'sourced'; sourceDetail = v.source; }
        }
      }
      const tags = sheetList(v.tags ?? '');
      if (tags.some((t) => t.length > 30)) c.issues.push(issue(r, 'tags', 'error', 'Each tag can be up to 30 characters'));
      if (tags.length > 20) c.issues.push(issue(r, 'tags', 'error', 'Up to 20 tags'));
      let requisitionId: string | undefined;
      if (v.requisition) {
        const req = lk.requisitions.find((q) => lc(q.code) === lc(v.requisition) || lc(q.title) === lc(v.requisition));
        if (!req) c.issues.push(issue(r, 'requisition', 'error', `No open job called ${v.requisition}`, 'Use the job code from Recruitment, or leave it empty'));
        else if (c.match) c.issues.push(issue(r, 'requisition', 'warning', 'Existing candidates are not added to a job by an import: add them from their profile'));
        else requisitionId = req.id;
      }
      const data = filled({
        firstName: first, lastName: last, email, phone: v.phone, locationText: v.locationText, currentTitle: v.currentTitle, currentCompany: v.currentCompany,
        profileUrl: v.profileUrl, source, sourceDetail, tags, requisitionId,
      });
      if (!c.issues.some((i) => i.level === 'error')) {
        const parsed = c.match ? candidateInput.omit({ requisitionId: true, lawfulBasisConfirmed: true, source: true, referredByMembershipId: true }).partial().safeParse(data) : candidateInput.safeParse({ ...data, lawfulBasisConfirmed: true });
        if (!parsed.success) zodIssues(c, r, parsed.error, { sourceDetail: 'source', requisitionId: 'requisition' });
      }
      c.data = { input: data, needs };
      return c;
    },
    async write(c, _r, action, _lk, w) {
      return deps.db.tenant(async (tx) => {
        await w.ensureValues(tx, c.data.needs);
        if (action === 'update') {
          const { source: _s, sourceDetail: _d, requisitionId: _q, ...patch } = c.data.input;
          await deps.candidates.updateIn(tx, c.match!.recordId, patch);
          await w.saveCustom(tx, c.match!.recordId, false);
          return { id: c.match!.recordId, label: c.match!.label, action: 'updated' as const };
        }
        const input = candidateInput.parse({ ...c.data.input, lawfulBasisConfirmed: true });
        const out = await deps.candidates.createIn(tx, input, { sourceImportId: w.jobId });
        await w.saveCustom(tx, out.id, true);
        return { id: out.id, label: `${input.firstName} ${input.lastName}`.trim(), action: 'imported' as const };
      });
    },
  };
}

// Clients -------------------------------------------------------------------------------------------------------------

interface ClientLookups extends Lookups { byName: Map<string, Doc> }

export function clientAdapter(deps: Deps): ImportAdapter<ClientLookups> {
  return {
    type: 'clients',
    indexFields: ['name'],
    fields: () => CLIENT_IMPORT_FIELDS,
    href: () => '/staffing/clients',
    async load(tx, _o, base) {
      return { ...base, byName: new Map((await tx.collection('clients').find({}, { projection: { name: 1, archived_at: 1 } })).map((x) => [lc(x.name), x])) };
    },
    check(r, lk, file) {
      const c = blank();
      const v = r.values;
      const needs: ListNeed[] = [];
      c.label = v.name || null;
      if (!v.name) c.issues.push(issue(r, 'name', 'error', 'Enter the client name'));
      const twin = sameInFile(file, 'name', lc(v.name), r.row);
      if (twin.length) c.issues.push(issue(r, 'name', 'error', `${v.name} is also on row ${twin[0]}`));
      const hit = v.name ? lk.byName.get(lc(v.name)) : undefined;
      if (hit?.archived_at) c.issues.push(issue(r, 'name', 'error', `${hit.name} is an archived client`, 'Restore it in Staffing > Clients, or use another name'));
      else if (hit) { c.match = { recordId: hit.id, label: hit.name, by: 'name' }; c.uniqueMatch = true; }
      const industry = listValue(r, 'industry', 'industry', lk, c, needs);
      const currency = v.currency ? v.currency.toUpperCase() : undefined;
      if (currency && !/^[A-Z]{3}$/.test(currency)) c.issues.push(issue(r, 'currency', 'error', `${v.currency} is not a currency code`, 'Use three letters, such as INR or USD'));
      if (v.contactEmail && !EMAIL.test(v.contactEmail)) c.issues.push(issue(r, 'contactEmail', 'error', `${v.contactEmail} is not an email address`));
      const input = filled({
        name: v.name, legalName: v.legalName, industry: industry === 'new' ? v.industry : industry?.label, contactName: v.contactName, contactEmail: v.contactEmail?.toLowerCase(),
        contactPhone: v.contactPhone, address: v.address, currency, notes: v.notes,
      });
      if (!c.issues.some((i) => i.level === 'error')) {
        const parsed = (c.match ? clientInput.partial() : clientInput).safeParse(input);
        if (!parsed.success) zodIssues(c, r, parsed.error);
      }
      c.data = { input, needs };
      return c;
    },
    async write(c, _r, action, lk, w) {
      return deps.db.tenant(async (tx) => {
        await deps.authz.require('bids:manage', undefined, tx);
        await w.ensureValues(tx, c.data.needs);
        const input = c.data.input as Doc;
        if (action === 'update') {
          await deps.bids.updateClientIn(tx, c.match!.recordId, input);
          await w.saveCustom(tx, c.match!.recordId, false);
          return { id: c.match!.recordId, label: c.match!.label, action: 'updated' as const };
        }
        const client = await deps.bids.createClientIn(tx, clientInput.parse(input), { sourceImportId: w.jobId });
        if (input.contactName) {
          const { first, last } = nameParts({ fullName: input.contactName });
          await deps.bids.createContactIn(tx, client.id, clientContactInput.parse(filled({ firstName: first, lastName: last, email: input.contactEmail, phone: input.contactPhone, isPrimary: true })), { sourceImportId: w.jobId });
        }
        await w.saveCustom(tx, client.id, true);
        lk.byName.set(lc(client.name), { id: client.id, name: client.name });
        return { id: client.id, label: client.name, action: 'imported' as const };
      });
    },
  };
}

// Contacts ------------------------------------------------------------------------------------------------------------

interface ContactLookups extends Lookups { clients: Map<string, Doc>; contacts: Doc[] }

export function contactAdapter(deps: Deps): ImportAdapter<ContactLookups> {
  return {
    type: 'contacts',
    indexFields: ['email'],
    fields: () => CONTACT_IMPORT_FIELDS,
    href: () => '/staffing/clients',
    async load(tx, _o, base) {
      return {
        ...base,
        clients: new Map((await tx.collection('clients').find({ archived_at: null }, { projection: { name: 1 } })).map((x) => [lc(x.name), x])),
        contacts: await tx.collection('client_contacts').find({ archived_at: null }, { projection: { client_id: 1, email: 1, phone: 1, first_name: 1, last_name: 1 } }),
      };
    },
    check(r, lk, file, options) {
      const c = blank();
      const v = r.values;
      const { first, last } = nameParts(v);
      c.label = [first, last].filter(Boolean).join(' ') || v.email || null;
      const client = v.client ? lk.clients.get(lc(v.client)) : undefined;
      if (!v.client) c.issues.push(issue(r, 'client', 'error', 'Enter the client the contact works for'));
      else if (!client) c.issues.push(issue(r, 'client', 'error', `No client called ${v.client}`, 'Import or add the client first (Data import > Clients)'));
      if (!first) c.issues.push(issue(r, v.fullName !== undefined ? 'fullName' : 'firstName', 'error', 'Enter the name'));
      const email = (v.email ?? '').toLowerCase();
      if (email && !EMAIL.test(email)) c.issues.push(issue(r, 'email', 'error', `${v.email} is not an email address`));
      if (email) {
        const twin = (file.get('email')?.get(lc(email)) ?? []).filter((n) => n !== r.row);
        if (twin.length) c.issues.push(issue(r, 'email', 'warning', `${v.email} is also on row ${twin[0]}`));
      }
      const isPrimary = v.isPrimary ? sheetBool(v.isPrimary) : false;
      if (v.isPrimary && isPrimary === null) c.issues.push(issue(r, 'isPrimary', 'error', `${v.isPrimary} is not Yes or No`));
      if (client) {
        const mine = lk.contacts.filter((x) => x.client_id === client.id);
        for (const by of options.matchBy) {
          const hit = by === 'email' && email ? mine.find((x) => lc(x.email) === email) : by === 'phone' && digits(v.phone).length >= 7 ? mine.find((x) => phoneKey(x.phone) === phoneKey(v.phone)) : undefined;
          if (hit) { c.match = { recordId: hit.id, label: `${hit.first_name} ${hit.last_name ?? ''}`.trim() + ` at ${client.name}`, by }; c.uniqueMatch = by === 'email'; break; }
        }
        const other = email ? mine.find((x) => lc(x.email) === email) : undefined;
        if (other && other.id !== c.match?.recordId) c.issues.push(issue(r, 'email', 'error', `${client.name} already has a contact with ${v.email}`, 'Match by email to update them'));
      }
      const input = filled({ firstName: first, lastName: last, email, phone: v.phone, jobTitle: v.jobTitle, isPrimary: isPrimary ?? undefined, notes: v.notes });
      if (!c.issues.some((i) => i.level === 'error')) {
        const parsed = (c.match ? clientContactInput.partial() : clientContactInput).safeParse(input);
        if (!parsed.success) zodIssues(c, r, parsed.error);
      }
      c.data = { input, clientId: client?.id };
      return c;
    },
    async write(c, _r, action, lk, w) {
      return deps.db.tenant(async (tx) => {
        await deps.authz.require('bids:manage', undefined, tx);
        if (action === 'update') {
          await deps.bids.updateContactIn(tx, c.data.clientId, c.match!.recordId, c.data.input);
          return { id: c.match!.recordId, label: c.match!.label, action: 'updated' as const };
        }
        const out = await deps.bids.createContactIn(tx, c.data.clientId, clientContactInput.parse(c.data.input), { sourceImportId: w.jobId });
        lk.contacts.push({ id: out.id, client_id: out.clientId, email: out.email, phone: out.phone, first_name: out.firstName, last_name: out.lastName });
        return { id: out.id, label: out.name, action: 'imported' as const };
      });
    },
  };
}

// Departments ---------------------------------------------------------------------------------------------------------

interface DepartmentLookups extends Lookups { departments: Doc[]; entities: Doc[] }

export function departmentAdapter(deps: Deps): ImportAdapter<DepartmentLookups> {
  const find = (lk: DepartmentLookups, text: string) => lk.departments.find((d) => lc(d.name) === lc(text)) ?? lk.departments.find((d) => d.code && lc(d.code) === lc(text));
  return {
    type: 'departments',
    indexFields: ['name', 'code'],
    fields: () => DEPARTMENT_IMPORT_FIELDS,
    href: () => '/organization/departments',
    async load(tx, _o, base) {
      return { ...base, departments: await tx.collection('departments').find({}, { projection: { name: 1, code: 1, parent_id: 1, legal_entity_id: 1, archived_at: 1 } }), entities: await tx.collection('legal_entities').find({ archived_at: null }) };
    },
    check(r, lk, file, options) {
      const c = blank();
      const v = r.values;
      c.label = v.name || null;
      if (!v.name) c.issues.push(issue(r, 'name', 'error', 'Enter the department name'));
      const twin = sameInFile(file, 'name', lc(v.name), r.row);
      if (twin.length) c.issues.push(issue(r, 'name', 'error', `${v.name} is also on row ${twin[0]}`));
      if (v.code) {
        if (!/^[A-Za-z0-9._-]{1,20}$/.test(v.code)) c.issues.push(issue(r, 'code', 'error', `${v.code} is not a valid code`, 'Up to 20 letters, numbers, dot, dash or underscore'));
        const t = sameInFile(file, 'code', lc(v.code), r.row);
        if (t.length) c.issues.push(issue(r, 'code', 'error', `The code ${v.code} is also on row ${t[0]}`));
      }
      for (const by of options.matchBy) {
        const hit = by === 'name' && v.name ? lk.departments.find((d) => lc(d.name) === lc(v.name)) : by === 'code' && v.code ? lk.departments.find((d) => d.code && lc(d.code) === lc(v.code)) : undefined;
        if (hit) { c.match = { recordId: hit.id, label: hit.name, by }; c.uniqueMatch = true; break; }
      }
      if (c.match && lk.departments.find((d) => d.id === c.match!.recordId)?.archived_at) c.issues.push(issue(r, c.match.by, 'warning', `${c.match.label} is archived: it is restored`));
      const sameName = v.name ? lk.departments.find((d) => lc(d.name) === lc(v.name)) : undefined;
      if (sameName && sameName.id !== c.match?.recordId) c.issues.push(issue(r, 'name', 'error', `There is already a department called ${sameName.name}`));
      const sameCode = v.code ? lk.departments.find((d) => d.code && lc(d.code) === lc(v.code)) : undefined;
      if (sameCode && sameCode.id !== c.match?.recordId) c.issues.push(issue(r, 'code', 'error', `${sameCode.name} already has the code ${v.code}`));
      let parentId: string | null | undefined;
      let parentRow: number | undefined;
      if (v.parent) {
        const p = find(lk, v.parent);
        const inFile = file.get('name')?.get(lc(v.parent))?.[0] ?? file.get('code')?.get(lc(v.parent))?.[0];
        if (lc(v.parent) === lc(v.name) || (v.code && lc(v.parent) === lc(v.code))) c.issues.push(issue(r, 'parent', 'error', 'A department cannot be its own parent'));
        else if (p && !p.archived_at) {
          parentId = p.id;
          // Moving under one of its own sub-departments would make a loop.
          if (c.match) {
            for (let at: Doc | undefined = p, n = 0; at && n < 50; at = lk.departments.find((d) => d.id === at!.parent_id), n++) {
              if (at.id === c.match.recordId) { c.issues.push(issue(r, 'parent', 'error', `${p.name} is inside ${c.match.label}: that would make a loop`)); break; }
            }
          }
        } else if (inFile && inFile !== r.row) { parentRow = inFile; c.after.push(inFile); } else c.issues.push(issue(r, 'parent', 'error', `No department called ${v.parent}, in SampCrew or in this file`));
      }
      let entityId: string | undefined;
      if (v.legalEntity) {
        const e = lk.entities.find((x) => lc(x.name) === lc(v.legalEntity) || lc(x.legal_name) === lc(v.legalEntity));
        if (!e) c.issues.push(issue(r, 'legalEntity', 'error', `No legal entity called ${v.legalEntity}`));
        else entityId = e.id;
      }
      c.data = { name: v.name?.replace(/\s+/g, ' ').trim(), code: v.code || undefined, parentId, parentRow, entityId };
      return c;
    },
    async write(c, _r, action, lk, w, created) {
      return deps.db.tenant(async (tx) => {
        await deps.master.requireEdit(tx, 'department');
        const d = c.data;
        const parentId = d.parentRow !== undefined ? created.get(d.parentRow) : d.parentId;
        if (d.parentRow !== undefined && !parentId) throw Object.assign(new Error('parent_missing'), { importMessage: `Its parent department (row ${d.parentRow}) was not imported`, field: 'parent' });
        let id: string;
        if (action === 'update') {
          id = c.match!.recordId;
          await deps.master.updateIn(tx, 'department', id, filled({ label: d.name, code: d.code, disabled: false }), 'import');
        } else id = await deps.master.createIn(tx, 'department', filled({ label: d.name, code: d.code }) as never, 'custom', 'import');
        const set = filled({ parent_id: parentId, legal_entity_id: d.entityId });
        if (Object.keys(set).length) {
          await tx.collection('departments').updateOne({ id }, { $set: set });
          await deps.audit(tx, { action: 'department.updated', resourceType: 'department', resourceId: id, changes: set, metadata: { via: 'import', importId: w.jobId } });
        }
        if (action === 'create') lk.departments.push({ id, name: d.name, code: d.code ?? null, parent_id: parentId ?? null });
        return { id, label: d.name, action: action === 'update' ? 'updated' as const : 'imported' as const };
      });
    },
  };
}

// Job titles and other lists ------------------------------------------------------------------------------------------

export function masterAdapter(deps: Deps, kind: 'job_titles' | 'master_values'): ImportAdapter {
  const listOf = (options: { list?: string }): MasterList => (kind === 'job_titles' ? 'job_title' : (options.list as ValueList));
  const labelField = kind === 'job_titles' ? 'name' : 'label';
  return {
    type: kind,
    indexFields: [labelField, 'code'],
    fields: () => (kind === 'job_titles' ? JOB_TITLE_IMPORT_FIELDS : MASTER_VALUE_IMPORT_FIELDS),
    href: () => '/settings/master-data',
    async load(_tx, _o, base) {
      return base;
    },
    check(r, lk, file, options) {
      const c = blank();
      const list = listOf(options);
      const v = r.values;
      const label = (v[labelField] ?? '').replace(/\s+/g, ' ').trim();
      c.label = label || null;
      if (!label) c.issues.push(issue(r, labelField, 'error', 'Enter the value'));
      const twin = sameInFile(file, labelField, lc(label), r.row);
      if (twin.length) c.issues.push(issue(r, labelField, 'error', `${label} is also on row ${twin[0]}`));
      const hit = label ? matchEntry(lk.lists.get(list) ?? [], label) : undefined;
      if (hit && masterNorm(hit.label) === masterNorm(label)) { c.match = { recordId: hit.id, label: hit.label, by: labelField }; c.uniqueMatch = true; }
      if (hit?.disabled) c.issues.push(issue(r, labelField, 'warning', `${hit.label} is disabled: it is enabled again`));
      let level: number | undefined;
      if (v.level) {
        level = Number(v.level);
        if (!Number.isInteger(level) || level < 0 || level > 100) c.issues.push(issue(r, 'level', 'error', `${v.level} is not a level from 0 to 100`));
      }
      const input = filled({ label, category: v.category || undefined, code: v.code || undefined, level });
      const parsed = masterValueInput.partial().safeParse(input);
      if (!parsed.success) zodIssues(c, r, parsed.error, { label: labelField });
      c.data = { input, list };
      return c;
    },
    async write(c, _r, action, lk) {
      return deps.db.tenant(async (tx) => {
        const list = c.data.list as MasterList;
        if (action === 'update') {
          const { label: _l, ...patch } = c.data.input;
          await deps.master.updateIn(tx, list, c.match!.recordId, { ...patch, disabled: false }, 'import');
          return { id: c.match!.recordId, label: c.match!.label, action: 'updated' as const };
        }
        await deps.master.requireEdit(tx, list);
        const id = await deps.master.createIn(tx, list, c.data.input as never, 'custom', 'import');
        lk.lists.set(list, [...(lk.lists.get(list) ?? []), { id, key: id, label: c.data.input.label, category: c.data.input.category ?? null, code: c.data.input.code ?? null, disabled: false }]);
        return { id, label: c.data.input.label, action: 'imported' as const };
      });
    },
  };
}

export type { Deps as OtherAdapterDeps };
