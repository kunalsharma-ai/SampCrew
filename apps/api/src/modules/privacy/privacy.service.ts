import { Injectable, Logger } from '@nestjs/common';
import { ERASURE_RULES, PRIVACY_DUE_DAYS, RETENTION_DEFAULTS, type RetentionPolicyInput } from '@crew/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { StorageService } from '../../platform/storage/storage.service';

/** Tables left out of an access export, and why (recorded in the export itself). */
const EXPORT_SKIPPED: Record<string, string> = {
  employee_sensitive: 'Bank, tax and national ID numbers are shown masked under "sensitive" instead of copied.',
  helpdesk_messages: 'Messages are listed under each helpdesk case (internal handler notes are not included).',
  privacy_requests: 'This request itself.',
};
/** Columns never copied into an export (secrets and storage internals). */
const SECRET_COLUMNS = /(_enc|_hash|storage_key|secret|token)$/;
const MAX_ROWS = 5000;
const ERASURE = { flags: ['erasure'] };

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const minusYears = (date: string, years: number) => `${Number(date.slice(0, 4)) - years}${date.slice(4)}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/**
 * Privacy requests from people about their own data: a copy of it (access, also serving portability as a
 * machine-readable JSON file), and erasure. Requests are logged with a due date of PRIVACY_DUE_DAYS. Erasure is
 * pseudonymisation: identity, contact details, documents and free text go; payroll, attendance and leave figures
 * stay against an anonymous record, because employment and tax law require them to be kept.
 */
@Injectable()
export class PrivacyService {
  private readonly logger = new Logger('Privacy');

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  async list(status?: string) {
    return this.db.tenant(async (tx) => {
      const reqs = await tx.collection('privacy_requests').find(status ? { status } : {});
      const emps = new Map((await tx.collection('employees').find({ id: { $in: reqs.map((x) => x.employee_id) } })).map((e) => [e.id as string, e]));
      const now = today();
      return reqs
        .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || String(a.due_on).localeCompare(String(b.due_on)) || b.created_at - a.created_at)
        .slice(0, 500)
        .map((x) => {
          const e = emps.get(x.employee_id);
          return {
            id: x.id, kind: x.kind, status: x.status, source: x.source, dueOn: x.due_on, createdAt: x.created_at, completedAt: x.completed_at ?? null, employeeId: x.employee_id,
            employeeName: e ? `${e.first_name} ${e.last_name ?? ''}`.trim() : null, employeeCode: e?.employee_code ?? null, employeeStatus: e?.status ?? null,
            overdue: x.status === 'open' && x.due_on < now,
          };
        });
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const x = await tx.collection('privacy_requests').findOne({ id });
      const e = x ? await tx.collection('employees').findOne({ id: x.employee_id }) : undefined;
      const people = x ? await membershipUserNames(tx, [x.requested_by_membership_id, x.decided_by_membership_id]) : new Map();
      const r = x && e && {
        id: x.id, kind: x.kind, status: x.status, source: x.source, dueOn: x.due_on, createdAt: x.created_at, completedAt: x.completed_at ?? null, decisionNote: x.decision_note ?? null,
        result: x.result ?? null, exportSha256: x.export_sha256 ?? null, hasExport: !!x.export_storage_key, employeeId: x.employee_id,
        employeeName: `${e.first_name} ${e.last_name ?? ''}`.trim(), employeeCode: e.employee_code, employeeStatus: e.status, lastWorkingDay: e.last_working_day ?? null,
        erasedAt: e.erased_at ?? null, requestedBy: people.get(x.requested_by_membership_id) ?? null, decidedBy: x.decided_by_membership_id ? (people.get(x.decided_by_membership_id) ?? null) : null,
      };
      if (!r) throw Errors.notFound('Privacy request');
      return { ...r, erasureRules: ERASURE_RULES };
    });
  }

  async create(input: { employeeId: string; kind: 'access' | 'erasure'; source: string }) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const e = await tx.collection('employees').findOne({ id: input.employeeId });
      if (!e) throw Errors.notFound('Employee');
      if (e.erased_at) throw Errors.conflict('already_erased', 'This person\'s details were already erased.');
      if (await tx.collection('privacy_requests').exists({ employee_id: input.employeeId, kind: input.kind, status: 'open' })) {
        throw Errors.conflict('request_open', 'There is already an open request of this kind for this person.');
      }
      const r = await tx.collection('privacy_requests').insert({
        employee_id: input.employeeId, kind: input.kind, source: input.source, due_on: addDays(today(), PRIVACY_DUE_DAYS), requested_by_membership_id: actor.membershipId,
      });
      await this.audit.record(tx, { action: 'privacy.request_logged', resourceType: 'privacy_request', resourceId: r.id, metadata: { kind: input.kind, employeeId: input.employeeId } });
      return { id: r.id };
    });
  }

  async reject(id: string, note: string) {
    const actor = requestContext.tenantActor();
    await this.db.tenant(async (tx) => {
      await this.open(tx, id);
      await tx.collection('privacy_requests').updateOne({ id }, { $set: { status: 'rejected', decided_by_membership_id: actor.membershipId, decision_note: note, completed_at: new Date(), updated_at: new Date() } });
      await this.audit.record(tx, { action: 'privacy.request_rejected', resourceType: 'privacy_request', resourceId: id, metadata: { note } });
    });
    return { ok: true };
  }

  private async open(tx: TenantTx, id: string) {
    const reqs = tx.collection<{ id: string; kind: string; status: string; employee_id: string }>('privacy_requests');
    await reqs.lock({ id });
    const r = await reqs.findOne({ id });
    if (!r) throw Errors.notFound('Privacy request');
    if (r.status !== 'open') throw Errors.conflict('request_closed', 'This request is already closed.');
    return r;
  }

  // Access ---------------------------------------------------------------------------------------------------------

  /** Builds the export, stores it as a file and completes the request. */
  async fulfilAccess(id: string, note: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await this.open(tx, id);
      if (r.kind !== 'access') throw Errors.badRequest('wrong_kind', 'This is not an access request.');
      const data = await this.collect(tx, r.employee_id);
      const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
      const key = `${actor.tenantId}/${randomUUID()}`;
      await this.storage.put(key, body);
      const sha = createHash('sha256').update(body).digest('hex');
      const summary = Object.fromEntries(Object.entries(data.records).map(([k, v]) => [k, (v as unknown[]).length]));
      await tx.collection('privacy_requests').updateOne({ id }, {
        $set: {
          status: 'completed', decided_by_membership_id: actor.membershipId, decision_note: note, export_storage_key: key, export_sha256: sha,
          result: { records: summary, bytes: body.length, skipped: EXPORT_SKIPPED }, completed_at: new Date(), updated_at: new Date(),
        },
      });
      await this.audit.record(tx, { action: 'privacy.export_prepared', resourceType: 'privacy_request', resourceId: id, metadata: { employeeId: r.employee_id, bytes: body.length, sha256: sha } });
      return { ok: true, records: summary };
    });
  }

  /** Everything SampCrew holds about the person in this workspace, by table. */
  private async collect(tx: TenantTx, employeeId: string) {
    const employee = (await tx.collection('employees').findOne({ id: employeeId }))!;
    const tables = Object.entries(this.db.tables)
      .filter(([, spec]) => spec.access === 'tenant' && 'employee_id' in spec.columns && spec.grants.includes('select'))
      .map(([name]) => name)
      .sort();
    const records: Record<string, unknown[]> = {};
    const unreadable: string[] = [];
    for (const t of tables) {
      if (EXPORT_SKIPPED[t]) continue;
      try {
        const rows = await tx.collection(t).find({ employee_id: employeeId }, { limit: MAX_ROWS });
        if (rows.length) records[t] = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !SECRET_COLUMNS.test(k) && !k.startsWith('_'))));
      } catch {
        unreadable.push(t);
      }
    }
    // Helpdesk conversations: what the person and handlers wrote to each other (internal notes excluded).
    if (records.helpdesk_cases) {
      const caseIds = (records.helpdesk_cases as Doc[]).map((c) => c.id);
      records.helpdesk_messages = (await tx.collection('helpdesk_messages').find({ case_id: { $in: caseIds }, internal: false }, { sort: { created_at: 1 }, limit: MAX_ROWS }))
        .map((m) => ({ case_id: m.case_id, body: m.body, created_at: m.created_at }));
    }
    const sens = await tx.collection('employee_sensitive').findOne({ employee_id: employeeId });
    const sensitive = sens ? { bank_name: sens.bank_name ?? null, bank_account_on_file: !!sens.bank_account_enc, tax_id_on_file: !!sens.tax_id_enc, national_id_on_file: !!sens.national_id_enc } : null;
    let account: Doc | null = null;
    if (employee.membership_id) {
      const m = await tx.collection('memberships').findOne({ id: employee.membership_id });
      const u = m ? await (await tx.users()).findOne({ id: m.user_id }) : undefined;
      if (m && u) account = { email: u.email, full_name: u.full_name, last_login_at: u.last_login_at ?? null, mfa_enabled: u.mfa_enabled, status: m.status, created_at: m.created_at };
    }
    const workspace = (await tx.collection<{ name: string }>('tenants').findOne({ id: tx.tenantId }))!;
    return {
      format: 'crew-personal-data-export/1',
      generatedAt: new Date().toISOString(),
      workspace: workspace.name,
      about: 'A copy of the personal data this workspace holds about you in SampCrew, by record type. Dates are ISO 8601; amounts are in the currency of the record.',
      employee: Object.fromEntries(Object.entries(employee).filter(([k]) => !SECRET_COLUMNS.test(k) && !k.startsWith('_'))),
      account,
      sensitive: sensitive ?? null,
      records,
      notIncluded: { ...EXPORT_SKIPPED, ...(unreadable.length ? { [unreadable.join(', ')]: 'Could not be read for this export; ask your HR team.' } : {}) },
    };
  }

  async download(id: string) {
    const r = await this.db.tenant(async (tx) => {
      const x = await tx.collection('privacy_requests').findOne({ id });
      const e = x ? await tx.collection('employees').findOne({ id: x.employee_id }) : undefined;
      const row = x && e ? { export_storage_key: (x.export_storage_key ?? null) as string | null, export_deleted_at: (x.export_deleted_at ?? null) as Date | null, employee_code: e.employee_code as string } : undefined;
      if (row?.export_deleted_at) throw Errors.conflict('export_deleted', 'The export file was deleted: exports are kept for the period in the retention schedule, and deleted when the person is erased.');
      if (!row?.export_storage_key) throw Errors.notFound('Export');
      await this.audit.record(tx, { action: 'privacy.export_downloaded', resourceType: 'privacy_request', resourceId: id });
      return row;
    });
    const file = await this.storage.open(r.export_storage_key!).catch(() => {
      throw Errors.conflict('export_deleted', 'The export file no longer exists (it is deleted when the person is erased).');
    });
    return { ...file, fileName: `personal-data-${r.employee_code}.json` };
  }

  // Erasure --------------------------------------------------------------------------------------------------------

  async erase(id: string, note: string) {
    const actor = requestContext.tenantActor();
    const files: string[] = [];
    const result = await this.db.tenant((tx) => this.eraseRequest(tx, id, note, actor.membershipId, actor.tenantId, files));
    await this.removeFiles(files);
    return { ok: true, ...result };
  }

  private async removeFiles(files: string[]) {
    for (const f of files) await this.storage.remove(f).catch((err: Error) => this.logger.error(`Could not delete ${f}: ${err.message}`));
  }

  /** Erases the person behind an open erasure request. decidedBy is null when the retention schedule does it. */
  private async eraseRequest(tx: TenantTx, id: string, note: string, decidedBy: string | null, tenantId: string, files: string[]) {
      const r = await this.open(tx, id);
      if (r.kind !== 'erasure') throw Errors.badRequest('wrong_kind', 'This is not an erasure request.');
      const emp = (await tx.collection('employees').findOne({ id: r.employee_id }))!;
      const e = { status: emp.status as string, membership_id: (emp.membership_id ?? null) as string | null, past: !!emp.last_working_day && emp.last_working_day < today() };
      if (e.status !== 'exited' || !e.past) {
        throw Errors.conflict('still_employed', 'Only people who have left (after their last working day) can be erased. While someone works here, SampCrew needs their details to employ and pay them.');
      }
      if (await this.inOpenPayroll(tx, r.employee_id)) {
        throw Errors.conflict('payroll_open', 'This person is in a payroll run that is not finalised. Finish or cancel it first.');
      }
      // Erasure is the one change frozen records accept (the row guards check the erasure flag; see row-guards.ts).
      const counts: Record<string, number> = {};
      const code = `ERASED-${r.employee_id.slice(0, 8).toUpperCase()}`;
      await tx.collection('employees', ERASURE).updateOne({ id: r.employee_id }, {
        $set: {
          first_name: 'Erased', last_name: 'person', preferred_name: null, employee_code: code, work_email: null, personal_email: null, phone: null, date_of_birth: null,
          gender: null, exit_reason: null, erased_at: new Date(),
        },
      });
      counts.sensitive = await tx.collection('employee_sensitive').delete({ employee_id: r.employee_id });
      const docs = await tx.collection('employee_documents').find({ employee_id: r.employee_id }, { projection: { storage_key: 1 } });
      await tx.collection('employee_documents').delete({ employee_id: r.employee_id });
      files.push(...docs.map((d) => d.storage_key as string));
      counts.documents = docs.length;
      counts.helpdeskCases = await tx.collection('helpdesk_cases', ERASURE).update(
        { employee_id: r.employee_id },
        { $set: { subject: '[erased]', description: '[erased] (personal details removed on request)', satisfaction_comment: null } },
      );
      counts.leaveReasons = await tx.collection('leave_requests').update(
        { employee_id: r.employee_id, $or: [{ reason: { $ne: null } }, { cancel_reason: { $ne: null } }] },
        { $set: { reason: null, cancel_reason: null } },
      );
      counts.freeText = await this.eraseFreeText(tx, r.employee_id, e.membership_id, tenantId);
      if (e.membership_id) {
        // Messages are insert-only for the workspace; erasure rewrites them in the same transaction, limited to this workspace.
        counts.helpdeskMessages = await tx.unscoped('helpdesk_messages', ERASURE).update({ tenant_id: tenantId, author_membership_id: e.membership_id }, { $set: { body: '[erased]' } });
        await tx.collection('memberships').updateOne({ id: e.membership_id }, { $set: { status: 'suspended', scim_external_id: null } });
        // The login is global: it is anonymised only when it belongs to no other workspace.
        const userId = (await tx.collection('memberships').findOne({ id: e.membership_id }))!.user_id as string;
        const others = await tx.unscoped('memberships').count({ user_id: userId, _id: { $ne: e.membership_id } });
        await tx.unscoped('sessions').update({ user_id: userId, tenant_id: tenantId, revoked_at: null }, { $set: { revoked_at: new Date(), revoked_reason: 'erased' } });
        if (others === 0) {
          await tx.unscoped('users').updateOne({ id: userId }, {
            $set: { email: `erased-${userId}@erased.invalid`, full_name: 'Erased person', password_hash: null, mfa_secret_enc: null, mfa_enabled: false, status: 'disabled' },
          });
          counts.loginErased = 1;
        }
      }
      const resultJson = { removed: counts, rules: ERASURE_RULES };
      await tx.collection('privacy_requests').updateOne({ id }, {
        $set: { status: 'completed', decided_by_membership_id: decidedBy, decision_note: note, result: resultJson, completed_at: new Date(), updated_at: new Date() },
      });
      // An access export made earlier would now be the only copy of the erased details, so it goes too.
      files.push(...(await this.dropExports(tx, { employee_id: r.employee_id })));
      await this.audit.record(tx, { tenantId, action: 'privacy.erased', resourceType: 'employee', resourceId: r.employee_id, metadata: { requestId: id, removed: counts, by: decidedBy ? 'hr' : 'retention_schedule' } });
      return resultJson;
  }
  /**
   * Free text written by or about the person in records that otherwise stay (see ERASURE_RULES). Numbers, ratings,
   * dates and statuses are kept for payroll and workforce reports; only the words go. Frozen records (released
   * reviews, submitted feedback, completed courses) accept exactly this change while crew.erasure is on.
   */
  private async eraseFreeText(tx: TenantTx, employeeId: string, membershipId: string | null, tenantId: string) {
    const ERASED = '[erased]';
    const ERASED_JSON = { erased: true };
    const t = (name: string) => tx.collection(name, ERASURE);
    let total = 0;
    total += await t('expense_claims').update({ employee_id: employeeId, description: { $nin: [null, ERASED] } }, { $set: { description: ERASED } });
    const goalIds = await tx.collection('goals').distinct<string>('id', { employee_id: employeeId });
    total += await t('goals').update({ employee_id: employeeId }, { $set: { title: ERASED, description: '' } });
    // Check-ins are insert-only for the workspace, so erasure blanks them unscoped, limited to this workspace.
    total += await tx.unscoped('goal_checkins', ERASURE).update({ tenant_id: tenantId, note: { $ne: '' }, goal_id: { $in: goalIds } }, { $set: { note: '' } });
    const reviewIds = await tx.collection('reviews').distinct<string>('id', { employee_id: employeeId });
    total += await t('review_feedback').update({ review_id: { $in: reviewIds }, answers: { $ne: ERASED_JSON } }, { $set: { answers: ERASED_JSON } });
    total += await t('reviews').update({ employee_id: employeeId }, { $set: { self_answers: ERASED_JSON, manager_answers: ERASED_JSON, employee_comment: null, excluded_reason: null } });
    total += await t('recognitions').update({ to_employee_id: employeeId, message: { $ne: ERASED } }, { $set: { message: ERASED } });
    total += await t('attendance_corrections').update({ employee_id: employeeId, reason: { $nin: [null, ERASED] } }, { $set: { reason: ERASED } });
    total += await t('overtime_claims').update({ employee_id: employeeId, reason: { $ne: null } }, { $set: { reason: null } });
    total += await t('employment_records').update({ employee_id: employeeId, note: { $ne: null } }, { $set: { note: null } });
    total += await t('course_assignments').update(
      { employee_id: employeeId, $or: [{ completion_note: { $ne: null } }, { cancelled_reason: { $ne: null } }] },
      { $set: { completion_note: null, cancelled_reason: null } },
    );
    total += await t('approval_requests').update({ subject_employee_id: employeeId, summary: { $ne: ERASED } }, { $set: { summary: ERASED } });
    // Attrition risk is an inference about the person: scores and the notes on them (cascade) go.
    total += await t('attrition_scores').delete({ employee_id: employeeId });
    if (membershipId) {
      for (const name of ['iq_messages', 'iq_conversations', 'saved_views', 'notifications', 'employee_drafts']) {
        total += await tx.unscoped(name, ERASURE).delete({ tenant_id: tenantId, membership_id: membershipId });
      }
      // Not deletable by the workspace; erasure removes them unscoped, limited to this workspace.
      total += await tx.unscoped('member_preferences', ERASURE).delete({ tenant_id: tenantId, membership_id: membershipId });
      total += await tx.unscoped('mobile_devices', ERASURE).delete({ tenant_id: tenantId, membership_id: membershipId });
    }
    return total;
  }

  /** Whether the employee is in a payroll run that is neither finalised nor cancelled. */
  private async inOpenPayroll(tx: TenantTx, employeeId: string): Promise<boolean> {
    const runs = await tx.collection('payroll_items').distinct<string>('run_id', { employee_id: employeeId });
    return tx.collection('payroll_runs').exists({ id: { $in: runs }, status: { $nin: ['finalised', 'cancelled'] } });
  }

  /** Deletes the export files of matching requests (recording when), and returns their storage keys. */
  private async dropExports(tx: TenantTx, filter: Doc): Promise<string[]> {
    const reqs = tx.collection('privacy_requests');
    const found = await reqs.find({ ...filter, export_storage_key: { $ne: null } }, { projection: { export_storage_key: 1 } });
    for (const x of found) await reqs.updateOne({ id: x.id }, { $set: { export_storage_key: null, export_deleted_at: new Date() } });
    return found.map((x) => x.export_storage_key as string);
  }

  // Retention schedule ---------------------------------------------------------------------------------------------

  async retention() {
    return this.db.tenant(async (tx) => {
      const pol = await tx.collection('retention_policies').findOne({});
      const by = pol ? await membershipUserNames(tx, [pol.updated_by_membership_id]) : new Map();
      const p = pol && {
        exitedErasureYears: (pol.exited_erasure_years ?? null) as number | null, exportDays: pol.export_days as number, signInLogDays: pol.sign_in_log_days as number,
        updatedAt: pol.updated_at as Date, updatedBy: (pol.updated_by_membership_id && by.get(pol.updated_by_membership_id)) ?? null,
      };
      const runs = (await tx.collection('retention_runs').find({}, { sort: { ran_at: -1 }, limit: 10 })).map((x) => ({ id: x.id, ranAt: x.ran_at, result: x.result }));
      const due = {
        n: p?.exitedErasureYears
          ? await tx.collection('employees').count({ status: 'exited', erased_at: null, last_working_day: { $lt: minusYears(today(), p.exitedErasureYears) } })
          : 0,
      };
      return { policy: p ?? { ...RETENTION_DEFAULTS, updatedAt: null, updatedBy: null }, isDefault: !p, dueForErasure: due.n, runs };
    });
  }

  async setRetention(input: RetentionPolicyInput) {
    const actor = requestContext.tenantActor();
    await this.db.tenant(async (tx) => {
      const policies = tx.collection('retention_policies');
      const cur = await policies.findOne({});
      const before = cur ? { exited_erasure_years: cur.exited_erasure_years ?? null, export_days: cur.export_days, sign_in_log_days: cur.sign_in_log_days } : undefined;
      const values = { exited_erasure_years: input.exitedErasureYears ?? null, export_days: input.exportDays, sign_in_log_days: input.signInLogDays, updated_by_membership_id: actor.membershipId };
      await policies.upsert({}, values, { $set: { ...values, updated_at: new Date() } });
      await this.audit.record(tx, { action: 'privacy.retention_changed', resourceType: 'retention_policy', resourceId: actor.tenantId, changes: { before, after: input } });
    });
    return this.retention();
  }

  /**
   * Applies the retention schedule once: erases people past the period after their last working day (each through a
   * privacy request, so it is listed with the others), deletes old access exports, and deletes old sign-in and
   * provisioning logs. Raw attendance punches, payroll and the audit trail are never touched. Runs daily from the HR
   * jobs, and on demand from Settings.
   */
  async applyRetention(tenantId: string, trigger: 'schedule' | 'manual') {
    const files: string[] = [];
    const result = await this.db.tenant(async (tx) => {
      const row = await tx.collection<{ exited_erasure_years: number | null; export_days: number; sign_in_log_days: number; updated_by_membership_id: string | null }>('retention_policies').findOne({});
      const p = row ?? { exited_erasure_years: RETENTION_DEFAULTS.exitedErasureYears, export_days: RETENTION_DEFAULTS.exportDays, sign_in_log_days: RETENTION_DEFAULTS.signInLogDays, updated_by_membership_id: null };
      const erased: string[] = [];
      let heldByPayroll = 0;
      if (p.exited_erasure_years && p.updated_by_membership_id) {
        const candidates = await tx.collection('employees').find(
          { status: 'exited', erased_at: null, last_working_day: { $lt: minusYears(today(), p.exited_erasure_years) } },
          { sort: { last_working_day: 1 }, limit: 25, projection: { _id: 1 } },
        );
        const due: { id: string; open_payroll: boolean }[] = [];
        for (const c of candidates) due.push({ id: c.id as string, open_payroll: await this.inOpenPayroll(tx, c.id) });
        for (const e of due) {
          if (e.open_payroll) {
            heldByPayroll++;
            continue;
          }
          const open = await tx.collection('privacy_requests').findOne({ employee_id: e.id, kind: 'erasure', status: 'open' });
          const reqId = (open?.id as string | undefined) ?? ((await tx.collection('privacy_requests').insert({
            employee_id: e.id, kind: 'erasure', source: 'Retention schedule', due_on: today(), requested_by_membership_id: p.updated_by_membership_id,
          })).id as string);
          await this.eraseRequest(tx, reqId, `Erased by the retention schedule: more than ${p.exited_erasure_years} years after the last working day.`, null, tenantId, files);
          erased.push(e.id);
        }
      }
      const exports = await this.dropExports(tx, { completed_at: { $lt: daysAgo(p.export_days) } });
      files.push(...exports);
      // These logs are append-only for the workspace; they are deleted unscoped, limited to this workspace.
      const del = (table: string) => tx.unscoped(table).delete({ tenant_id: tenantId, created_at: { $lt: daysAgo(p.sign_in_log_days) } });
      const logs = { signInStates: await del('sso_login_states'), mobileHandoffs: await del('sso_handoffs'), provisioningCalls: await del('scim_events') };
      const out = { trigger, erased: erased.length, heldByPayroll, exportsDeleted: exports.length, ...logs, policy: { exitedErasureYears: p.exited_erasure_years, exportDays: p.export_days, signInLogDays: p.sign_in_log_days } };
      await tx.collection('retention_runs').insert({ result: out });
      await this.audit.record(tx, { tenantId, action: 'privacy.retention_applied', resourceType: 'retention_policy', resourceId: tenantId, metadata: out });
      return out;
    }, { tenantId });
    await this.removeFiles(files);
    return result;
  }

  /** Once a day per workspace, from the hourly HR jobs. */
  async applyRetentionDaily(tenantId: string) {
    const ranToday = await this.db.tenant((tx) => tx.collection('retention_runs').exists({ ran_at: { $gt: daysAgo(1) }, 'result.trigger': 'schedule' }), { tenantId });
    if (ranToday) return null;
    return this.applyRetention(tenantId, 'schedule');
  }
}
