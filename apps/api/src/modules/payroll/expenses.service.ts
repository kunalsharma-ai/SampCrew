import { createHash } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type expenseClaimInput, money, RECEIPT_MAX_BYTES, RECEIPT_TYPES } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { sniffMatches, StorageService } from '../../platform/storage/storage.service';
import { ApprovalsService } from '../approvals/approvals.service';
import type { UploadedFile } from '../documents/documents.service';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { displayName, employeeNames, fieldById } from '../employees/employee-view';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** Claims as the API shows them: with the employee, the category and the month they were paid in. */
async function claimViews(tx: TenantTx, claims: Doc[]) {
  const [emps, cats] = await Promise.all([employeeNames(tx, claims.map((c) => c.employee_id)), fieldById(tx, 'expense_categories', claims.map((c) => c.category_id))]);
  const runs = await fieldById(tx, 'payroll_runs', claims.filter((c) => c.status === 'paid').map((c) => c.payroll_run_id), 'period_start');
  return claims.map((c) => {
    const e = emps.get(c.employee_id);
    const paidIn = c.status === 'paid' && c.payroll_run_id ? runs.get(c.payroll_run_id) : undefined;
    return {
      id: c.id, employeeId: c.employee_id, employeeName: e ? displayName(e.doc as never) : null, employeeCode: e?.doc.employee_code ?? null,
      categoryId: c.category_id, categoryName: cats.get(c.category_id) ?? null, spentOn: c.spent_on, amount: c.amount, currency: c.currency, description: c.description,
      receiptName: c.receipt_name ?? null, receiptType: c.receipt_type ?? null, receiptSize: c.receipt_size ?? null, status: c.status,
      approvalRequestId: c.approval_request_id ?? null, payrollRunId: c.payroll_run_id ?? null, paidInMonth: paidIn ? paidIn.slice(0, 7) : null,
      decidedAt: c.decided_at ?? null, paidAt: c.paid_at ?? null, createdAt: c.created_at,
    };
  });
}

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

  private async load(tx: TenantTx, id: string, lock = false): Promise<ClaimRow> {
    const claims = tx.collection('expense_claims');
    if (lock && !(await claims.lock({ id }))) throw Errors.notFound('Expense claim');
    const c = await claims.findOne({ id });
    if (!c) throw Errors.notFound('Expense claim');
    return { id: c.id, employee_id: c.employee_id, status: c.status, amount: c.amount, currency: c.currency, approval_request_id: c.approval_request_id ?? null, receipt_key: c.receipt_key ?? null };
  }

  private async decided(tx: TenantTx, id: string, status: 'approved' | 'rejected') {
    const c = await tx.collection('expense_claims').updateAndGet({ id, status: 'pending' }, { $set: { status, decided_at: new Date() } });
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
  private async visible(tx: TenantTx, c: ClaimRow) {
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
      const claims = tx.collection('expense_claims');
      if (q.view === 'mine') {
        if (!s.employeeId) return [];
        return claimViews(tx, await claims.find({ employee_id: s.employeeId, ...(q.status ? { status: q.status } : {}) }, { sort: { created_at: -1 }, limit: 200 }));
      }
      if (q.view === 'approvals') {
        const roleIds = await tx.collection('role_assignments').distinct<string>('role_id', { membership_id: actor.membershipId });
        const roleKeys = await tx.collection('roles').distinct<string>('key', { id: { $in: roleIds } });
        const steps = await tx.collection('approval_steps').find({
          status: 'pending', $or: [{ approver_membership_id: actor.membershipId }, { approver_membership_id: null, approver_role_key: { $in: roleKeys } }],
        }, { projection: { request_id: 1 } });
        const mine = await tx.collection('employees').distinct<string>('id', { membership_id: actor.membershipId });
        return claimViews(tx, await claims.find(
          { status: 'pending', approval_request_id: { $in: steps.map((st) => st.request_id) }, employee_id: { $nin: mine } },
          { sort: { created_at: 1 }, limit: 200 },
        ));
      }
      const scope = await this.authz.filter('expenses:approve', EMPLOYEE_FIELDS, tx);
      const visible = await tx.collection('employees').distinct<string>('id', scope);
      return claimViews(tx, await claims.find({ employee_id: { $in: visible }, ...(q.status ? { status: q.status } : {}) }, { sort: { created_at: -1 }, limit: 500 }));
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      await this.visible(tx, await this.load(tx, id));
      return (await claimViews(tx, [(await tx.collection('expense_claims').findOne({ id }))!]))[0];
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
        const cat = await tx.collection<{ name: string; receipt_required: boolean; max_per_claim: string | null }>('expense_categories').findOne({ id: input.categoryId, archived_at: null });
        if (!cat) throw Errors.badRequest('unknown_category', 'Choose an expense category');
        if (cat.receipt_required && !file) throw Errors.badRequest('receipt_required', `${cat.name} claims need a receipt`);
        if (cat.max_per_claim && money.toMinor(input.amount) > money.toMinor(cat.max_per_claim)) {
          throw Errors.badRequest('over_limit', `${cat.name} claims can be up to ${cat.max_per_claim} each`);
        }
        const today = new Date().toISOString().slice(0, 10);
        if (input.spentOn > today) throw Errors.badRequest('future_date', 'The expense date cannot be in the future');
        const le = e.legal_entity_id ? await tx.collection('legal_entities').findOne({ id: e.legal_entity_id }) : undefined;
        const currency: string = le?.currency ?? (await tx.collection('tenants').findOne({ id: tx.tenantId }))!.currency;
        if (file && key) {
          await this.storage.put(key, file.buffer, { upload: true });
          stored = true;
        }
        const row = await tx.collection('expense_claims').insert({
          employee_id: e.id, category_id: input.categoryId, spent_on: input.spentOn, amount: input.amount, currency, description: input.description, receipt_key: key,
          receipt_name: file ? safeFileName(file.originalname, 'receipt') : null, receipt_type: file?.mimetype ?? null, receipt_size: file?.size ?? null,
          receipt_sha256: file ? createHash('sha256').update(file.buffer).digest('hex') : null, submitted_by_membership_id: actor.membershipId,
        });
        const summary = `${e.name}: ${cat.name} expense of ${money.formatMoney(money.toMinor(input.amount), currency)} on ${input.spentOn}. ${input.description}`;
        const approvalId = await this.approvals.start(tx, { resourceType: 'expense_claim', resourceId: row.id, subjectEmployeeId: e.id, summary });
        await tx.collection('expense_claims').updateOne({ id: row.id }, { $set: { approval_request_id: approvalId } });
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
      await tx.collection('expense_claims').updateOne({ id }, { $set: { status: 'cancelled' } });
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
    const f = await this.db.platform((tx) => tx.collection<{ receipt_key: string | null; receipt_name: string; receipt_type: string }>('expense_claims').findOne({ id }));
    if (!f?.receipt_key) throw Errors.notFound('File');
    const { stream, size } = await this.storage.open(f.receipt_key);
    return { stream, size, fileName: f.receipt_name, contentType: f.receipt_type };
  }
}
