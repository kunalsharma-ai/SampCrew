import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  CUSTOM_FIELD_PREFIX,
  CUSTOM_FIELD_TYPE_LABEL,
  type CustomFieldEntity,
  DUPLICATE_STRATEGY_LABEL,
  FIELD_OPTION_LISTS,
  fieldKeyFromLabel,
  guessFieldType,
  IMPORT_JOB_MAX_COLUMNS,
  IMPORT_JOB_MAX_ROWS,
  IMPORT_JOB_STATUS_LABEL,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_TYPE_INFO,
  type ImportField,
  type ImportIssue,
  type ImportJobStatus,
  type ImportJobView,
  type ImportMappingInput,
  type ImportOptions,
  type ImportRowStatus,
  type ImportRowView,
  type ImportSummary,
  type ImportType,
  LEAVE_FIELD_PREFIX,
  MASTER_LIST_INFO,
  type MasterList,
  checkFieldValue,
  OPTION_TYPES,
  parseSheetDate,
  sheetBool,
  sheetList,
  suggestMapping,
  type ValueList,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantsFor } from '../../platform/authz/policy';
import { requestContext, type TenantActor } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { parseCsv, readXlsx, toXlsxBook, type Cell } from '../../platform/export/tabular';
import { AppError, Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import type { UploadedFile } from '../../platform/storage/uploads';
import { AssetsService } from '../assets/assets.service';
import { BidsService } from '../bids/bids.service';
import { CustomFieldsService, definitionView, withListOptions } from '../custom-fields/custom-fields.service';
import { EmployeesService } from '../employees/employees.service';
import { ProfileService } from '../employees/profile.service';
import { type ListEntry, listEntries, MasterDataService, matchEntry } from '../master-data/master-data.service';
import { CandidatesService } from '../recruitment/candidates.service';
import { employeeAdapter, employeeFieldsWithLeave } from './adapters/employees';
import { candidateAdapter, clientAdapter, contactAdapter, departmentAdapter, masterAdapter } from './adapters/others';
import { type Checked, type Doc, type FileIndex, type ImportAdapter, issue, lc, type ListNeed, type Lookups, type MappedRow } from './adapters/types';

const CHUNK = 500;
/** An import whose heartbeat is older than this has stopped (the server restarted): it can carry on. */
const STALE_MS = 3 * 60_000;
const DONE: ImportRowStatus[] = ['imported', 'updated', 'skipped', 'failed'];
const OPEN: ImportJobStatus[] = ['mapping', 'validated'];

const emptySummary = (total = 0): ImportSummary => ({ total, valid: 0, warnings: 0, errors: 0, duplicates: 0, new: 0, imported: 0, updated: 0, skipped: 0, failed: 0 });
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

interface Prepared {
  job: Doc;
  type: ImportType;
  adapter: ImportAdapter;
  options: ImportOptions;
  fields: ImportField[];
  /** Custom field definitions by key (fields of this kind of record the person may fill in). */
  defs: Map<string, Doc>;
  lk: Lookups;
}

/**
 * Data import: a file is read into a job (its rows stored as they are), the person maps columns to SampCrew fields
 * (and creates fields for columns SampCrew has no field for), every row is checked and the duplicates decided, then
 * the rows are written in the background, each with its record, custom fields and links in one transaction. A row
 * that fails is reported and leaves nothing behind; a stopped import carries on from where it stopped.
 */
@Injectable()
export class DataImportService {
  private readonly log = new Logger(DataImportService.name);
  private readonly adapters: Record<ImportType, ImportAdapter>;
  /** Jobs this server is running now. */
  private readonly running = new Set<string>();

  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationService,
    private readonly customFields: CustomFieldsService,
    private readonly master: MasterDataService,
    employees: EmployeesService,
    profile: ProfileService,
    assets: AssetsService,
    candidates: CandidatesService,
    bids: BidsService,
  ) {
    const deps = { db, authz, master, candidates, bids, audit: (tx: TenantTx, e: Doc) => audit.record(tx, e as never) };
    this.adapters = {
      employees: employeeAdapter({ db, authz, employees, profile, assets }) as unknown as ImportAdapter,
      candidates: candidateAdapter(deps) as unknown as ImportAdapter,
      clients: clientAdapter(deps) as unknown as ImportAdapter,
      contacts: contactAdapter(deps) as unknown as ImportAdapter,
      departments: departmentAdapter(deps) as unknown as ImportAdapter,
      job_titles: masterAdapter(deps, 'job_titles'),
      master_values: masterAdapter(deps, 'master_values'),
    };
  }

  // Access ------------------------------------------------------------------------------------------------------------

  /** Running an import of this type: imports:run, the record's own permission and module. */
  private async mayRun(tx: TenantTx, type: ImportType) {
    await this.authz.require('imports:run', undefined, tx);
    const info = IMPORT_TYPE_INFO[type];
    if (info.feature) await this.entitlements.requireFeature(info.feature, tx);
    await this.authz.require(info.permission as never, undefined, tx);
  }

  /** The HR Workspaces the person imports for: none when they work for the whole company. */
  private async scope(tx: TenantTx): Promise<{ companyWide: boolean; hrWorkspaceIds: string[] }> {
    const s = await this.authz.subject(tx);
    const grants = [...grantsFor(s, 'imports:run'), ...grantsFor(s, 'imports:read')];
    return { companyWide: grants.some((g) => !g.constraints.hrWorkspaceIds?.length), hrWorkspaceIds: [...new Set(grants.flatMap((g) => g.constraints.hrWorkspaceIds ?? []))] };
  }

  /**
   * A job the person may see: one they started, or any job when they import for the whole company, or one started
   * for one of their HR Workspaces. Others are "not found", so ids reveal nothing. Changing a job is for its starter.
   */
  private async loadJob(tx: TenantTx, id: string, need: 'read' | 'change'): Promise<Doc> {
    const s = await this.authz.subject(tx);
    if (!grantsFor(s, 'imports:read').length && !grantsFor(s, 'imports:run').length) throw Errors.forbidden('You cannot see imports');
    const job = await tx.collection('import_jobs').findOne({ id });
    if (!job) throw Errors.notFound('Import');
    const me = requestContext.tenantActor().membershipId;
    const { companyWide, hrWorkspaceIds } = await this.scope(tx);
    const mine = job.created_by_membership_id === me;
    if (!mine && !companyWide && !(job.hr_workspace_ids as string[]).some((w) => hrWorkspaceIds.includes(w))) throw Errors.notFound('Import');
    if (need === 'change') {
      if (!mine) throw Errors.forbidden('Only the person who started this import can change or run it');
      await this.mayRun(tx, job.type);
    }
    return job;
  }

  // Upload ------------------------------------------------------------------------------------------------------------

  /** Reads an Excel workbook (.xlsx) or CSV file into rows of text. Old .xls files are refused with what to do. */
  private read(file: UploadedFile | undefined): string[][] {
    if (!file?.buffer?.length) throw Errors.badRequest('file_required', 'Choose an Excel (.xlsx) or CSV file');
    if (file.size > IMPORT_MAX_FILE_BYTES) throw Errors.badRequest('file_too_large', `The file is over ${IMPORT_MAX_FILE_BYTES / 1024 / 1024} MB. Split it into smaller files.`);
    const b = file.buffer;
    if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
      throw Errors.badRequest('xls_not_supported', 'This is an old Excel 97-2003 file (.xls). In Excel choose File > Save As > Excel Workbook (.xlsx), or CSV, and upload that.');
    }
    let rows: string[][];
    if (b[0] === 0x50 && b[1] === 0x4b) {
      try {
        rows = readXlsx(b, IMPORT_JOB_MAX_ROWS + 50);
      } catch {
        throw Errors.badRequest('unreadable_file', 'This file could not be read as an Excel workbook. Save it as .xlsx or CSV and try again.');
      }
    } else {
      let text = b.toString('utf8');
      if (text.includes('\u0000')) throw Errors.badRequest('unreadable_file', 'Upload an Excel workbook (.xlsx) or a CSV file');
      // Excel's "CSV" in some regions is semicolon-separated.
      const first = text.split(/\r?\n/, 1)[0] ?? '';
      if (!first.includes(',') && first.split(';').length > 2) text = text.split(/\r?\n/).map((l) => l.split(';').map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
      rows = parseCsv(text);
    }
    return rows.map((r) => r.map((c) => String(c ?? '').trim()));
  }

  async start(type: ImportType, list: ValueList | undefined, file: UploadedFile | undefined) {
    const rows = this.read(file);
    const headerAt = rows.findIndex((r) => r.some((c) => c !== ''));
    if (headerAt < 0) throw Errors.badRequest('empty_file', 'The file is empty');
    const rawHeaders = rows[headerAt]!;
    let width = rawHeaders.length;
    while (width > 0 && !rawHeaders[width - 1]) width--;
    if (width > IMPORT_JOB_MAX_COLUMNS) throw Errors.badRequest('too_many_columns', `The file has ${width} columns: up to ${IMPORT_JOB_MAX_COLUMNS} can be imported`);
    const headers = rawHeaders.slice(0, width).map((h, i) => h || `Column ${i + 1}`);
    const body = rows.slice(headerAt + 1).map((r, i) => ({ row: headerAt + 2 + i, cells: Array.from({ length: width }, (_, c) => r[c] ?? '') })).filter((r) => r.cells.some((c) => c !== ''));
    if (!body.length) throw Errors.badRequest('no_rows', 'The file has headings but no rows under them');
    if (body.length > IMPORT_JOB_MAX_ROWS) throw Errors.badRequest('too_many_rows', `The file has ${body.length} rows: import up to ${IMPORT_JOB_MAX_ROWS.toLocaleString('en-IN')} at a time`);
    if (type === 'master_values' && !list) throw Errors.badRequest('list_required', 'Choose the list the values go to');
    const actor = requestContext.tenantActor();

    const job = await this.db.tenant(async (tx) => {
      await this.mayRun(tx, type);
      const { companyWide, hrWorkspaceIds } = await this.scope(tx);
      const last = await tx.collection('import_jobs').findOne({}, { sort: { number: -1 }, projection: { number: 1 } });
      const info = IMPORT_TYPE_INFO[type];
      const fields = await this.targetFields(tx, type);
      const suggestions = suggestMapping(headers, fields);
      const options: ImportOptions = {
        duplicates: 'skip', matchBy: info.matchFields.slice(0, type === 'employees' ? 2 : 1), addMissingValues: true,
        ...(type === 'master_values' ? { list } : {}),
      };
      const row = await tx.collection('import_jobs').insert({
        number: ((last?.number as number | undefined) ?? 0) + 1, type, status: 'mapping', file_name: (file!.originalname || 'import').slice(0, 200), file_size: file!.size,
        file_sha256: createHash('sha256').update(file!.buffer).digest('hex'), headers, sample: body.slice(0, 5).map((r) => r.cells), row_count: body.length,
        // Only sure matches are set; a close spelling waits for the person to confirm it.
        mapping: suggestions.map((s) => ({ column: s.column, field: s.confidence === 'exact' ? s.field : null })),
        options, summary: emptySummary(body.length), created_by_membership_id: actor.membershipId, created_by_label: actor.label,
        hr_workspace_ids: companyWide ? [] : hrWorkspaceIds,
      });
      await tx.collection('import_job_rows').insertMany(body.slice(0, CHUNK).map((r) => ({ job_id: row.id, row: r.row, cells: r.cells, status: 'pending' })));
      await this.audit.record(tx, { action: 'import.uploaded', resourceType: 'import_job', resourceId: row.id, changes: { type, fileName: row.file_name, rows: body.length, columns: headers.length, ...(list ? { list } : {}) } });
      return row;
    });
    try {
      for (let i = CHUNK; i < body.length; i += CHUNK) {
        await this.db.tenant((tx) => tx.collection('import_job_rows').insertMany(body.slice(i, i + CHUNK).map((r) => ({ job_id: job.id, row: r.row, cells: r.cells, status: 'pending' }))));
      }
    } catch (err) {
      await this.db.tenant((tx) => tx.collection('import_jobs').updateOne({ id: job.id }, { $set: { status: 'failed', error: 'The file could not be stored. Upload it again.' } }));
      throw err;
    }
    return this.get(job.id as string);
  }

  // Fields ------------------------------------------------------------------------------------------------------------

  /** Custom fields of this kind of record that imports may fill and the person may change. */
  private async customDefs(tx: TenantTx, type: ImportType): Promise<Doc[]> {
    const entity = IMPORT_TYPE_INFO[type].customFieldEntity;
    if (!entity) return [];
    const s = await this.authz.subject(tx);
    const roles = new Set(s.grants.map((g) => g.roleKey));
    const defs = await withListOptions(tx, await tx.collection('custom_fields').find({ entity, archived_at: null, enabled: true, importable: { $ne: false }, type: { $ne: 'file' } }, { sort: { position: 1 } }));
    return defs.filter((d) => (!d.view_roles?.length || d.view_roles.some((r: string) => roles.has(r))) && (!d.edit_roles?.length || d.edit_roles.some((r: string) => roles.has(r))));
  }

  /** Every field a column can be mapped to: the record's own, its custom fields and (employees) leave balances. */
  private async targetFields(tx: TenantTx, type: ImportType, defs?: Doc[]): Promise<ImportField[]> {
    const own = this.adapters[type].fields({ duplicates: 'skip', matchBy: [], addMissingValues: true });
    const base = type === 'employees' ? employeeFieldsWithLeave(own, await tx.collection('leave_types').find({ archived_at: null }, { sort: { code: 1 } })) : own;
    const custom = (defs ?? (await this.customDefs(tx, type))).map((d): ImportField => ({
      key: `${CUSTOM_FIELD_PREFIX}${d.key as string}`, label: d.label, group: 'Custom fields', customFieldId: d.id,
      kind: d.type === 'date' ? 'date' : ['number', 'decimal', 'currency'].includes(d.type) ? 'number' : d.type === 'email' ? 'email' : d.type === 'phone' ? 'phone' : d.type === 'url' ? 'url' : ['checkbox', 'yes_no'].includes(d.type) ? 'bool' : OPTION_TYPES.includes(d.type) ? (d.type === 'multi_select' ? 'list' : 'choice') : 'text',
      required: !!d.required, ...(OPTION_TYPES.includes(d.type) ? { choices: (d.options as Doc[]).filter((o) => !o.archived).map((o) => o.label as string) } : {}),
      synonyms: [d.key], help: `${CUSTOM_FIELD_TYPE_LABEL[d.type as keyof typeof CUSTOM_FIELD_TYPE_LABEL] ?? d.type}${d.help_text ? `. ${d.help_text as string}` : ''}`,
      ...(d.config?.masterList ? { masterList: d.config.masterList } : {}),
    }));
    return [...base, ...custom];
  }

  // Mapping -----------------------------------------------------------------------------------------------------------

  async saveMapping(id: string, input: ImportMappingInput) {
    await this.db.tenant(async (tx) => {
      const job = await this.loadJob(tx, id, 'change');
      if (!OPEN.includes(job.status)) throw Errors.conflict('import_started', 'This import has started: its columns can no longer change');
      const type = job.type as ImportType;
      const info = IMPORT_TYPE_INFO[type];
      const headers = job.headers as string[];
      const mapping = new Map<number, string | null>(headers.map((_, i) => [i, null]));
      for (const m of input.mapping) {
        if (m.column >= headers.length) throw Errors.validation([{ path: 'mapping', message: `The file has no column ${m.column + 1}` }]);
        mapping.set(m.column, m.field);
      }

      // Columns that become new custom fields.
      const createdFields = [...((job.created_fields ?? []) as Doc[])];
      if (input.newFields.length) {
        const entity = info.customFieldEntity as CustomFieldEntity | null;
        if (!entity) throw Errors.badRequest('no_custom_fields', `${info.label} have no custom fields: ignore the column instead`);
        for (const f of input.newFields) {
          if (f.column >= headers.length) throw Errors.validation([{ path: 'newFields', message: `The file has no column ${f.column + 1}` }]);
          const options = [...new Set(f.options)].map((o) => ({ value: fieldKeyFromLabel(o), label: o }));
          const def = await this.customFields.createIn(tx, {
            entity, label: f.label, type: f.type, required: f.required, options, section: 'Imported', enabled: true,
            // Super and HR Workspace always see a field made here; the Employee Workspace only when it was ticked.
            viewRoles: f.visibleToEmployee ? [] : ['super_workspace', 'hr_workspace'], editRoles: [], employeeEditable: f.visibleToEmployee && f.employeeEditable,
            searchable: f.searchable, importable: true, config: {},
          }, 'import');
          mapping.set(f.column, `${CUSTOM_FIELD_PREFIX}${def.key}`);
          createdFields.push({ key: def.key, label: def.label, column: f.column });
        }
      }

      const fields = await this.targetFields(tx, type);
      const known = new Set(fields.map((f) => f.key));
      const used = new Map<string, number>();
      for (const [column, field] of mapping) {
        if (!field) continue;
        if (!known.has(field)) throw Errors.validation([{ path: 'mapping', message: `${headers[column]}: SampCrew has no field ${field} here` }]);
        if (used.has(field)) throw Errors.validation([{ path: 'mapping', message: `${headers[used.get(field)!]} and ${headers[column]} are both mapped to ${fields.find((f) => f.key === field)!.label}. Map one, ignore the other.` }]);
        used.set(field, column);
      }
      const has = (k: string) => used.has(k);
      const missing: string[] = [];
      const need = (ok: boolean, label: string) => { if (!ok) missing.push(label); };
      if (type === 'employees') { need(has('firstName') || has('fullName'), 'First name or Full name'); need(has('dateOfJoining') || input.options.duplicates === 'update', 'Date of joining'); }
      if (type === 'candidates') { need(has('firstName') || has('fullName'), 'First name or Full name'); need(has('email'), 'Email'); }
      if (type === 'contacts') { need(has('client'), 'Client name'); need(has('firstName') || has('fullName'), 'First name or Full name'); }
      if (['clients', 'departments', 'job_titles'].includes(type)) need(has('name'), fields.find((f) => f.key === 'name')!.label);
      if (type === 'master_values') need(has('label'), 'Value');
      if (missing.length) throw Errors.validation([{ path: 'mapping', message: `Map a column to ${missing.join(' and ')}` }]);

      const matchBy = [...new Set(input.options.matchBy)];
      const bad = matchBy.filter((m) => !info.matchFields.includes(m));
      if (bad.length) throw Errors.validation([{ path: 'options.matchBy', message: `${info.label} are not matched by ${bad.join(', ')}` }]);
      if (type === 'candidates' && input.options.lawfulBasisConfirmed !== true) throw Errors.validation([{ path: 'options.lawfulBasisConfirmed', message: 'Confirm you may store these people’s details' }]);
      let hrWorkspaceId = input.options.hrWorkspaceId;
      if (type === 'employees' && hrWorkspaceId !== undefined) {
        const { companyWide, hrWorkspaceIds } = await this.scope(tx);
        if (hrWorkspaceId === null && !companyWide) throw Errors.forbidden('Only the Super Workspace can add people to the central group');
        if (hrWorkspaceId && !companyWide && !hrWorkspaceIds.includes(hrWorkspaceId)) {
          await this.audit.record(tx, { action: 'authz.denied', resourceType: 'import_job', resourceId: id, metadata: { permission: 'employees:create', reason: 'not_your_hr_workspace', hrWorkspaceId } });
          throw Errors.forbidden('You can add people only to the HR Workspaces you run');
        }
        if (hrWorkspaceId && !(await tx.collection('hr_workspaces').exists({ id: hrWorkspaceId, status: 'active' }))) throw Errors.badRequest('unknown_hr_workspace', 'Choose an active HR Workspace');
      } else hrWorkspaceId = undefined;
      const options: ImportOptions = {
        duplicates: input.options.duplicates, matchBy, addMissingValues: input.options.addMissingValues,
        ...(hrWorkspaceId !== undefined ? { hrWorkspaceId } : {}),
        ...(type === 'candidates' ? { lawfulBasisConfirmed: true } : {}),
        ...((job.options as ImportOptions).list ? { list: (job.options as ImportOptions).list } : {}),
      };
      const before = { mapping: job.mapping, options: job.options };
      await tx.collection('import_jobs').updateOne({ id }, { $set: { mapping: [...mapping].map(([column, field]) => ({ column, field })), options, created_fields: createdFields, status: 'mapping' } });
      await this.audit.record(tx, {
        action: 'import.mapped', resourceType: 'import_job', resourceId: id,
        changes: { before, after: { mapping: [...mapping].filter(([, f]) => f).map(([c, f]) => `${headers[c]} > ${f}`), options } }, ...(input.newFields.length ? { metadata: { newFields: input.newFields.map((f) => f.label) } } : {}),
      });
    });
    return this.validate(id);
  }

  // Validation --------------------------------------------------------------------------------------------------------

  private async prepare(tx: TenantTx, job: Doc): Promise<Prepared> {
    const type = job.type as ImportType;
    const adapter = this.adapters[type];
    const options = job.options as ImportOptions;
    const defsList = await this.customDefs(tx, type);
    const fields = await this.targetFields(tx, type, defsList);
    const mapped = new Set(((job.mapping ?? []) as Doc[]).map((m) => m.field).filter(Boolean) as string[]);
    const lists = new Map<MasterList, ListEntry[]>();
    const wanted = new Set<MasterList>([...fields.filter((f) => f.masterList && mapped.has(f.key)).map((f) => f.masterList as MasterList)]);
    if (type === 'job_titles') wanted.add('job_title');
    if (type === 'master_values' && options.list) wanted.add(options.list as MasterList);
    if (type === 'employees') wanted.add('job_title');
    for (const l of wanted) lists.set(l, await listEntries(tx, l));
    const mayAdd = new Set<MasterList>();
    if (options.addMissingValues) for (const l of wanted) if ((FIELD_OPTION_LISTS as readonly string[]).includes(l) && (await this.master.mayEdit(tx, l))) mayAdd.add(l);
    const lk = await adapter.load(tx, options, { lists, mayAdd });
    return { job, type, adapter, options, fields, defs: new Map(defsList.map((d) => [d.key as string, d])), lk };
  }

  private mapRow(p: Prepared, row: number, cells: string[]): MappedRow {
    const headers = p.job.headers as string[];
    const values: Record<string, string> = {};
    const columns: Record<string, string> = {};
    for (const m of (p.job.mapping ?? []) as { column: number; field: string | null }[]) {
      if (!m.field) continue;
      values[m.field] = String(cells[m.column] ?? '').trim();
      columns[m.field] = headers[m.column] ?? `Column ${m.column + 1}`;
    }
    return { row, values, columns };
  }

  private index(p: Prepared, rows: MappedRow[]): FileIndex {
    const idx: FileIndex = new Map();
    for (const f of p.adapter.indexFields) idx.set(f, new Map());
    for (const r of rows) {
      for (const f of p.adapter.indexFields) {
        const v = r.values[f];
        if (!v) continue;
        const keys = f === 'assetCodes' ? sheetList(v).map(lc) : f === 'phone' ? [v.replace(/\D/g, '').slice(-10)] : [lc(v)];
        for (const k of keys) if (k) idx.get(f)!.set(k, [...(idx.get(f)!.get(k) ?? []), r.row]);
      }
    }
    return idx;
  }

  /** A custom field cell as the value its field takes, with what is wrong with it. */
  private customValue(p: Prepared, r: MappedRow, field: string, def: Doc, c: Checked, needs: ListNeed[]): unknown {
    const text = r.values[field] ?? '';
    if (!text) return null;
    const options = (def.options ?? []) as Doc[];
    const option = (t: string): string | undefined => {
      const hit = options.find((o) => lc(o.value) === lc(t) || lc(o.label) === lc(t));
      if (hit && !hit.archived) return hit.value;
      if (def.config?.masterList) {
        const list = def.config.masterList as MasterList;
        if (hit?.archived) { c.issues.push(issue(r, field, 'error', `${hit.label} is disabled in ${MASTER_LIST_INFO[list].label}`)); return undefined; }
        if (p.lk.mayAdd.has(list)) {
          needs.push({ list, label: t });
          c.issues.push(issue(r, field, 'warning', `${t} is new and will be added to ${MASTER_LIST_INFO[list].label.toLowerCase()}`));
          return `__new__:${list}:${t}`;
        }
      }
      c.issues.push(issue(r, field, 'error', `${t} is not one of the options of ${def.label}`, `Use one of: ${options.filter((o) => !o.archived).slice(0, 12).map((o) => o.label).join(', ')}`));
      return undefined;
    };
    let raw: unknown = text;
    switch (def.type) {
      case 'checkbox': { const b = sheetBool(text); if (b === null) { c.issues.push(issue(r, field, 'error', `${text} is not Yes or No`)); return undefined; } raw = b; break; }
      case 'date': { const d = parseSheetDate(text); if (!d) { c.issues.push(issue(r, field, 'error', `${text} is not a date`, 'Use 2021-04-05 or 05/04/2021 (day first)')); return undefined; } raw = d; break; }
      case 'dropdown': case 'radio': { const o = option(text); if (o === undefined) return undefined; if (o.startsWith('__new__:')) return o; raw = o; break; }
      case 'multi_select': {
        const out: string[] = [];
        for (const t of sheetList(text)) { const o = option(t); if (o === undefined) return undefined; out.push(o); }
        if (out.some((o) => o.startsWith('__new__:'))) return out;
        raw = out; break;
      }
      default: break;
    }
    const check = checkFieldValue(definitionView(def), raw, { country: null });
    if (!check.ok) { c.issues.push(issue(r, field, 'error', `${def.label}: ${check.error}`)); return undefined; }
    return check.value;
  }

  /** Checks one row: the adapter's checks, custom fields, and what happens to a row that matches a record. */
  private checkRow(p: Prepared, r: MappedRow, file: FileIndex, decision: string | null): { c: Checked; custom: Record<string, unknown>; needs: ListNeed[]; status: ImportRowStatus; decision: string | null } {
    const c = p.adapter.check(r, p.lk, file, p.options);
    const needs: ListNeed[] = [...((c.data.needs ?? []) as ListNeed[])];
    const customNeeds: ListNeed[] = [];
    const custom: Record<string, unknown> = {};
    for (const [field] of Object.entries(r.values)) {
      if (!field.startsWith(CUSTOM_FIELD_PREFIX)) continue;
      const key = field.slice(CUSTOM_FIELD_PREFIX.length);
      const def = p.defs.get(key);
      if (!def) { c.issues.push(issue(r, field, 'error', 'This custom field was removed or you can no longer fill it in', 'Map the column again')); continue; }
      const v = this.customValue(p, r, field, def, c, customNeeds);
      if (v !== undefined && v !== null) custom[key] = v;
    }
    // Required custom fields on a new record.
    if (!c.match) {
      for (const d of p.defs.values()) {
        if (!d.required || custom[d.key] !== undefined || (d.default_value !== null && d.default_value !== undefined)) continue;
        c.issues.push(issue(r, `${CUSTOM_FIELD_PREFIX}${d.key}`, 'error', `${d.label} is required`, r.values[`${CUSTOM_FIELD_PREFIX}${d.key}`] === undefined ? `Add a ${d.label} column` : `Fill in ${d.label}`));
      }
    }
    let rowDecision: string | null = null;
    if (c.match) {
      rowDecision = p.options.duplicates === 'ask' ? decision : p.options.duplicates;
      if (rowDecision === 'create' && c.uniqueMatch) {
        c.issues.push(issue(r, c.match.by, 'error', `${c.match.label} already has this ${p.fields.find((f) => f.key === c.match!.by)?.label.toLowerCase() ?? c.match.by}: it can be updated or skipped, not added twice`, 'Choose Update or Skip for this row'));
        rowDecision = null;
      }
    }
    const errors = c.issues.some((i) => i.level === 'error');
    const status: ImportRowStatus = errors ? 'error' : c.match ? 'duplicate' : c.issues.length ? 'warning' : 'valid';
    return { c, custom, needs: [...needs, ...customNeeds], status, decision: rowDecision };
  }

  /** Checks every row against SampCrew as it is now and stores what was found. Changes nothing else. */
  async validate(id: string) {
    await this.db.tenant(async (tx) => {
      const job = await this.loadJob(tx, id, 'change');
      if (!OPEN.includes(job.status)) throw Errors.conflict('import_started', 'This import has started');
    });
    const p = await this.db.tenant(async (tx) => this.prepare(tx, (await tx.collection('import_jobs').findOne({ id }))!));
    const stored = await this.db.tenant((tx) => tx.collection('import_job_rows').find({ job_id: id }, { sort: { row: 1 }, projection: { row: 1, cells: 1, decision: 1 } }));
    const mapped = stored.map((s) => this.mapRow(p, s.row, s.cells));
    const file = this.index(p, mapped);
    const summary = emptySummary(stored.length);
    const out: Doc[] = [];
    for (let i = 0; i < stored.length; i++) {
      const { c, status, decision } = this.checkRow(p, mapped[i]!, file, stored[i]!.decision ?? null);
      summary[status === 'valid' ? 'valid' : status === 'warning' ? 'warnings' : status === 'error' ? 'errors' : 'duplicates']++;
      if (status === 'valid' || status === 'warning') summary.new++;
      if (status === 'duplicate' && decision === 'create') summary.new++;
      out.push({ job_id: id, row: stored[i]!.row, cells: stored[i]!.cells, status, issues: c.issues, match: c.match ? { ...c.match, unique: c.uniqueMatch } : null, decision, record_label: c.label });
    }
    for (let i = 0; i < out.length; i += CHUNK) {
      const part = out.slice(i, i + CHUNK);
      await this.db.tenant(async (tx) => {
        await tx.collection('import_job_rows').delete({ job_id: id, row: { $gte: part[0]!.row, $lte: part[part.length - 1]!.row } });
        await tx.collection('import_job_rows').insertMany(part);
      });
    }
    await this.db.tenant(async (tx) => {
      await tx.collection('import_jobs').updateOne({ id, status: { $in: OPEN } }, { $set: { status: 'validated', validated_at: new Date(), summary } });
      await this.audit.record(tx, { action: 'import.validated', resourceType: 'import_job', resourceId: id, changes: { summary } });
    });
    return this.get(id);
  }

  // Rows and decisions ------------------------------------------------------------------------------------------------

  async rows(id: string, q: { status: string; page: number; pageSize: number }) {
    return this.db.tenant(async (tx) => {
      const job = await this.loadJob(tx, id, 'read');
      const filter: Doc = { job_id: id };
      if (q.status === 'problems') filter.status = { $in: ['error', 'warning', 'duplicate', 'failed'] };
      else if (q.status !== 'all') filter.status = q.status;
      const total = await tx.collection('import_job_rows').count(filter);
      const rows = await tx.collection('import_job_rows').find(filter, { sort: { row: 1 }, skip: (q.page - 1) * q.pageSize, limit: q.pageSize });
      const adapter = this.adapters[job.type as ImportType];
      const headers = job.headers as string[];
      return {
        total, page: q.page, pageSize: q.pageSize,
        rows: rows.map((r): ImportRowView => ({
          row: r.row, status: r.status, cells: Object.fromEntries(headers.map((h, i) => [h, String((r.cells as string[])[i] ?? '')])), issues: r.issues ?? [],
          match: r.match ?? null, decision: r.decision ?? null,
          record: r.record_id ? { id: r.record_id, label: r.record_label ?? '', href: adapter.href(r.record_id) } : null,
        })),
      };
    });
  }

  async decide(id: string, decisions: { row: number; decision: 'skip' | 'update' | 'create' }[]) {
    await this.db.tenant(async (tx) => {
      const job = await this.loadJob(tx, id, 'change');
      if (!OPEN.includes(job.status)) throw Errors.conflict('import_started', 'This import has started');
      const rows = new Map((await tx.collection('import_job_rows').find({ job_id: id, row: { $in: decisions.map((d) => d.row) } }, { projection: { row: 1, status: 1, match: 1 } })).map((r) => [r.row as number, r]));
      const problems: { path: string; message: string }[] = [];
      for (const d of decisions) {
        const r = rows.get(d.row);
        if (!r || r.status !== 'duplicate') { problems.push({ path: `row ${d.row}`, message: `Row ${d.row} does not match an existing record` }); continue; }
        if (d.decision === 'create' && r.match?.unique) { problems.push({ path: `row ${d.row}`, message: `Row ${d.row}: ${r.match.label} can be updated or skipped, not added twice` }); continue; }
      }
      if (problems.length) throw Errors.validation(problems);
      for (const d of decisions) await tx.collection('import_job_rows').updateOne({ job_id: id, row: d.row }, { $set: { decision: d.decision } });
      const summary = { ...(job.summary as ImportSummary) };
      const all = await tx.collection('import_job_rows').find({ job_id: id, status: 'duplicate' }, { projection: { decision: 1 } });
      summary.new = (summary.valid ?? 0) + (summary.warnings ?? 0) + all.filter((r) => r.decision === 'create').length;
      await tx.collection('import_jobs').updateOne({ id }, { $set: { summary } });
      await this.audit.record(tx, { action: 'import.decided', resourceType: 'import_job', resourceId: id, changes: { decisions: decisions.length, update: decisions.filter((d) => d.decision === 'update').length, skip: decisions.filter((d) => d.decision === 'skip').length, create: decisions.filter((d) => d.decision === 'create').length } });
    });
    return this.get(id);
  }

  // Run ---------------------------------------------------------------------------------------------------------------

  async run(id: string) {
    const actor = requestContext.tenantActor();
    await this.db.tenant(async (tx) => {
      const job = await this.staleCheck(tx, await this.loadJob(tx, id, 'change'));
      if (!['validated', 'interrupted'].includes(job.status)) throw Errors.conflict('not_ready', job.status === 'mapping' ? 'Check the rows first' : `This import is ${IMPORT_JOB_STATUS_LABEL[job.status as ImportJobStatus].toLowerCase()}`);
      const undecided = await tx.collection('import_job_rows').count({ job_id: id, status: 'duplicate', decision: null });
      if (undecided) throw Errors.conflict('decisions_needed', `Decide what to do with the ${undecided} row${undecided === 1 ? '' : 's'} that match existing records`);
      const flipped = await tx.collection('import_jobs').updateAndGet({ id, status: { $in: ['validated', 'interrupted'] } }, { $set: { status: 'importing', heartbeat_at: new Date(), ...(job.started_at ? {} : { started_at: new Date() }), error: null } });
      if (!flipped) throw Errors.conflict('already_running', 'This import is already running');
      await this.audit.record(tx, { action: job.status === 'interrupted' ? 'import.resumed' : 'import.started', resourceType: 'import_job', resourceId: id, changes: { summary: job.summary } });
    });
    this.running.add(id);
    setImmediate(() => {
      void requestContext.run({ requestId: `import-${id}`, actor }, () => this.process(id, actor))
        .catch(async (err) => {
          this.log.error(`Import ${id} stopped: ${(err as Error).message}`);
          await requestContext.run({ requestId: `import-${id}-fail`, actor }, () => this.db.tenant((tx) => tx.collection('import_jobs').updateOne({ id, status: 'importing' }, { $set: { status: 'failed', error: 'The import stopped unexpectedly. Rows imported so far are kept; the rest can be imported again.', finished_at: new Date() } }))).catch(() => undefined);
        })
        .finally(() => this.running.delete(id));
    });
    return this.get(id);
  }

  /** Writes the rows, in an order where a row another row needs (a manager, a parent) comes first. */
  private async process(id: string, actor: TenantActor) {
    const fresh = <T>(fn: () => Promise<T>) => requestContext.run({ requestId: `import-${id}-${Date.now()}`, actor }, fn);
    const p = await fresh(() => this.db.tenant(async (tx) => this.prepare(tx, (await tx.collection('import_jobs').findOne({ id }))!)));
    const stored = await fresh(() => this.db.tenant((tx) => tx.collection('import_job_rows').find({ job_id: id }, { sort: { row: 1 } })));
    const mapped = new Map(stored.map((s) => [s.row as number, this.mapRow(p, s.row, s.cells)]));
    const file = this.index(p, [...mapped.values()]);
    const created = new Map<number, string>();
    for (const s of stored) if ((s.status === 'imported' || s.status === 'updated') && s.record_id) created.set(s.row, s.record_id);
    const todo = stored.filter((s) => !DONE.includes(s.status) && s.status !== 'error');
    const failedRows = new Set(stored.filter((s) => s.status === 'failed' || s.status === 'error').map((s) => s.row as number));
    const checks = new Map(todo.map((s) => [s.row as number, this.checkRow(p, mapped.get(s.row)!, file, s.decision ?? null)]));

    const finishRow = async (row: number, set: Doc, counts: 'imported' | 'updated' | 'skipped' | 'failed') => {
      await fresh(() => this.db.tenant(async (tx) => {
        await tx.collection('import_job_rows').updateOne({ job_id: id, row }, { $set: set });
        await tx.collection('import_jobs').updateOne({ id }, { $inc: { progress_done: 1 }, $set: { heartbeat_at: new Date() } });
        void counts;
      }));
    };

    const pending = [...todo];
    let n = 0;
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      for (let i = 0; i < pending.length; i++) {
        const s = pending[i]!;
        const row = s.row as number;
        const ch = checks.get(row)!;
        const waits = ch.c.after.filter((a) => !created.has(a));
        if (waits.length) {
          if (waits.some((a) => failedRows.has(a) || !mapped.has(a))) {
            pending.splice(i--, 1);
            progress = true;
            failedRows.add(row);
            await finishRow(row, { status: 'failed', issues: [...ch.c.issues, { field: 'row', column: null, level: 'error', message: `Row ${waits[0]} it depends on was not imported`, suggestion: 'Fix that row and import this one again' }] }, 'failed');
          }
          continue;
        }
        pending.splice(i--, 1);
        progress = true;
        // Every 20 rows: stop if the import was cancelled, or the module or permission was taken away.
        if (n++ % 20 === 0) {
          const state = await fresh(() => this.db.tenant(async (tx) => {
            const j = await tx.collection('import_jobs').findOne({ id }, { projection: { status: 1 } });
            if (j?.status !== 'importing') return j?.status ?? 'cancelled';
            try { await this.entitlements.requireFeature('data_import', tx); await this.mayRun(tx, p.type); } catch (err) { return (err as Error).message || 'forbidden'; }
            return 'ok';
          }));
          if (state !== 'ok') {
            await this.stop(id, actor, state === 'cancelled' ? 'cancelled' : 'failed', state === 'cancelled' ? null : `The import stopped: ${state}`);
            return;
          }
        }
        // Checked again now: SampCrew may have changed since the rows were checked.
        const now = this.checkRow(p, mapped.get(row)!, file, s.decision ?? null);
        if (now.status === 'error') {
          failedRows.add(row);
          await finishRow(row, { status: 'failed', issues: now.c.issues }, 'failed');
          continue;
        }
        const action = !now.c.match ? 'create' : (now.decision as 'skip' | 'update' | 'create' | null) ?? 'skip';
        if (action === 'skip') {
          await finishRow(row, { status: 'skipped', record_id: now.c.match?.recordId ?? null, record_label: now.c.match?.label ?? null }, 'skipped');
          continue;
        }
        try {
          const result = await fresh(() => p.adapter.write(now.c, mapped.get(row)!, action, p.lk, {
            jobId: id,
            ensureValues: (tx, needs) => this.ensureValues(tx, p, [...needs, ...now.needs]),
            saveCustom: async (tx, recordId, creating) => {
              if (!Object.keys(now.custom).length) return;
              const values = this.resolveCustom(p, now.custom);
              await this.customFields.save(IMPORT_TYPE_INFO[p.type].customFieldEntity!, recordId, values, { tx, creating });
            },
          }, created));
          created.set(row, result.id);
          await finishRow(row, { status: result.action, record_id: result.id, record_label: result.label, issues: now.c.issues.filter((x) => x.level === 'warning') }, result.action);
        } catch (err) {
          failedRows.add(row);
          await finishRow(row, { status: 'failed', issues: [...now.c.issues.filter((x) => x.level === 'warning'), ...this.errorIssues(err, mapped.get(row)!, p)] }, 'failed');
        }
      }
    }
    for (const s of pending) {
      failedRows.add(s.row);
      await finishRow(s.row, { status: 'failed', issues: [{ field: 'row', column: null, level: 'error', message: 'The rows in this file depend on each other in a circle (for example two people who manage each other)' }] }, 'failed');
    }
    await this.stop(id, actor, null, null);
  }

  /** Ends a run: counts the rows, sets the outcome and tells the person who started it. */
  private async stop(id: string, actor: TenantActor, status: 'cancelled' | 'failed' | null, error: string | null) {
    await requestContext.run({ requestId: `import-${id}-done`, actor }, () => this.db.tenant(async (tx) => {
      const job = (await tx.collection('import_jobs').findOne({ id }))!;
      const counts = await tx.collection('import_job_rows').aggregate<{ _id: string; n: number }>([{ $match: { job_id: id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
      const by = new Map(counts.map((c) => [(c as { id?: string }).id ?? c._id, c.n]));
      const summary: ImportSummary = { ...(job.summary as ImportSummary), imported: by.get('imported') ?? 0, updated: by.get('updated') ?? 0, skipped: by.get('skipped') ?? 0, failed: (by.get('failed') ?? 0) + (by.get('error') ?? 0) };
      const final: ImportJobStatus = status ?? (summary.failed ? 'completed_with_errors' : 'completed');
      await tx.collection('import_jobs').updateOne({ id }, { $set: { status: final, summary, finished_at: new Date(), error, progress_done: summary.imported + summary.updated + summary.skipped + (by.get('failed') ?? 0) } });
      await this.audit.record(tx, { action: `import.${final === 'cancelled' ? 'cancelled' : final === 'failed' ? 'failed' : 'completed'}`, resourceType: 'import_job', resourceId: id, changes: { summary, ...(error ? { error } : {}) } });
      await this.notifications.notify(tx, {
        membershipIds: [job.created_by_membership_id], kind: 'import.finished',
        title: `Import #${job.number as number} (${IMPORT_TYPE_INFO[job.type as ImportType].label.toLowerCase()}): ${IMPORT_JOB_STATUS_LABEL[final].toLowerCase()}`,
        body: `${summary.imported} added, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.failed} not imported`, link: `/imports/${id}`,
      });
    }));
  }

  /** Values a row needs added to master data lists, added now (once each), as list:label > entry. */
  private async ensureValues(tx: TenantTx, p: Prepared, needs: ListNeed[]): Promise<Map<string, ListEntry>> {
    const out = new Map<string, ListEntry>();
    for (const n of needs) {
      const k = `${n.list}:${n.label.toLowerCase()}`;
      if (out.has(k)) continue;
      const entries = p.lk.lists.get(n.list) ?? [];
      let hit = matchEntry(entries, n.label);
      if (!hit || hit.disabled) {
        // Job titles typed on an employee are added as on the hire form; other lists need their permission.
        if (!(n.list === 'job_title' && p.type === 'employees')) await this.master.requireEdit(tx, n.list);
        const fresh = matchEntry(await listEntries(tx, n.list), n.label);
        if (fresh && !fresh.disabled) hit = fresh;
        else {
          await this.master.createIn(tx, n.list, { label: n.label }, 'custom', 'import');
          hit = matchEntry(await listEntries(tx, n.list), n.label);
        }
        if (hit) p.lk.lists.set(n.list, [...entries.filter((e) => e.id !== hit!.id), hit]);
      }
      if (hit) out.set(k, hit);
    }
    return out;
  }

  /** Custom values with options added during the run turned into those options' values. */
  private resolveCustom(p: Prepared, custom: Record<string, unknown>): Record<string, unknown> {
    const one = (v: unknown) => {
      if (typeof v !== 'string' || !v.startsWith('__new__:')) return v;
      const [, list, ...rest] = v.split(':');
      return matchEntry(p.lk.lists.get(list as MasterList) ?? [], rest.join(':'))?.key ?? v;
    };
    return Object.fromEntries(Object.entries(custom).map(([k, v]) => [k, Array.isArray(v) ? v.map(one) : one(v)]));
  }

  /** What went wrong writing a row, as problems on its fields. */
  private errorIssues(err: unknown, r: MappedRow, p: Prepared): ImportIssue[] {
    const e = err as { importMessage?: string; field?: string };
    if (e?.importMessage) return [issue(r, e.field ?? 'row', 'error', e.importMessage)];
    if (err instanceof AppError) {
      const details = err.details as { path: string; message: string }[] | undefined;
      const fieldOf = (path: string) => {
        const head = String(path).split('.')[0]!;
        if (head === 'customFields') return `${CUSTOM_FIELD_PREFIX}${String(path).split('.')[1]}`;
        const map: Record<string, string> = { designationName: 'designation', designationId: 'designation', departmentId: 'department', locationId: 'location', managerEmployeeId: 'managerCode', legalEntityId: 'legalEntity', personal: 'firstName', address: 'addressLine1', emergency: 'emergencyName', education: 'highestQualification', skills: 'skills' };
        return map[head] ?? head;
      };
      if (Array.isArray(details) && details.length) return details.map((d) => issue(r, fieldOf(d.path), 'error', d.message));
      return [issue(r, 'row', 'error', err.message)];
    }
    this.log.warn(`Import row ${r.row} of a ${p.type} import failed: ${(err as Error)?.message}`);
    return [issue(r, 'row', 'error', 'This row could not be saved. Try it again, or add the record by hand.')];
  }

  async cancel(id: string) {
    await this.db.tenant(async (tx) => {
      const job = await this.loadJob(tx, id, 'change');
      if (!['mapping', 'validated', 'importing', 'interrupted'].includes(job.status)) throw Errors.conflict('import_finished', 'This import has finished');
      await tx.collection('import_jobs').updateOne({ id }, { $set: { status: 'cancelled', ...(job.status === 'importing' ? {} : { finished_at: new Date() }) } });
      if (job.status !== 'importing') await this.audit.record(tx, { action: 'import.cancelled', resourceType: 'import_job', resourceId: id, changes: { status: job.status } });
    });
    return this.get(id);
  }

  /** An import that stopped beating (the server restarted mid-run) is marked as stopped, so it can carry on. */
  private async staleCheck(tx: TenantTx, job: Doc): Promise<Doc> {
    if (job.status !== 'importing' || this.running.has(job.id)) return job;
    const beat = job.heartbeat_at ? new Date(job.heartbeat_at).getTime() : 0;
    if (Date.now() - beat < STALE_MS) return job;
    await tx.collection('import_jobs').updateOne({ id: job.id, status: 'importing' }, { $set: { status: 'interrupted' } });
    return { ...job, status: 'interrupted' };
  }

  // Views -------------------------------------------------------------------------------------------------------------

  async get(id: string): Promise<ImportJobView> {
    return this.db.tenant(async (tx) => {
      const job = await this.staleCheck(tx, await this.loadJob(tx, id, 'read'));
      const fields = await this.targetFields(tx, job.type);
      return { ...(await this.view(tx, job, fields)), fields };
    });
  }

  async history(q: { type?: ImportType; status?: ImportJobStatus; limit: number }) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('imports:read', undefined, tx).catch(() => this.authz.require('imports:run', undefined, tx));
      const { companyWide, hrWorkspaceIds } = await this.scope(tx);
      const me = requestContext.tenantActor().membershipId;
      const filter: Doc = { ...(q.type ? { type: q.type } : {}), ...(q.status ? { status: q.status } : {}) };
      if (!companyWide) filter.$or = [{ created_by_membership_id: me }, { hr_workspace_ids: { $in: hrWorkspaceIds } }];
      const jobs = await tx.collection('import_jobs').find(filter, { sort: { number: -1 }, limit: q.limit });
      const out: ImportJobView[] = [];
      for (const j of jobs) out.push(await this.view(tx, await this.staleCheck(tx, j), null));
      return out;
    });
  }

  private async view(tx: TenantTx, job: Doc, fields: ImportField[] | null): Promise<ImportJobView> {
    const me = requestContext.tenantActor().membershipId;
    const mine = job.created_by_membership_id === me;
    const headers = job.headers as string[];
    const options = job.options as ImportOptions;
    const undecided = job.status === 'validated' ? await tx.collection('import_job_rows').count({ job_id: job.id, status: 'duplicate', decision: null }) : 0;
    const hrId = options.hrWorkspaceId ?? (job.hr_workspace_ids as string[])[0];
    const hr = hrId ? await tx.collection('hr_workspaces').findOne({ id: hrId }, { projection: { name: 1 } }) : undefined;
    return {
      id: job.id, number: job.number, type: job.type, status: job.status, fileName: job.file_name, fileSize: job.file_size, headers, sample: job.sample ?? [],
      rowCount: job.row_count, mapping: job.mapping ?? [], suggestions: fields ? suggestMapping(headers, fields) : [], options,
      summary: { ...emptySummary(job.row_count), ...(job.summary ?? {}) }, progress: { done: job.progress_done ?? 0, total: job.row_count },
      createdFields: job.created_fields ?? [], createdBy: job.created_by_label ?? null, hrWorkspace: (hr?.name as string | undefined) ?? (options.hrWorkspaceId === null ? 'Central group' : null),
      createdAt: iso(job.created_at)!, validatedAt: iso(job.validated_at), startedAt: iso(job.started_at), finishedAt: iso(job.finished_at), error: job.error ?? null,
      undecided, list: options.list ?? null,
      can: {
        map: mine && OPEN.includes(job.status),
        validate: mine && OPEN.includes(job.status),
        run: mine && job.status === 'validated' && undecided === 0,
        cancel: mine && ['mapping', 'validated', 'importing', 'interrupted'].includes(job.status),
        resume: mine && job.status === 'interrupted',
      },
    };
  }

  /** Suggested settings for a column nobody mapped: a field type and options from its values. */
  async columnGuess(id: string, column: number) {
    return this.db.tenant(async (tx) => {
      const job = await this.loadJob(tx, id, 'read');
      const headers = job.headers as string[];
      if (column < 0 || column >= headers.length) throw Errors.notFound('Column');
      const values = (await tx.collection('import_job_rows').find({ job_id: id }, { sort: { row: 1 }, limit: 200, projection: { cells: 1 } })).map((r) => String((r.cells as string[])[column] ?? ''));
      return { column, header: headers[column]!, ...guessFieldType(values, parseSheetDate) };
    });
  }

  // Files -------------------------------------------------------------------------------------------------------------

  /** The report: a summary, every problem (row, field, problem, how to fix it), the rows to fix as uploaded, and all rows. */
  async report(id: string): Promise<{ fileName: string; content: Buffer }> {
    return this.db.tenant(async (tx) => {
      const job = await this.loadJob(tx, id, 'read');
      const rows = await tx.collection('import_job_rows').find({ job_id: id }, { sort: { row: 1 } });
      const headers = job.headers as string[];
      const s = { ...emptySummary(job.row_count), ...(job.summary ?? {}) } as ImportSummary;
      const label = (st: string) => ({ pending: 'Not checked', valid: 'Ready', warning: 'Ready, with warnings', error: 'Has errors', duplicate: 'Matches an existing record', imported: 'Added', updated: 'Updated', skipped: 'Skipped', failed: 'Not imported' } as Record<string, string>)[st] ?? st;
      const fieldLabel = new Map((await this.targetFields(tx, job.type)).map((f) => [f.key, f.label]));
      const summary: Cell[][] = [
        ['Import', `#${job.number as number}`], ['Type', IMPORT_TYPE_INFO[job.type as ImportType].label], ['File', job.file_name], ['Status', IMPORT_JOB_STATUS_LABEL[job.status as ImportJobStatus]],
        ['Started by', job.created_by_label ?? ''], ['Uploaded', iso(job.created_at)], ['Finished', iso(job.finished_at) ?? ''],
        ['Duplicates', DUPLICATE_STRATEGY_LABEL[(job.options as ImportOptions).duplicates]], ['Matched by', (job.options as ImportOptions).matchBy.map((m) => fieldLabel.get(m) ?? m).join(', ')],
        ['Rows', s.total], ['Ready', s.valid], ['With warnings', s.warnings], ['With errors', s.errors], ['Matching existing records', s.duplicates],
        ['Added', s.imported], ['Updated', s.updated], ['Skipped', s.skipped], ['Not imported', s.failed],
      ];
      const problems: Cell[][] = [['Row', 'Field', 'Column in your file', 'Level', 'Problem', 'Suggested correction']];
      for (const r of rows) for (const i of (r.issues ?? []) as ImportIssue[]) problems.push([r.row, fieldLabel.get(i.field) ?? (i.field === 'row' ? 'Whole row' : i.field), i.column ?? '', i.level === 'error' ? 'Error' : 'Warning', i.message, i.suggestion ?? '']);
      const toFix: Cell[][] = [[...headers, 'Problems']];
      for (const r of rows) if (['error', 'failed'].includes(r.status)) toFix.push([...(r.cells as string[]), ((r.issues ?? []) as ImportIssue[]).filter((i) => i.level === 'error').map((i) => i.message).join('; ')]);
      const all: Cell[][] = [['Row', 'Status', 'Record', 'Matched existing record', 'Decision', 'Problems']];
      for (const r of rows) all.push([r.row, label(r.status), r.record_label ?? '', r.match ? `${r.match.label as string} (by ${fieldLabel.get(r.match.by) ?? r.match.by})` : '', r.decision ?? '', ((r.issues ?? []) as ImportIssue[]).map((i) => i.message).join('; ')]);
      await this.audit.record(tx, { action: 'import.report_downloaded', resourceType: 'import_job', resourceId: id });
      return {
        fileName: `import-${job.number as number}-${job.type as string}-report.xlsx`,
        content: toXlsxBook([{ name: 'Summary', rows: summary }, { name: 'Problems', rows: problems }, { name: 'Rows to fix', rows: toFix }, { name: 'All rows', rows: all }]),
      };
    });
  }

  /** A template to fill in: the columns (required ones marked *), an example row, and an instructions sheet. */
  async template(type: ImportType, list?: ValueList): Promise<{ fileName: string; content: Buffer }> {
    return this.db.tenant(async (tx) => {
      await this.mayRun(tx, type);
      const fields = (await this.targetFields(tx, type)).filter((f) => f.key !== 'fullName');
      const header = fields.map((f) => (f.required ? `${f.label} *` : f.label));
      const example = fields.map((f) => f.example ?? '');
      const allowed = async (f: ImportField): Promise<string> => {
        if (f.choices?.length) return f.choices.slice(0, 40).join(', ');
        if (f.masterList && MASTER_LIST_INFO[f.masterList as MasterList]) {
          const values = (await listEntries(tx, f.masterList as MasterList)).filter((e) => !e.disabled).map((e) => e.label);
          return `${values.slice(0, 40).join(', ')}${values.length > 40 ? ` and ${values.length - 40} more (Settings > Master data)` : ''}`;
        }
        if (f.key.startsWith(LEAVE_FIELD_PREFIX)) return 'Days available today, such as 12 or 7.5';
        return ({ date: 'A date: 2021-04-05 or 05/04/2021 (day first)', email: 'An email address', phone: 'A phone number with the country code for numbers outside India', number: 'A number', bool: 'Yes or No', url: 'A full web address (https://...)', list: 'Several values separated by ;' } as Record<string, string>)[f.kind] ?? 'Text';
      };
      const instructions: Cell[][] = [['Column', 'Required', 'Group', 'What to enter', 'Allowed values or format']];
      for (const f of fields) instructions.push([f.label, f.required ? 'Yes' : '', f.group, f.help ?? '', await allowed(f)]);
      instructions.push([], ['How it works'], ['1. Fill in one row per record under the headings. Delete the example row.'], ['2. Columns you do not need can be removed; extra columns of your own can stay and are offered as new fields.'],
        ['3. Upload the file in SampCrew > Data import. Every row is checked before anything is saved, and you decide what happens to records that already exist.']);
      const name = type === 'master_values' && list ? MASTER_LIST_INFO[list].label : IMPORT_TYPE_INFO[type].label;
      return { fileName: `sampcrew-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-template.xlsx`, content: toXlsxBook([{ name, rows: [header, example] }, { name: 'Instructions', rows: instructions }]) };
    });
  }

  /** The kinds of record the person may import, for the hub. */
  async types() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('imports:run', undefined, tx).catch(() => this.authz.require('imports:read', undefined, tx));
      const out = [];
      for (const info of Object.values(IMPORT_TYPE_INFO)) {
        let allowed = true;
        let reason: string | null = null;
        try { await this.mayRun(tx, info.key); } catch (err) { allowed = false; reason = (err as Error).message; }
        out.push({ ...info, allowed, reason });
      }
      return out;
    });
  }
}
