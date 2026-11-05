import { createHash } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type expenseClaimInput, money, RECEIPT_MAX_BYTES, RECEIPT_TYPES } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { sniffMatches, StorageService } from '../../platform/storage/storage.service';
import { ApprovalsService } from '../approvals/approvals.service';
import type { UploadedFile } from '../documents/documents.service';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';
import { attrsOf, payrollEmployee } from './salaries.service';
import { safeFileName } from '../../platform/http/content-disposition';

interface ClaimRow {
  id: string;
  employee_id: string;
  status: string;
  amount: string;
  currency: string;
  approval_request_id: string | null;
  receipt_key: string | null;
}

const CLAIM_COLS = `c.id, c.employee_id as "employeeId", trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as "employeeName", e.employee_code as "employeeCode",
  c.category_id as "categoryId", cat.name as "categoryName", to_char(c.spent_on, 'YYYY-MM-DD') as "spentOn", c.amount::text, c.currency, c.description,
  c.receipt_name as "receiptName", c.receipt_type as "receiptType", c.receipt_size as "receiptSize", c.status, c.approval_request_id as "approvalRequestId",
  c.payroll_run_id as "payrollRunId", to_char(r.period_start, 'YYYY-MM') as "paidInMonth", c.decided_at as "decidedAt", c.paid_at as "paidAt", c.created_at as "createdAt"`;
const CLAIM_FROM = `expense_claims c join employees e on e.id = c.employee_id join expense_categories cat on cat.id = c.category_id
  left join payroll_runs r on r.id = c.payroll_run_id and c.status = 'paid'`;

/** Expense claims: submitted with a receipt, approved through the approvals engine, paid as a reimbursement in the next payroll run. */
@Injectable()
export class ExpensesService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly approvals: ApprovalsService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit() {
    this.approvals.register('expense_claim', {
      permission: 'expenses:approve',
      configurePermission: 'payroll:configure',
      defaultSteps: [{ type: 'manager' }],
      fallbackRole: 'finance_manager',
      label: 'Expense claim',
      link: () => `/expenses?view=approvals`,
      attributes: async (tx, id) => attrsOf(await payrollEmployee(tx, (await this.load(tx, id)).employee_id)),
      onApproved: (tx, req) => this.decided(tx, req.resource_id, 'approved'),
      onRejected: (tx, req) => this.decided(tx, req.resource_id, 'rejected'),
    });
  }

  private async load(tx: Tx, id: string, lock = false) {
    const c = await one<ClaimRow>(tx, `select id, employee_id, status, amount::text, currency, approval_request_id, receipt_key from expense_claims where id = $1${lock ? ' for update' : ''}`, [id]);
    if (!c) throw Errors.notFound('Expense claim');
    return c;
  }

  private async decided(tx: Tx, id: string, status: 'approved' | 'rejected') {
    const c = await one<{ employee_id: string; amount: string; currency: string }>(
      tx, `update expense_claims set status = $2, decided_at = now() where id = $1 and status = 'pending' returning employee_id, amount::text, currency`, [id, status],
    );
    if (!c) return;
    await this.audit.record(tx, { action: `expense_claim.${status}`, resourceType: 'expense_claim', resourceId: id });
    const e = await payrollEmployee(tx, c.employee_id);
    await this.notifications.notify(tx, {
      membershipIds: [e.membership_id], kind: `expense_claim.${status}`,
      title: `Your expense claim of ${money.formatMoney(money.toMinor(c.amount), c.currency)} was ${status}${status === 'approved' ? '. It will be paid with your next salary.' : ''}`,
      link: '/expenses',
    });
  }

  /** Can the caller see this claim: their own, or one they may approve or pay. */
  private async visible(tx: Tx, c: ClaimRow) {
    const e = await payrollEmployee(tx, c.employee_id);
    const s = await this.authz.subject(tx);
    if (s.employeeId === e.id) return e;
    const attrs = attrsOf(e);
    if (can(s, 'expenses:approve', attrs).allowed) return e;
    const payroll = can(s, 'payroll:read', attrs);
    if (payroll.allowed) return e;
    if (payroll.reason === 'mfa_required') throw Errors.mfaRequired();
    throw Errors.notFound('Expense claim');
  }

  /**
   * view 'mine': the caller's claims. 'approvals': claims waiting for the caller's decision. 'all': every claim the
   * caller may approve.
   */
  async list(q: { view: 'mine' | 'approvals' | 'all'; status?: string }) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (q.view === 'mine') {
        if (!s.employeeId) return [];
        return many(tx, `select ${CLAIM_COLS} from ${CLAIM_FROM} where c.employee_id = $1 and ($2::text is null or c.status = $2) order by c.created_at desc limit 200`, [s.employeeId, q.status ?? null]);
      }
      if (q.view === 'approvals') {
        return many(
          tx,
          `select ${CLAIM_COLS} from ${CLAIM_FROM}
             join approval_steps st on st.request_id = c.approval_request_id and st.status = 'pending'
            where c.status = 'pending' and (st.approver_membership_id = $1 or (st.approver_membership_id is null and exists (
                    select 1 from role_assignments ra join roles ro on ro.id = ra.role_id where ra.membership_id = $1 and ro.key = st.approver_role_key)))
              and e.membership_id is distinct from $1
            order by c.created_at limit 200`,
          [actor.membershipId],
        );
      }
      const params: unknown[] = [q.status ?? null];
      const pred = await this.authz.predicate('expenses:approve', EMPLOYEE_SCOPE, params, tx);
      return many(tx, `select ${CLAIM_COLS} from ${CLAIM_FROM} where ${pred} and ($1::text is null or c.status = $1) order by c.created_at desc limit 500`, params);
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      await this.visible(tx, await this.load(tx, id));
      return one(tx, `select ${CLAIM_COLS} from ${CLAIM_FROM} where c.id = $1`, [id]);
    });
  }

  private checkReceipt(file: UploadedFile) {
    if (!(RECEIPT_TYPES as readonly string[]).includes(file.mimetype)) throw Errors.badRequest('unsupported_type', 'Upload the receipt as a PDF, JPEG or PNG');
    if (file.size <= 0 || file.size > RECEIPT_MAX_BYTES) throw Errors.badRequest('file_too_large', 'A receipt can be up to 5 MB');
    if (!sniffMatches(file.mimetype, file.buffer.subarray(0, 512))) throw Errors.badRequest('content_mismatch', 'The file content does not match its type');
  }

  async submit(input: z.infer<typeof expenseClaimInput>, file: UploadedFile | undefined) {
    const actor = requestContext.tenantActor();
    if (file) this.checkReceipt(file);
    const key = file ? this.storage.newKey(actor.tenantId) : null;
    let stored = false;
    try {
      return await this.db.tenant(async (tx) => {
        const s = await this.authz.subject(tx);
        if (!s.employeeId) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet. Ask HR to link it.');
        const e = await payrollEmployee(tx, s.employeeId);
        await this.authz.require('expenses:submit', attrsOf(e), tx);
        const cat = await one<{ name: string; receipt_required: boolean; max_per_claim: string | null }>(
          tx, 'select name, receipt_required, max_per_claim::text from expense_categories where id = $1 and archived_at is null', [input.categoryId],
        );
        if (!cat) throw Errors.badRequest('unknown_category', 'Choose an expense category');
        if (cat.receipt_required && !file) throw Errors.badRequest('receipt_required', `${cat.name} claims need a receipt`);
        if (cat.max_per_claim && money.toMinor(input.amount) > money.toMinor(cat.max_per_claim)) {
          throw Errors.badRequest('over_limit', `${cat.name} claims can be up to ${cat.max_per_claim} each`);
        }
        const today = new Date().toISOString().slice(0, 10);
        if (input.spentOn > today) throw Errors.badRequest('future_date', 'The expense date cannot be in the future');
        const le = e.legal_entity_id ? await one<{ currency: string }>(tx, 'select currency from legal_entities where id = $1', [e.legal_entity_id]) : undefined;
        const currency = le?.currency ?? (await one<{ currency: string }>(tx, 'select currency from tenants where id = app_tenant_id()'))!.currency;
        if (file && key) {
          await this.storage.put(key, file.buffer);
          stored = true;
        }
        const row = (await one<{ id: string }>(
          tx,
          `insert into expense_claims (tenant_id, employee_id, category_id, spent_on, amount, currency, description, receipt_key, receipt_name, receipt_type, receipt_size, receipt_sha256, submitted_by_membership_id)
           values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
          [
            e.id, input.categoryId, input.spentOn, input.amount, currency, input.description, key,
            file ? safeFileName(file.originalname, 'receipt') : null, file?.mimetype ?? null, file?.size ?? null,
            file ? createHash('sha256').update(file.buffer).digest('hex') : null, actor.membershipId,
          ],
        ))!;
        const summary = `${e.name}: ${cat.name} expense of ${money.formatMoney(money.toMinor(input.amount), currency)} on ${input.spentOn}. ${input.description}`;
        const approvalId = await this.approvals.start(tx, { resourceType: 'expense_claim', resourceId: row.id, subjectEmployeeId: e.id, summary });
        await tx.query('update expense_claims set approval_request_id = $2 where id = $1', [row.id, approvalId]);
        await this.audit.record(tx, { action: 'expense_claim.submitted', resourceType: 'expense_claim', resourceId: row.id, changes: input, metadata: { receipt: Boolean(file) } });
        return { id: row.id, status: 'pending' };
      });
    } catch (err) {
      if (stored && key) await this.storage.remove(key);
      throw err;
    }
  }

  cancel(id: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.load(tx, id, true);
      const s = await this.authz.subject(tx);
      if (s.employeeId !== c.employee_id) {
        await this.visible(tx, c);
        throw Errors.forbidden('Only the person who claimed can withdraw a claim');
      }
      if (c.status !== 'pending') throw Errors.conflict('invalid_state', `This claim is ${c.status}`);
      if (c.approval_request_id) await this.approvals.cancel(tx, c.approval_request_id);
      await tx.query(`update expense_claims set status = 'cancelled' where id = $1`, [id]);
      await this.audit.record(tx, { action: 'expense_claim.cancelled', resourceType: 'expense_claim', resourceId: id });
      return { status: 'cancelled' };
    });
  }

  /** A 5-minute link to the receipt. Every link issued is audited. */
  receiptLink(id: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.load(tx, id);
      await this.visible(tx, c);
      if (!c.receipt_key) throw Errors.notFound('Receipt');
      await this.audit.record(tx, { action: 'expense_receipt.downloaded', resourceType: 'expense_claim', resourceId: id });
      return this.storage.sign(id, 300, 'receipts');
    });
  }

  async openReceipt(id: string, exp: number, sig: string) {
    if (!this.storage.verify(id, exp, sig, 'receipts')) throw Errors.notFound('File');
    const f = await this.db.platform((tx) => one<{ receipt_key: string | null; receipt_name: string; receipt_type: string }>(tx, 'select receipt_key, receipt_name, receipt_type from expense_claims where id = $1', [id]));
    if (!f?.receipt_key) throw Errors.notFound('File');
    const { stream, size } = await this.storage.open(f.receipt_key);
    return { stream, size, fileName: f.receipt_name, contentType: f.receipt_type };
  }
}
