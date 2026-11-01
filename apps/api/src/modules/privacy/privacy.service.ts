import { Injectable, Logger } from '@nestjs/common';
import { ERASURE_RULES, PRIVACY_DUE_DAYS } from '@crew/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
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
    return this.db.tenant((tx) =>
      many(
        tx,
        `select r.id, r.kind, r.status, r.source, r.due_on as "dueOn", r.created_at as "createdAt", r.completed_at as "completedAt",
                r.employee_id as "employeeId", trim(e.first_name || ' ' || e.last_name) as "employeeName", e.employee_code as "employeeCode", e.status as "employeeStatus",
                (r.status = 'open' and r.due_on < current_date) as overdue
           from privacy_requests r join employees e on e.id = r.employee_id
          where ($1::text is null or r.status = $1) order by r.status = 'open' desc, r.due_on, r.created_at desc limit 500`,
        [status ?? null],
      ),
    );
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await one(
        tx,
        `select r.id, r.kind, r.status, r.source, r.due_on as "dueOn", r.created_at as "createdAt", r.completed_at as "completedAt", r.decision_note as "decisionNote",
                r.result, r.export_sha256 as "exportSha256", (r.export_storage_key is not null) as "hasExport",
                r.employee_id as "employeeId", trim(e.first_name || ' ' || e.last_name) as "employeeName", e.employee_code as "employeeCode",
                e.status as "employeeStatus", e.last_working_day as "lastWorkingDay", e.erased_at as "erasedAt",
                ru.full_name as "requestedBy", du.full_name as "decidedBy"
           from privacy_requests r join employees e on e.id = r.employee_id
           join memberships rm on rm.id = r.requested_by_membership_id join users ru on ru.id = rm.user_id
           left join memberships dm on dm.id = r.decided_by_membership_id left join users du on du.id = dm.user_id
          where r.id = $1`,
        [id],
      );
      if (!r) throw Errors.notFound('Privacy request');
      return { ...r, erasureRules: ERASURE_RULES };
    });
  }

  async create(input: { employeeId: string; kind: 'access' | 'erasure'; source: string }) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const e = await one<{ erased_at: string | null }>(tx, 'select erased_at from employees where id = $1', [input.employeeId]);
      if (!e) throw Errors.notFound('Employee');
      if (e.erased_at) throw Errors.conflict('already_erased', 'This person\'s details were already erased.');
      if (await one(tx, `select 1 from privacy_requests where employee_id = $1 and kind = $2 and status = 'open'`, [input.employeeId, input.kind])) {
        throw Errors.conflict('request_open', 'There is already an open request of this kind for this person.');
      }
      const r = (await one<{ id: string }>(
        tx,
        `insert into privacy_requests (tenant_id, employee_id, kind, source, due_on, requested_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, current_date + $4::int, $5) returning id`,
        [input.employeeId, input.kind, input.source, PRIVACY_DUE_DAYS, actor.membershipId],
      ))!;
      await this.audit.record(tx, { action: 'privacy.request_logged', resourceType: 'privacy_request', resourceId: r.id, metadata: { kind: input.kind, employeeId: input.employeeId } });
      return { id: r.id };
    });
  }

  async reject(id: string, note: string) {
    const actor = requestContext.tenantActor();
    await this.db.tenant(async (tx) => {
      await this.open(tx, id);
      await tx.query(`update privacy_requests set status = 'rejected', decided_by_membership_id = $2, decision_note = $3, completed_at = now(), updated_at = now() where id = $1`, [id, actor.membershipId, note]);
      await this.audit.record(tx, { action: 'privacy.request_rejected', resourceType: 'privacy_request', resourceId: id, metadata: { note } });
    });
    return { ok: true };
  }

  private async open(tx: Tx, id: string) {
    const r = await one<{ id: string; kind: string; status: string; employee_id: string }>(tx, 'select id, kind, status, employee_id from privacy_requests where id = $1 for update', [id]);
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
      await tx.query(
        `update privacy_requests set status = 'completed', decided_by_membership_id = $2, decision_note = $3, export_storage_key = $4, export_sha256 = $5,
                result = $6, completed_at = now(), updated_at = now() where id = $1`,
        [id, actor.membershipId, note, key, sha, JSON.stringify({ records: summary, bytes: body.length, skipped: EXPORT_SKIPPED })],
      );
      await this.audit.record(tx, { action: 'privacy.export_prepared', resourceType: 'privacy_request', resourceId: id, metadata: { employeeId: r.employee_id, bytes: body.length, sha256: sha } });
      return { ok: true, records: summary };
    });
  }

  /** Everything CREW holds about the person in this workspace, by table. */
  private async collect(tx: Tx, employeeId: string) {
    const employee = (await one<Record<string, unknown>>(tx, 'select * from employees where id = $1', [employeeId]))!;
    const tables = await many<{ table_name: string }>(
      tx,
      `select c.table_name from information_schema.columns c join information_schema.tables t on t.table_name = c.table_name and t.table_schema = c.table_schema
        where c.table_schema = 'public' and c.column_name = 'employee_id' and t.table_type = 'BASE TABLE' order by c.table_name`,
    );
    const records: Record<string, unknown[]> = {};
    const unreadable: string[] = [];
    for (const { table_name: t } of tables) {
      if (EXPORT_SKIPPED[t]) continue;
      try {
        await tx.query('savepoint export_table');
        const rows = await many<Record<string, unknown>>(tx, `select * from ${quoteIdent(t)} where employee_id = $1 limit ${MAX_ROWS}`, [employeeId]);
        await tx.query('release savepoint export_table');
        if (rows.length) records[t] = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !SECRET_COLUMNS.test(k))));
      } catch {
        await tx.query('rollback to savepoint export_table');
        unreadable.push(t);
      }
    }
    // Helpdesk conversations: what the person and handlers wrote to each other (internal notes excluded).
    if (records.helpdesk_cases) {
      records.helpdesk_messages = await many(
        tx,
        `select m.case_id, m.body, m.created_at from helpdesk_messages m join helpdesk_cases c on c.id = m.case_id where c.employee_id = $1 and not m.internal order by m.created_at limit ${MAX_ROWS}`,
        [employeeId],
      );
    }
    const sensitive = await one<Record<string, unknown>>(tx, `select bank_name, (bank_account_enc is not null) as bank_account_on_file, (tax_id_enc is not null) as tax_id_on_file, (national_id_enc is not null) as national_id_on_file from employee_sensitive where employee_id = $1`, [employeeId]);
    const account = employee.membership_id
      ? await one(tx, `select u.email::text, u.full_name, u.last_login_at, u.mfa_enabled, m.status, m.created_at from memberships m join users u on u.id = m.user_id where m.id = $1`, [employee.membership_id])
      : null;
    const workspace = (await one<{ name: string }>(tx, 'select name from tenants where id = app_tenant_id()'))!;
    return {
      format: 'crew-personal-data-export/1',
      generatedAt: new Date().toISOString(),
      workspace: workspace.name,
      about: 'A copy of the personal data this workspace holds about you in CREW, by record type. Dates are ISO 8601; amounts are in the currency of the record.',
      employee: Object.fromEntries(Object.entries(employee).filter(([k]) => !SECRET_COLUMNS.test(k))),
      account,
      sensitive: sensitive ?? null,
      records,
      notIncluded: { ...EXPORT_SKIPPED, ...(unreadable.length ? { [unreadable.join(', ')]: 'Could not be read for this export; ask your HR team.' } : {}) },
    };
  }

  async download(id: string) {
    const r = await this.db.tenant(async (tx) => {
      const row = await one<{ export_storage_key: string | null; employee_code: string }>(tx, 'select r.export_storage_key, e.employee_code from privacy_requests r join employees e on e.id = r.employee_id where r.id = $1', [id]);
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
    const result = await this.db.tenant(async (tx) => {
      const r = await this.open(tx, id);
      if (r.kind !== 'erasure') throw Errors.badRequest('wrong_kind', 'This is not an erasure request.');
      const e = (await one<{ status: string; last_working_day: string | null; membership_id: string | null; past: boolean }>(
        tx,
        'select status, last_working_day, membership_id, (last_working_day < current_date) as past from employees where id = $1',
        [r.employee_id],
      ))!;
      if (e.status !== 'exited' || !e.past) {
        throw Errors.conflict('still_employed', 'Only people who have left (after their last working day) can be erased. While someone works here, CREW needs their details to employ and pay them.');
      }
      if (await one(tx, `select 1 from payroll_items i join payroll_runs pr on pr.id = i.run_id where i.employee_id = $1 and pr.status not in ('finalised', 'cancelled') limit 1`, [r.employee_id])) {
        throw Errors.conflict('payroll_open', 'This person is in a payroll run that is not finalised. Finish or cancel it first.');
      }
      // Lets the helpdesk guard accept the one change erasure makes to case text (see migration 0010).
      await tx.query(`select set_config('crew.erasure', 'on', true)`);
      const counts: Record<string, number> = {};
      const code = `ERASED-${r.employee_id.slice(0, 8).toUpperCase()}`;
      await tx.query(
        `update employees set first_name = 'Erased', last_name = 'person', preferred_name = null, employee_code = $2, work_email = null, personal_email = null,
                phone = null, date_of_birth = null, gender = null, exit_reason = null, erased_at = now() where id = $1`,
        [r.employee_id, code],
      );
      counts.sensitive = (await tx.query('delete from employee_sensitive where employee_id = $1', [r.employee_id])).rowCount ?? 0;
      const docs = await many<{ storage_key: string }>(tx, 'delete from employee_documents where employee_id = $1 returning storage_key', [r.employee_id]);
      files.push(...docs.map((d) => d.storage_key));
      counts.documents = docs.length;
      counts.helpdeskCases = (await tx.query(`update helpdesk_cases set subject = '[erased]', description = '[erased] (personal details removed on request)' where employee_id = $1`, [r.employee_id])).rowCount ?? 0;
      counts.leaveReasons = (await tx.query(`update leave_requests set reason = null where employee_id = $1 and reason is not null`, [r.employee_id])).rowCount ?? 0;
      if (e.membership_id) {
        counts.helpdeskMessages = (await this.db.platform((ptx) => ptx.query(`update helpdesk_messages set body = '[erased]' where author_membership_id = $1 and tenant_id = $2`, [e.membership_id, actor.tenantId]))).rowCount ?? 0;
        await tx.query(`update memberships set status = 'suspended', scim_external_id = null where id = $1`, [e.membership_id]);
        // The login is global: it is anonymised only when it belongs to no other workspace.
        await this.db.platform(async (ptx) => {
          const u = (await one<{ id: string; others: number }>(ptx, `select u.id, (select count(*)::int from memberships o where o.user_id = u.id and o.id <> m.id) as others from memberships m join users u on u.id = m.user_id where m.id = $1`, [e.membership_id]))!;
          await ptx.query(`update sessions set revoked_at = now(), revoked_reason = 'erased' where user_id = $1 and tenant_id = $2 and revoked_at is null`, [u.id, actor.tenantId]);
          if (u.others === 0) {
            await ptx.query(
              `update users set email = $2, full_name = 'Erased person', password_hash = null, mfa_secret_enc = null, mfa_enabled = false, status = 'disabled' where id = $1`,
              [u.id, `erased-${u.id}@erased.invalid`],
            );
            counts.loginErased = 1;
          }
        });
      }
      const resultJson = { removed: counts, rules: ERASURE_RULES };
      await tx.query(
        `update privacy_requests set status = 'completed', decided_by_membership_id = $2, decision_note = $3, result = $4, completed_at = now(), updated_at = now() where id = $1`,
        [id, actor.membershipId, note, JSON.stringify(resultJson)],
      );
      // An access export made earlier would now be the only copy of the erased details, so it goes too.
      const exports = await many<{ export_storage_key: string }>(tx, `select export_storage_key from privacy_requests where employee_id = $1 and export_storage_key is not null`, [r.employee_id]);
      files.push(...exports.map((x) => x.export_storage_key));
      await this.audit.record(tx, { action: 'privacy.erased', resourceType: 'employee', resourceId: r.employee_id, metadata: { requestId: id, removed: counts } });
      return resultJson;
    });
    for (const f of files) await this.storage.remove(f).catch((err: Error) => this.logger.error(`Could not delete ${f}: ${err.message}`));
    return { ok: true, ...result };
  }
}

function quoteIdent(name: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('bad identifier');
  return `"${name}"`;
}
