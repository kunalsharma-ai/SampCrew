import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { billingMath as bm, type CreditNoteView, type RefundInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { ConsoleNotifyService } from '../../platform/notify/console-notify.service';
import { BillingEngine } from '../billing/billing-engine.service';
import { GatewayError, refundPayment } from '../billing/gateways';

interface InvoiceRow { id: string; number: string; tenant_id: string; status: string; total: string; currency: string; provider: string | null; paid_reference: string | null; payment_order_id: string | null }
interface NoteRow { id: string; number: string; tenant_id: string; invoice_id: string | null; kind: 'refund' | 'credit'; method: CreditNoteView['method']; amount: string; currency: string; reason: string; provider_ref: string | null; status: 'issued' | 'void'; void_reason: string | null; created_at: Date; created_by_admin_id: string | null }

/**
 * Refunds on paid invoices, each with a credit note (CN2627-000001). Through the gateway, the money goes back to the
 * card or account that paid, using the keys in Console > Integrations; by bank transfer, the Console records the
 * transfer SAMPLEDGE made. The invoice keeps its number and total; the refunds against it can never add up to more
 * than it. Every refund is audited in the Console and in the client's workspace, and the client's Super Workspace
 * admins are told.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly engine: BillingEngine,
    private readonly consoleNotify: ConsoleNotifyService,
  ) {}

  list(q: { tenantId?: string; invoiceId?: string; clientId?: string }) {
    return this.db.platform(async (tx) => {
      const filter: Record<string, unknown> = {};
      if (q.invoiceId) filter.invoice_id = q.invoiceId;
      if (q.tenantId) filter.tenant_id = q.tenantId;
      if (q.clientId) filter.tenant_id = { $in: await tx.collection('tenants').distinct<string>('id', { company_id: q.clientId }) };
      const rows = await tx.collection<NoteRow>('credit_notes').find(filter, { sort: { created_at: -1 }, limit: 300 });
      return this.views(tx, rows);
    });
  }

  private async views(tx: PlatformTx, rows: NoteRow[]): Promise<CreditNoteView[]> {
    const tenants = new Map((await tx.collection<{ id: string; name: string; company_id: string | null }>('tenants').find({ id: { $in: [...new Set(rows.map((r) => r.tenant_id))] } }, { projection: { name: 1, company_id: 1 } })).map((t) => [t.id, t]));
    const invoices = new Map((await tx.collection<{ id: string; number: string }>('invoices').find({ id: { $in: rows.map((r) => r.invoice_id).filter(Boolean) } }, { projection: { number: 1 } })).map((i) => [i.id, i.number]));
    const admins = new Map((await tx.collection<{ id: string; full_name: string }>('platform_admins').find({ id: { $in: rows.map((r) => r.created_by_admin_id).filter(Boolean) } }, { projection: { full_name: 1 } })).map((a) => [a.id, a.full_name]));
    return rows.map((r) => ({
      id: r.id, number: r.number, tenantId: r.tenant_id, workspace: tenants.get(r.tenant_id)?.name ?? '', clientId: tenants.get(r.tenant_id)?.company_id ?? null, invoiceId: r.invoice_id ?? null,
      invoiceNumber: r.invoice_id ? invoices.get(r.invoice_id) ?? null : null, kind: r.kind, method: r.method, amount: String(r.amount), currency: r.currency, reason: r.reason, providerRef: r.provider_ref ?? null,
      status: r.status, voidReason: r.void_reason ?? null, createdAt: r.created_at.toISOString(), createdBy: r.created_by_admin_id ? admins.get(r.created_by_admin_id) ?? null : null,
    }));
  }

  /** How much of a paid invoice can still be refunded. */
  private async refundable(tx: PlatformTx, inv: InvoiceRow) {
    const done = await tx.collection<{ amount: string }>('credit_notes').find({ invoice_id: inv.id, status: 'issued' }, { projection: { amount: 1 } });
    return bm.minus(String(inv.total), bm.sum(done.map((d) => String(d.amount))));
  }

  /** The gateway payment that paid an invoice: the payment order's payment id, or the reference saved on the invoice. */
  private async paymentId(tx: PlatformTx, inv: InvoiceRow): Promise<string | null> {
    if (inv.payment_order_id) {
      const o = await tx.collection<{ provider_payment_id: string | null }>('payment_orders').findOne({ id: inv.payment_order_id }, { projection: { provider_payment_id: 1 } });
      if (o?.provider_payment_id) return o.provider_payment_id;
    }
    return inv.paid_reference && /^(pay_|pi_)/.test(inv.paid_reference) ? inv.paid_reference : null;
  }

  async refund(input: RefundInput) {
    const admin = requestContext.platformActor();
    if (!admin.mfa) throw Errors.mfaRequired();
    const prepared = await this.db.platform(async (tx) => {
      const inv = await tx.collection<InvoiceRow>('invoices').findOne({ id: input.invoiceId });
      if (!inv) throw Errors.notFound('Invoice');
      if (inv.status !== 'paid') throw Errors.conflict('invoice_not_paid', `Invoice ${inv.number} is ${inv.status}; only paid invoices can be refunded`);
      const left = await this.refundable(tx, inv);
      if (!bm.isPositive(input.amount)) throw Errors.badRequest('bad_amount', 'Enter an amount above zero');
      if (bm.isPositive(bm.minus(input.amount, left))) throw Errors.badRequest('too_much', `At most ${inv.currency} ${left} of ${inv.number} can still be refunded`);
      let paymentId: string | null = null;
      if (input.method === 'gateway') {
        if (inv.provider !== 'razorpay' && inv.provider !== 'stripe') throw Errors.badRequest('not_gateway', `${inv.number} was not paid through Razorpay or Stripe. Record a bank transfer instead.`);
        paymentId = await this.paymentId(tx, inv);
        if (!paymentId) throw Errors.badRequest('no_payment_id', `The ${inv.provider} payment for ${inv.number} is not known. Refund it in ${inv.provider} and record it as a bank transfer with its reference.`);
      } else if (!input.reference) {
        throw Errors.validation([{ path: 'reference', message: 'Enter the bank transfer reference' }]);
      }
      return { inv, paymentId };
    });
    const id = randomUUID();
    let providerRef = input.reference ?? null;
    if (input.method === 'gateway') {
      const keys = await this.engine.gatewayFor(prepared.inv.currency).then((k) => (k?.provider === prepared.inv.provider ? k : null));
      if (!keys) throw Errors.badRequest('gateway_off', `${prepared.inv.provider} is not switched on for ${prepared.inv.currency} in Console > Integrations`);
      try {
        providerRef = await refundPayment(keys, { paymentId: prepared.paymentId!, amountMinor: bm.minorUnits(input.amount), reason: input.reason, creditNoteId: id });
      } catch (e) {
        if (e instanceof GatewayError) throw Errors.badRequest('gateway_refused', e.message);
        throw e;
      }
    }
    return this.db.platform(async (tx) => {
      const inv = prepared.inv;
      // Checked again inside the transaction, so two refunds at the same moment cannot exceed the invoice.
      if (bm.isPositive(bm.minus(input.amount, await this.refundable(tx, inv)))) throw Errors.conflict('too_much', 'Another refund on this invoice was just recorded. Reload and check the amount.');
      const seq = await this.nextSeq(tx);
      const fy = bm.financialYear(new Date().toISOString().slice(0, 10));
      const number = `CN${fy.slice(2, 4)}${fy.slice(5, 7)}-${String(seq).padStart(6, '0')}`;
      await tx.collection('credit_notes').insert({
        id, number, tenant_id: inv.tenant_id, invoice_id: inv.id, kind: 'refund', method: input.method, amount: input.amount, currency: inv.currency, reason: input.reason,
        provider_ref: providerRef, status: 'issued', created_by_admin_id: admin.adminId,
      });
      await this.audit.record(tx, { tenantId: null, action: 'platform.refund_issued', resourceType: 'credit_note', resourceId: id, metadata: { number, invoice: inv.number, amount: input.amount, currency: inv.currency, method: input.method, reference: providerRef, reason: input.reason } });
      await this.audit.record(tx, { tenantId: inv.tenant_id, action: 'billing.refund_issued', resourceType: 'credit_note', resourceId: id, metadata: { number, invoice: inv.number, amount: input.amount, currency: inv.currency } });
      await this.consoleNotify.emit(tx, {
        category: 'payments', kind: 'payments.refund_issued', priority: 'normal', title: `Refund ${inv.currency} ${input.amount} on ${inv.number}`, body: `${number} · ${input.method === 'gateway' ? `through ${inv.provider}` : 'bank transfer'} · ${input.reason}`,
        tenantId: inv.tenant_id, href: '/clients/:company/billing', entityType: 'credit_note', entityId: id,
      });
      await this.engine.notifyAdmins(tx, inv.tenant_id, 'billing.refund_issued', `Refund of ${inv.currency} ${input.amount} on invoice ${inv.number}`, `Credit note ${number}. ${input.method === 'gateway' ? 'The money goes back to the card or account that paid; banks usually take 5 to 10 working days.' : 'Sent by bank transfer.'}`);
      return (await this.views(tx, [(await tx.collection<NoteRow>('credit_notes').findOne({ id }))!]))[0]!;
    });
  }

  /** A credit note recorded by mistake (bank transfer only; a gateway refund cannot be taken back here). */
  voidNote(id: string, reason: string) {
    return this.db.platform(async (tx) => {
      const n = await tx.collection<NoteRow>('credit_notes').findOne({ id });
      if (!n) throw Errors.notFound('Credit note');
      if (n.status === 'void') return { ok: true };
      if (n.method === 'gateway') throw Errors.badRequest('gateway_refund', 'A gateway refund has already returned the money and cannot be voided');
      await tx.collection('credit_notes').updateOne({ id }, { $set: { status: 'void', void_reason: reason } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.credit_note_voided', resourceType: 'credit_note', resourceId: id, changes: { status: { from: 'issued', to: 'void' } }, metadata: { number: n.number, reason } });
      await this.audit.record(tx, { tenantId: n.tenant_id, action: 'billing.credit_note_voided', resourceType: 'credit_note', resourceId: id, metadata: { number: n.number } });
      return { ok: true };
    });
  }

  private async nextSeq(tx: PlatformTx): Promise<number> {
    const db = await this.db.database();
    const r = await db.collection<{ _id: string; value: number }>('_sequences').findOneAndUpdate({ _id: 'credit_note_number' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', session: tx.session });
    return r!.value;
  }
}
