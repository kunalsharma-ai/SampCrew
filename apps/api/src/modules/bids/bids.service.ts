import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  BID_EDITABLE,
  type BidFeeInput,
  type BidInput,
  type BidPricing,
  type BidSendInput,
  type BidStatus,
  type BidTemplateInput,
  type ClientInput,
  formatAmount,
  type RateCard,
  type RateCardInput,
  priceBid,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can, type ResourceAttributes } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { countBy, ilike, membershipUserNames, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import type { EmailAttachment } from '../../platform/notify/mailer.service';
import { NotificationService } from '../../platform/notify/notification.service';
import { StorageService } from '../../platform/storage/storage.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { fieldById } from '../employees/employee-view';
import { uniqueAs } from '../employees/employees.service';
import { type ProposalData, renderProposal } from './proposal-pdf';

/** Row scope: "own" means bids the member owns; "entity" means bids raised under their legal entity. */
const BID_FIELDS = { membershipId: 'owner_membership_id', legalEntityId: 'legal_entity_id', departmentId: '_no_department', locationId: '_no_location' };
const MAX_SCHEDULE_DAYS = 90;

interface BidRow {
  id: string;
  code: string;
  client_id: string;
  legal_entity_id: string;
  title: string;
  mode: 'quick' | 'advanced';
  status: BidStatus;
  currency: string;
  start_date: string;
  duration_months: number;
  on_cost_pct: string;
  overhead_pct: string;
  target_margin_pct: string;
  template_id: string | null;
  cover_note: string;
  terms: string;
  valid_until: string | null;
  version: number;
  approval_request_id: string | null;
  owner_membership_id: string;
  rate_card_id: string | null;
  fees: BidFeeInput[];
}

interface LineRow { roleTitle: string; designationId: string | null; headcount: number; location: string | null; payMonthly: string; billMonthly: string | null; notes: string | null }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const bidRow = (b: Doc): BidRow => ({
  id: b.id, code: b.code, client_id: b.client_id, legal_entity_id: b.legal_entity_id, title: b.title, mode: b.mode, status: b.status, currency: b.currency,
  start_date: b.start_date, duration_months: b.duration_months, on_cost_pct: b.on_cost_pct, overhead_pct: b.overhead_pct, target_margin_pct: b.target_margin_pct,
  template_id: b.template_id ?? null, cover_note: b.cover_note, terms: b.terms, valid_until: b.valid_until ?? null, version: b.version,
  approval_request_id: b.approval_request_id ?? null, owner_membership_id: b.owner_membership_id, rate_card_id: b.rate_card_id ?? null, fees: b.fees ?? [],
});

const clientView = (c: Doc) => ({
  id: c.id as string, name: c.name as string, legalName: c.legal_name ?? null, industry: c.industry ?? null, contactName: c.contact_name ?? null, contactEmail: c.contact_email ?? null,
  contactPhone: c.contact_phone ?? null, address: c.address ?? null, currency: c.currency, notes: c.notes ?? null, archivedAt: c.archived_at ?? null, createdAt: c.created_at,
});

const templateView = (t: Doc) => ({
  id: t.id as string, name: t.name as string, coverNote: t.cover_note, terms: t.terms, validityDays: t.validity_days, onCostPct: t.on_cost_pct, overheadPct: t.overhead_pct,
  targetMarginPct: t.target_margin_pct, isDefault: t.is_default as boolean, updatedAt: t.updated_at,
});

const lower = (v: unknown) => String(v ?? '').toLowerCase();

const attrs = (b: Pick<BidRow, 'owner_membership_id' | 'legal_entity_id'>): ResourceAttributes => ({ membershipId: b.owner_membership_id, legalEntityId: b.legal_entity_id });

/** Trims a percentage stored as numeric(5,2) ("13.00") to its shortest form ("13"). */
const pctText = (v: string) => v.replace(/\.?0+$/, '') || '0';

/**
 * Staffing bids: clients, templates, priced bids, approval before anything reaches a client, the proposal PDF,
 * scheduled proposal emails and the history of every version submitted or sent.
 */
@Injectable()
export class BidsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly approvals: ApprovalsService,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    this.approvals.register('staffing_bid', {
      permission: 'bids:approve',
      configurePermission: 'tenant:manage',
      defaultSteps: [{ type: 'role', role: 'finance_manager' }],
      fallbackRole: 'tenant_owner',
      label: 'Staffing bid',
      link: (id) => `/staffing/bids/${id}`,
      attributes: async (tx, id) => attrs(await this.load(tx, id)),
      onApproved: async (tx, req) => {
        const n = await tx.collection('staffing_bids').updateOne({ id: req.resource_id, status: 'pending_approval' }, { $set: { status: 'approved', approved_at: new Date() } });
        if (!n) return;
        await this.audit.record(tx, { action: 'bid.approved', resourceType: 'staffing_bid', resourceId: req.resource_id });
      },
      onRejected: async (tx, req) => {
        await tx.collection('staffing_bids').updateOne({ id: req.resource_id, status: 'pending_approval' }, { $set: { status: 'rejected' } });
        await this.audit.record(tx, { action: 'bid.rejected', resourceType: 'staffing_bid', resourceId: req.resource_id });
      },
    });
  }

  private async load(tx: TenantTx, id: string, lock = false): Promise<BidRow> {
    const bids = tx.collection('staffing_bids');
    if (lock) await bids.lock({ id });
    const b = await bids.findOne({ id });
    if (!b) throw Errors.notFound('Bid');
    return bidRow(b);
  }

  private async lines(tx: TenantTx, bidId: string): Promise<LineRow[]> {
    return (await tx.collection('bid_lines').find({ bid_id: bidId }, { sort: { seq: 1 } })).map((l) => ({
      roleTitle: l.role_title, designationId: l.designation_id ?? null, headcount: l.headcount, location: l.location ?? null, payMonthly: l.pay_monthly,
      billMonthly: l.bill_monthly ?? null, notes: l.notes ?? null,
    }));
  }

  private async card(tx: TenantTx, id: string | null) {
    if (!id) return null;
    const c = await tx.collection('bid_rate_cards').findOne({ id });
    return c ? { id: c.id as string, name: c.name as string, currency: c.currency as string, lines: c.lines as RateCardInput['lines'] } : null;
  }

  /** Rate cards as the API returns them. */
  private async rateCardViews(tx: TenantTx, cards: Doc[]): Promise<RateCard[]> {
    const clients = await fieldById(tx, 'clients', cards.map((c) => c.client_id));
    return cards.map((c) => ({
      id: c.id, name: c.name, clientId: c.client_id ?? null, clientName: clients.get(c.client_id) ?? null, currency: c.currency, notes: c.notes ?? null, lines: c.lines, updatedAt: c.updated_at,
    })) as RateCard[];
  }

  private price(b: BidRow, lines: LineRow[], card?: { lines: RateCardInput['lines'] } | null): BidPricing {
    return priceBid({
      fees: b.fees ?? [],
      onCostPct: pctText(b.on_cost_pct),
      overheadPct: pctText(b.overhead_pct),
      targetMarginPct: pctText(b.target_margin_pct),
      durationMonths: b.duration_months,
      lines: lines.map((l) => ({ roleTitle: l.roleTitle, headcount: l.headcount, location: l.location ?? undefined, payMonthly: l.payMonthly, billMonthly: l.billMonthly ?? undefined })),
    }, card);
  }

  // Rate cards ---------------------------------------------------------------------------------------------

  async rateCards() {
    return this.db.tenant(async (tx) => {
      const cards = await tx.collection('bid_rate_cards').find({ archived_at: null });
      cards.sort((a, b) => Number(!!a.client_id) - Number(!!b.client_id) || String(a.client_id ?? '').localeCompare(String(b.client_id ?? '')) || lower(a.name).localeCompare(lower(b.name)));
      return this.rateCardViews(tx, cards);
    });
  }

  async saveRateCard(id: string | null, input: RateCardInput) {
    return this.db.tenant(async (tx) => {
      if (input.clientId && !(await tx.collection('clients').exists({ id: input.clientId, archived_at: null }))) throw Errors.badRequest('invalid_client', 'Choose an active client');
      const fields = {
        name: input.name, client_id: input.clientId ?? null, currency: input.currency, notes: input.notes ?? null,
        lines: input.lines.map((l) => ({ roleTitle: l.roleTitle.replace(/\s+/g, ' '), payMonthly: l.payMonthly, billMonthly: l.billMonthly })),
      };
      const cards = tx.collection('bid_rate_cards');
      const unique = uniqueAs('rate_card_exists', 'A rate card with that name already exists');
      let cardId: string | null = null;
      if (id) {
        if (await cards.updateOne({ id, archived_at: null }, { $set: fields }).catch(unique)) cardId = id;
      } else {
        cardId = (await cards.insert({ ...fields, created_by_membership_id: requestContext.tenantActor().membershipId }).catch(unique)).id;
      }
      if (!cardId) throw Errors.notFound('Rate card');
      await this.audit.record(tx, { action: id ? 'bid_rate_card.updated' : 'bid_rate_card.created', resourceType: 'bid_rate_card', resourceId: cardId, changes: { name: input.name, roles: input.lines.length } });
      return (await this.rateCardViews(tx, [(await cards.findOne({ id: cardId }))!]))[0]!;
    });
  }

  async archiveRateCard(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('bid_rate_cards').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date() } });
      if (!r) throw Errors.notFound('Rate card');
      await this.audit.record(tx, { action: 'bid_rate_card.archived', resourceType: 'bid_rate_card', resourceId: id });
    });
  }

  // Clients -----------------------------------------------------------------------------------------------

  async clients(includeArchived = false) {
    return this.db.tenant(async (tx) => {
      const rows = (await tx.collection('clients').find(includeArchived ? {} : { archived_at: null })).sort((a, b) => lower(a.name).localeCompare(lower(b.name))).slice(0, 1000);
      const ids = rows.map((c) => c.id as string);
      const bids = await countBy(tx, 'staffing_bids', 'client_id', ids);
      const won = await countBy(tx, 'staffing_bids', 'client_id', ids, { status: 'won' });
      return rows.map((c) => ({ ...clientView(c), bidCount: bids.get(c.id) ?? 0, wonCount: won.get(c.id) ?? 0 }));
    });
  }

  private clientFields(input: ClientInput) {
    return {
      name: input.name, legal_name: input.legalName ?? null, industry: input.industry ?? null, contact_name: input.contactName ?? null, contact_email: input.contactEmail ?? null,
      contact_phone: input.contactPhone ?? null, address: input.address ?? null, currency: input.currency, notes: input.notes ?? null,
    };
  }

  async createClient(input: ClientInput) {
    return this.db.tenant(async (tx) => {
      const c = await tx.collection('clients')
        .insert({ ...this.clientFields(input), created_by_membership_id: requestContext.tenantActor().membershipId })
        .catch(uniqueAs('client_exists', 'A client with that name already exists'));
      await this.audit.record(tx, { action: 'client.created', resourceType: 'client', resourceId: c.id, changes: { name: input.name } });
      return clientView(c);
    });
  }

  async updateClient(id: string, input: ClientInput) {
    return this.db.tenant(async (tx) => {
      const n = await tx.collection('clients').updateOne({ id }, { $set: this.clientFields(input) }).catch(uniqueAs('client_exists', 'A client with that name already exists'));
      if (!n) throw Errors.notFound('Client');
      await this.audit.record(tx, { action: 'client.updated', resourceType: 'client', resourceId: id });
      return clientView((await tx.collection('clients').findOne({ id }))!);
    });
  }

  async archiveClient(id: string) {
    return this.db.tenant(async (tx) => {
      const clients = tx.collection('clients');
      const c = await clients.findOne({ id }, { projection: { archived_at: 1 } });
      if (!c) throw Errors.notFound('Client');
      if (!c.archived_at) await clients.updateOne({ id }, { $set: { archived_at: new Date() } });
      await this.audit.record(tx, { action: 'client.archived', resourceType: 'client', resourceId: id });
    });
  }

  // Templates ---------------------------------------------------------------------------------------------

  /** Every workspace starts with one standard template so a first bid needs no setup. */
  private async ensureTemplate(tx: TenantTx) {
    if (await tx.collection('bid_templates').exists({ archived_at: null })) return;
    const [coverNote, terms] = [
        'Thank you for the opportunity to support your team. This proposal sets out the people we will provide, the monthly rates and the overall contract value.',
        'Rates are per person per month and cover salary, statutory contributions and our management fee. Invoices are raised monthly and payable within 30 days. Replacements for any exit are provided within 15 working days at no extra cost. Either party may end the agreement with 30 days written notice.',
    ];
    await tx.collection('bid_templates').insert({ name: 'Standard proposal', cover_note: coverNote, terms, is_default: true });
  }

  async templates() {
    return this.db.tenant(async (tx) => {
      await this.ensureTemplate(tx);
      const rows = await tx.collection('bid_templates').find({ archived_at: null });
      rows.sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default) || lower(a.name).localeCompare(lower(b.name)));
      return rows.map(templateView);
    });
  }

  async saveTemplate(id: string | null, input: BidTemplateInput) {
    return this.db.tenant(async (tx) => {
      const templates = tx.collection('bid_templates');
      if (input.isDefault) await templates.update({ is_default: true, ...(id ? { id: { $ne: id } } : {}) }, { $set: { is_default: false } });
      const fields = {
        name: input.name, cover_note: input.coverNote, terms: input.terms, validity_days: input.validityDays, on_cost_pct: input.onCostPct, overhead_pct: input.overheadPct,
        target_margin_pct: input.targetMarginPct, is_default: input.isDefault,
      };
      const unique = uniqueAs('template_exists', 'A template with that name already exists');
      let templateId: string | null = null;
      if (id) {
        if (await templates.updateOne({ id, archived_at: null }, { $set: fields }).catch(unique)) templateId = id;
      } else templateId = (await templates.insert(fields).catch(unique)).id;
      if (!templateId) throw Errors.notFound('Template');
      await this.audit.record(tx, { action: id ? 'bid_template.updated' : 'bid_template.created', resourceType: 'bid_template', resourceId: templateId });
      return templateView((await templates.findOne({ id: templateId }))!);
    });
  }

  async archiveTemplate(id: string) {
    return this.db.tenant(async (tx) => {
      const t = await tx.collection('bid_templates').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date(), is_default: false } });
      if (!t) throw Errors.notFound('Template');
      await this.audit.record(tx, { action: 'bid_template.archived', resourceType: 'bid_template', resourceId: id });
    });
  }

  // Bids --------------------------------------------------------------------------------------------------

  async list(q: { status?: string; clientId?: string; q?: string }) {
    return this.db.tenant(async (tx) => {
      const and: Doc[] = [await this.authz.filter('bids:read', BID_FIELDS, tx)];
      if (q.status) and.push({ status: q.status });
      if (q.clientId) and.push({ client_id: q.clientId });
      if (q.q) {
        const m = ilike(q.q);
        const clients = await tx.collection('clients').distinct<string>('id', { name: m });
        and.push({ $or: [{ title: m }, { code: m }, { client_id: { $in: clients } }] });
      }
      const rows = await tx.collection('staffing_bids').find({ $and: and }, { sort: { updated_at: -1 }, limit: 500 });
      const clients = await fieldById(tx, 'clients', rows.map((b) => b.client_id));
      const owners = await membershipUserNames(tx, rows.map((b) => b.owner_membership_id));
      return rows.filter((b) => owners.has(b.owner_membership_id)).map((b) => ({
        id: b.id, code: b.code, title: b.title, status: b.status, mode: b.mode, currency: b.currency, headcount: b.headcount, monthlyRevenue: b.monthly_revenue,
        contractRevenue: b.contract_revenue, marginPct: b.margin_pct, targetMarginPct: b.target_margin_pct, durationMonths: b.duration_months, startDate: b.start_date,
        version: b.version, sentAt: b.sent_at ?? null, updatedAt: b.updated_at, clientId: b.client_id, clientName: clients.get(b.client_id) ?? null, ownerName: owners.get(b.owner_membership_id) ?? null,
      }));
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const b = await this.load(tx, id);
      await this.authz.require('bids:read', attrs(b), tx);
      const lines = await this.lines(tx, id);
      const card = await this.card(tx, b.rate_card_id);
      const s = await this.authz.subject(tx);
      const x = (await tx.collection('staffing_bids').findOne({ id }))!;
      const client = await tx.collection('clients').findOne({ id: b.client_id });
      const entity = await fieldById(tx, 'legal_entities', [b.legal_entity_id]);
      const versionDocs = await tx.collection('bid_versions').find({ bid_id: id }, { sort: { created_at: -1 } });
      const emailDocs = await tx.collection('bid_emails').find({ bid_id: id }, { sort: { created_at: -1 } });
      const people = await membershipUserNames(tx, [b.owner_membership_id, ...versionDocs.map((v) => v.created_by_membership_id)]);
      const meta = {
        clientName: client?.name ?? null, clientContact: client?.contact_name ?? null, clientEmail: client?.contact_email ?? null, legalEntityName: entity.get(b.legal_entity_id) ?? null,
        ownerName: people.get(b.owner_membership_id) ?? null, submittedAt: x.submitted_at ?? null, approvedAt: x.approved_at ?? null, sentAt: x.sent_at ?? null,
        decidedAt: x.decided_at ?? null, outcomeReason: x.outcome_reason ?? null, createdAt: x.created_at, updatedAt: x.updated_at,
      };
      const versions = versionDocs.map((v) => ({
        id: v.id as string, version: v.version as number, event: v.event as string, createdAt: v.created_at, createdBy: people.get(v.created_by_membership_id) ?? null,
        hasPdf: !!v.pdf_storage_key, pricing: v.pricing as BidPricing,
      }));
      const emails = emailDocs.map((e) => ({
        id: e.id as string, versionId: e.version_id as string, to: e.to_email as string, cc: (e.cc ?? []) as string[], subject: e.subject as string, sendAt: e.send_at,
        cancelledAt: e.cancelled_at ?? null, createdAt: e.created_at, ids: (e.email_message_ids ?? []) as string[],
      }));
      const delivery = await this.delivery(emails.flatMap((e) => e.ids));
      const linkDocs = await tx.collection('bid_acceptance_links').find({ bid_id: id }, { sort: { created_at: 1, sent_to: 1 } });
      const links = linkDocs.map((l) => ({
        emailId: l.bid_email_id as string, to: l.sent_to as string, firstViewedAt: l.first_viewed_at ?? null, viewCount: l.view_count as number, decision: l.decision ?? null,
        decidedAt: l.decided_at ?? null, expiresAt: l.expires_at, revokedAt: l.revoked_at ?? null,
      }));
      const decided = linkDocs.find((l) => l.decision);
      const acceptance = decided
        ? {
            decision: decided.decision as 'accepted' | 'declined', sentTo: decided.sent_to as string, decidedAt: decided.decided_at, signerName: decided.signer_name, signerTitle: decided.signer_title ?? null,
            signerEmail: decided.signer_email, reason: decided.decline_reason ?? null, ip: decided.decided_ip ?? null,
            version: versionDocs.find((v) => v.id === decided.version_id)?.version as number, hasSignedPdf: !!decided.signed_pdf_storage_key,
          }
        : null;
      const approval = b.approval_request_id
        ? { id: b.approval_request_id, status: (await tx.collection('approval_requests').findOne({ id: b.approval_request_id }, { projection: { status: 1 } }))?.status as string | undefined, steps: await this.approvals.trail(tx, b.approval_request_id) }
        : null;
      const manage = can(s, 'bids:manage', attrs(b)).allowed;
      return {
        id: b.id, code: b.code, title: b.title, status: b.status, mode: b.mode, currency: b.currency, clientId: b.client_id, legalEntityId: b.legal_entity_id,
        startDate: b.start_date, durationMonths: b.duration_months, onCostPct: pctText(b.on_cost_pct), overheadPct: pctText(b.overhead_pct),
        targetMarginPct: pctText(b.target_margin_pct), templateId: b.template_id, coverNote: b.cover_note, terms: b.terms, validUntil: b.valid_until,
        version: b.version, ownerMembershipId: b.owner_membership_id, ...meta,
        lines, fees: b.fees ?? [], rateCardId: b.rate_card_id, rateCardName: card?.name ?? null, pricing: this.price(b, lines, card), versions,
        emails: emails.map(({ ids, ...e }) => {
          const mine = links.filter((x) => x.emailId === e.id).map(({ emailId: _e, revokedAt, ...l }) => ({ ...l, revoked: !!revokedAt }));
          return { ...e, delivery: ids.map((i) => delivery.get(i) ?? { status: 'unknown', sentAt: null, error: null }), links: mine };
        }),
        acceptance: acceptance ?? null,
        approval,
        can: {
          edit: manage && BID_EDITABLE.includes(b.status),
          submit: manage && ['draft', 'rejected'].includes(b.status),
          send: manage && ['approved', 'sent'].includes(b.status),
          decide: manage && b.status === 'sent',
          withdraw: manage && ['draft', 'pending_approval', 'approved', 'rejected', 'sent'].includes(b.status),
          delete: manage && b.status === 'draft' && !versions.length,
        },
      };
    });
  }

  /** Delivery state of queued proposal emails (the mail queue is outside row-level security, so filter by workspace). */
  private async delivery(ids: string[]) {
    const out = new Map<string, { status: string; sentAt: string | null; error: string | null }>();
    if (!ids.length) return out;
    const tenantId = requestContext.tenantActor().tenantId;
    const rows = await this.db.platform((tx) => tx.collection('email_messages').find({ id: { $in: ids }, tenant_id: tenantId }, { projection: { status: 1, sent_at: 1, last_error: 1 } }));
    for (const r of rows) out.set(r.id, { status: r.status, sentAt: r.sent_at ?? null, error: r.last_error ?? null });
    return out;
  }

  private async checkRefs(tx: TenantTx, input: BidInput) {
    if (!(await tx.collection('clients').exists({ id: input.clientId, archived_at: null }))) throw Errors.badRequest('invalid_client', 'Choose an active client');
    if (!(await tx.collection('legal_entities').exists({ id: input.legalEntityId }))) throw Errors.badRequest('invalid_entity', 'Choose a legal entity in this workspace');
    if (input.templateId && !(await tx.collection('bid_templates').exists({ id: input.templateId }))) throw Errors.badRequest('invalid_template', 'Choose a template in this workspace');
    if (input.rateCardId) {
      const card = await tx.collection('bid_rate_cards').findOne({ id: input.rateCardId, archived_at: null }, { projection: { currency: 1, client_id: 1 } });
      if (!card) throw Errors.badRequest('invalid_rate_card', 'Choose an active rate card');
      if (card.currency !== input.currency) throw Errors.badRequest('rate_card_currency', `This rate card is in ${card.currency}; the bid is in ${input.currency}`);
      if (card.client_id && card.client_id !== input.clientId) throw Errors.badRequest('rate_card_client', 'This rate card is for another client');
    }
    const designations = [...new Set(input.lines.map((l) => l.designationId).filter((x): x is string => !!x))];
    if (designations.length) {
      const n = await tx.collection('designations').count({ id: { $in: designations } });
      if (n !== designations.length) throw Errors.badRequest('invalid_designation', 'Choose designations from this workspace');
    }
  }

  private async writeLines(tx: TenantTx, bidId: string, input: BidInput) {
    const lines = tx.collection('bid_lines');
    await lines.delete({ bid_id: bidId });
    await lines.insertMany(input.lines.map((l, i) => ({
      bid_id: bidId, seq: i + 1, role_title: l.roleTitle, designation_id: l.designationId ?? null, headcount: l.headcount, location: l.location ?? null,
      pay_monthly: l.payMonthly, bill_monthly: l.billMonthly ?? null, notes: l.notes ?? null,
    })));
    const p = priceBid(input, await this.card(tx, input.rateCardId ?? null));
    await tx.collection('staffing_bids').updateOne({ id: bidId }, {
      $set: { headcount: p.headcount, monthly_revenue: p.monthlyRevenue, contract_revenue: p.contractRevenue, margin_pct: p.marginPct, fees: input.fees ?? [], rate_card_id: input.rateCardId ?? null },
    });
    return p;
  }

  private async nextCode(tx: TenantTx) {
    // Locking the workspace serialises numbering, as the advisory lock did: a second bid created at the same time waits and is retried.
    await tx.collection('tenants').lock({});
    const codes = await tx.collection('staffing_bids').distinct<string>('code', { code: { $regex: '^BID-[0-9]+$' } });
    const n = codes.reduce((m, c) => Math.max(m, Number(c.slice(4))), 0) + 1;
    return `BID-${String(n).padStart(4, '0')}`;
  }

  private bidFields(input: BidInput) {
    return {
      client_id: input.clientId, legal_entity_id: input.legalEntityId, title: input.title, mode: input.mode, currency: input.currency, start_date: input.startDate,
      duration_months: input.durationMonths, on_cost_pct: input.onCostPct, overhead_pct: input.overheadPct, target_margin_pct: input.targetMarginPct,
      template_id: input.templateId ?? null, cover_note: input.coverNote, terms: input.terms, valid_until: input.validUntil ?? null,
    };
  }

  async create(input: BidInput) {
    const me = requestContext.tenantActor().membershipId;
    const id = await this.db.tenant(async (tx) => {
      await this.authz.require('bids:manage', { membershipId: me, legalEntityId: input.legalEntityId }, tx);
      await this.checkRefs(tx, input);
      const code = await this.nextCode(tx);
      const b = await tx.collection('staffing_bids').insert({ code, ...this.bidFields(input), owner_membership_id: me });
      const p = await this.writeLines(tx, b.id, input);
      await this.audit.record(tx, { action: 'bid.created', resourceType: 'staffing_bid', resourceId: b.id, changes: { code, title: input.title, headcount: p.headcount, marginPct: p.marginPct } });
      return b.id as string;
    });
    return this.get(id);
  }

  async update(id: string, input: BidInput) {
    await this.db.tenant(async (tx) => {
      const b = await this.load(tx, id, true);
      await this.authz.require('bids:manage', attrs(b), tx);
      await this.authz.require('bids:manage', { membershipId: b.owner_membership_id, legalEntityId: input.legalEntityId }, tx);
      if (!BID_EDITABLE.includes(b.status)) throw Errors.conflict('bid_locked', b.status === 'pending_approval' ? 'This bid is waiting for approval. Withdraw it to make changes.' : `A ${b.status} bid cannot be changed`);
      await this.checkRefs(tx, input);
      // A change after the bid was submitted or sent starts a new version, which needs approval again.
      const used = await tx.collection('bid_versions').exists({ bid_id: id, version: b.version });
      const reopened = ['approved', 'sent'].includes(b.status);
      await tx.collection('staffing_bids').updateOne({ id }, {
        $set: { ...this.bidFields(input), ...(reopened ? { status: 'draft', approval_request_id: null } : {}) },
        $inc: { version: used ? 1 : 0 },
      });
      const p = await this.writeLines(tx, id, input);
      await this.audit.record(tx, { action: 'bid.updated', resourceType: 'staffing_bid', resourceId: id, changes: { headcount: p.headcount, marginPct: p.marginPct, newVersion: !!used } });
    });
    return this.get(id);
  }

  async remove(id: string) {
    await this.db.tenant(async (tx) => {
      const b = await this.load(tx, id, true);
      await this.authz.require('bids:manage', attrs(b), tx);
      if (b.status !== 'draft' || (await tx.collection('bid_versions').exists({ bid_id: id }))) {
        throw Errors.conflict('bid_has_history', 'Only a draft that was never submitted can be deleted. Withdraw it instead.');
      }
      await tx.collection('staffing_bids').deleteOne({ id });
      await this.audit.record(tx, { action: 'bid.deleted', resourceType: 'staffing_bid', resourceId: id, changes: { code: b.code } });
    });
  }

  /** The proposal as the client will see it, frozen into a version. */
  private async proposal(tx: TenantTx, b: BidRow, lines: LineRow[], issuedOn: string, validUntil: string | null): Promise<ProposalData> {
    const le = (await tx.collection('legal_entities').findOne({ id: b.legal_entity_id }, { projection: { legal_name: 1, name: 1 } }))!;
    const c = (await tx.collection('clients').findOne({ id: b.client_id }))!;
    const owner = (await membershipUserNames(tx, [b.owner_membership_id])).get(b.owner_membership_id) ?? '';
    const m = { legalName: (le.legal_name || le.name) as string, clientName: c.name as string, clientLegal: c.legal_name ?? null, contact: c.contact_name ?? null, address: c.address ?? null, owner };
    return {
      workspace: m.legalName, code: b.code, version: b.version, title: b.title, issuedOn, validUntil,
      client: { name: m.clientName, legalName: m.clientLegal, contactName: m.contact, address: m.address },
      currency: b.currency, startDate: b.start_date, durationMonths: b.duration_months, coverNote: b.cover_note, terms: b.terms,
      preparedBy: m.owner, pricing: this.price(b, lines, await this.card(tx, b.rate_card_id)),
    };
  }

  private snapshot(b: BidRow, lines: LineRow[], proposal: ProposalData) {
    const { pricing: _p, ...rest } = proposal;
    return { ...rest, fees: b.fees ?? [], rateCardId: b.rate_card_id, onCostPct: pctText(b.on_cost_pct), overheadPct: pctText(b.overhead_pct), targetMarginPct: pctText(b.target_margin_pct), lines };
  }

  async submit(id: string) {
    return this.db.tenant(async (tx) => {
      const b = await this.load(tx, id, true);
      await this.authz.require('bids:manage', attrs(b), tx);
      if (!['draft', 'rejected'].includes(b.status)) throw Errors.conflict('invalid_state', `A ${b.status.replace('_', ' ')} bid cannot be submitted`);
      const lines = await this.lines(tx, id);
      const today = new Date().toISOString().slice(0, 10);
      const proposal = await this.proposal(tx, b, lines, today, b.valid_until);
      const p = proposal.pricing;
      // A resubmission after rejection without changes is the same version; any edit has already moved the version on.
      await tx.collection('bid_versions').insert({ bid_id: id, version: b.version, event: 'submitted', snapshot: this.snapshot(b, lines, proposal), pricing: p, created_by_membership_id: requestContext.tenantActor().membershipId });
      const flag = (p.lossMaking ? ' LOSS-MAKING' : p.belowTarget ? ' below target' : '') + (p.belowRateCard ? `; ${p.belowRateCard} role(s) below the rate card` : '');
      const fees = p.fees.length ? ` plus ${b.currency} ${formatAmount(p.feesTotal, b.currency)} in one-off fees` : '';
      const summary = `${b.code} ${proposal.client.name}: ${b.title}. ${p.headcount} people, ${b.currency} ${formatAmount(p.monthlyRevenue, b.currency)} a month for ${b.duration_months} months${fees}, margin ${p.marginPct}% (target ${pctText(b.target_margin_pct)}%)${flag}`;
      const approvalId = await this.approvals.start(tx, { resourceType: 'staffing_bid', resourceId: id, subjectEmployeeId: null, summary });
      await tx.collection('staffing_bids').updateOne({ id }, { $set: { status: 'pending_approval', submitted_at: new Date(), approval_request_id: approvalId } });
      await this.audit.record(tx, { action: 'bid.submitted', resourceType: 'staffing_bid', resourceId: id, changes: { version: b.version, marginPct: p.marginPct, belowTarget: p.belowTarget, belowRateCard: p.belowRateCard } });
      return { id, status: 'pending_approval' as const, approvalId };
    });
  }

  async outcome(id: string, input: { outcome: 'won' | 'lost' | 'withdrawn'; reason?: string }) {
    return this.db.tenant(async (tx) => {
      const b = await this.load(tx, id, true);
      await this.authz.require('bids:manage', attrs(b), tx);
      if (input.outcome === 'withdrawn' ? ['won', 'lost', 'withdrawn'].includes(b.status) : b.status !== 'sent') {
        throw Errors.conflict('invalid_state', input.outcome === 'withdrawn' ? `A ${b.status} bid cannot be withdrawn` : 'Only a proposal that was sent can be marked won or lost');
      }
      if (b.status === 'pending_approval' && b.approval_request_id) await this.approvals.cancel(tx, b.approval_request_id);
      if (input.outcome === 'withdrawn') await this.cancelQueued(tx, id);
      await tx.collection('staffing_bids').updateOne({ id }, { $set: { status: input.outcome, decided_at: new Date(), outcome_reason: input.reason ?? null } });
      await this.audit.record(tx, { action: `bid.${input.outcome}`, resourceType: 'staffing_bid', resourceId: id, changes: { reason: input.reason ?? null } });
      return { id, status: input.outcome };
    });
  }

  /** Stops proposal emails that have not gone yet. Returns how many were stopped. */
  private async cancelQueued(tx: TenantTx, bidId: string, emailId?: string) {
    const rows = await tx.collection('bid_emails').find({ bid_id: bidId, cancelled_at: null, ...(emailId ? { id: emailId } : {}) }, { projection: { email_message_ids: 1 } });
    let stopped = 0;
    const tenantId = requestContext.tenantActor().tenantId;
    for (const r of rows) {
      const n = await this.db.platform((ptx) =>
        ptx.collection('email_messages').update({ id: { $in: r.email_message_ids ?? [] }, tenant_id: tenantId, status: 'queued', attempts: 0 }, { $set: { status: 'cancelled' } }),
      );
      if (n > 0) {
        await tx.collection('bid_emails').updateOne({ id: r.id }, { $set: { cancelled_at: new Date() } });
        await tx.collection('bid_acceptance_links').update({ bid_email_id: r.id, decision: null }, { $set: { revoked_at: new Date() } });
        stopped++;
      }
    }
    return stopped;
  }

  async cancelEmail(bidId: string, emailId: string) {
    return this.db.tenant(async (tx) => {
      const b = await this.load(tx, bidId, true);
      await this.authz.require('bids:manage', attrs(b), tx);
      if (!(await tx.collection('bid_emails').exists({ id: emailId, bid_id: bidId }))) throw Errors.notFound('Scheduled email');
      if (!(await this.cancelQueued(tx, bidId, emailId))) throw Errors.conflict('already_sent', 'This email has already been sent or cancelled');
      // With nothing left going out, the proposal has not been sent after all.
      const live = await tx.collection('bid_emails').exists({ bid_id: bidId, cancelled_at: null });
      if (!live && b.status === 'sent') await tx.collection('staffing_bids').updateOne({ id: bidId }, { $set: { status: 'approved', sent_at: null } });
      await this.audit.record(tx, { action: 'bid.email_cancelled', resourceType: 'staffing_bid', resourceId: bidId, metadata: { emailId } });
      return { id: emailId, cancelled: true };
    });
  }

  async send(id: string, input: BidSendInput) {
    const actor = requestContext.tenantActor();
    const sendAt = input.sendAt ? new Date(input.sendAt) : new Date();
    if (sendAt.getTime() < Date.now() - 5 * 60_000) throw Errors.badRequest('send_at_past', 'Choose a time in the future');
    if (sendAt.getTime() > Date.now() + MAX_SCHEDULE_DAYS * 86_400_000) throw Errors.badRequest('send_at_too_far', `Schedule up to ${MAX_SCHEDULE_DAYS} days ahead`);
    return this.db.tenant(async (tx) => {
      const b = await this.load(tx, id, true);
      await this.authz.require('bids:manage', attrs(b), tx);
      if (!['approved', 'sent'].includes(b.status)) throw Errors.conflict('not_approved', 'A bid must be approved before the proposal is sent');
      const lines = await this.lines(tx, id);
      // The PDF for this version is made once, when it is first sent, and reused for every later email.
      const versions = tx.collection('bid_versions');
      const found = await versions.findOne({ bid_id: id, version: b.version, event: 'sent' }, { projection: { pdf_storage_key: 1 } });
      let version = found ? { id: found.id as string, pdf_storage_key: found.pdf_storage_key as string } : undefined;
      // If every email for that PDF was cancelled before it went, nobody has seen it: make it again so the issue
      // date is the day this email goes, not the day of the cancelled schedule.
      const unseen = version && !(await tx.collection('bid_emails').exists({ version_id: version.id, cancelled_at: null }));
      if (!version || unseen) {
        const issued = sendAt.toISOString().slice(0, 10);
        let validUntil = b.valid_until;
        if (!validUntil) {
          const days = ((b.template_id ? (await tx.collection('bid_templates').findOne({ id: b.template_id }, { projection: { validity_days: 1 } }))?.validity_days : undefined) as number | undefined) ?? 30;
          validUntil = new Date(sendAt.getTime() + days * 86_400_000).toISOString().slice(0, 10);
          await tx.collection('staffing_bids').updateOne({ id }, { $set: { valid_until: validUntil } });
        }
        const proposal = await this.proposal(tx, b, lines, issued, validUntil);
        const pdf = await renderProposal(proposal);
        const key = this.storage.newKey(actor.tenantId);
        await this.storage.put(key, pdf);
        const snap = this.snapshot({ ...b, valid_until: validUntil }, lines, proposal);
        if (unseen) {
          await versions.updateOne({ id: version!.id }, { $set: { snapshot: snap, pricing: proposal.pricing, pdf_storage_key: key, created_at: new Date(), created_by_membership_id: actor.membershipId } });
          version = { id: version!.id, pdf_storage_key: key };
        } else {
          const v = await versions.insert({ bid_id: id, version: b.version, event: 'sent', snapshot: snap, pricing: proposal.pricing, pdf_storage_key: key, created_by_membership_id: actor.membershipId });
          version = { id: v.id as string, pdf_storage_key: key };
        }
      }
      const attachment: EmailAttachment = { filename: `${b.code}-v${b.version}.pdf`, contentType: 'application/pdf', storageKey: version.pdf_storage_key };
      const p = this.price(b, lines, await this.card(tx, b.rate_card_id));
      const summary = `${input.message}\n\n${b.code}: ${b.title}\n${p.headcount} people for ${b.duration_months} months from ${b.start_date}\nMonthly total: ${b.currency} ${formatAmount(p.monthlyRevenue, b.currency)}\n${p.fees.length ? `One-off fees: ${b.currency} ${formatAmount(p.feesTotal, b.currency)}\n` : ''}Contract value: ${b.currency} ${formatAmount(p.contractRevenue, b.currency)}\n\nThe full proposal is attached as a PDF.`;
      // Each recipient gets a private link to review and accept or decline online, live from when the email goes
      // until the proposal's validity ends (at least a week). Only its hash is stored.
      const until = (await tx.collection('staffing_bids').findOne({ id }, { projection: { valid_until: 1 } }))!.valid_until as string;
      const expiresAt = new Date(Math.max(Date.parse(`${until}T23:59:59Z`), sendAt.getTime() + 7 * 86_400_000));
      const web = this.config.WEB_PUBLIC_URL.replace(/\/$/, '');
      const links: { to: string; hash: string }[] = [];
      const ids: string[] = [];
      for (const to of [input.to, ...input.cc]) {
        const mid = randomUUID();
        const token = randomBytes(24).toString('base64url');
        links.push({ to, hash: createHash('sha256').update(token).digest('hex') });
        const body = `${summary}\n\nReview it and accept or decline online: ${web}/proposal/${token}\nThis link is for ${to} and works until ${expiresAt.toISOString().slice(0, 10)}.`;
        await tx.collection('email_messages').insert({ id: mid, to_email: to, subject: input.subject, text_body: body, template: 'bid.proposal', attachments: [attachment], next_attempt_at: sendAt });
        ids.push(mid);
      }
      const e = await tx.collection('bid_emails').insert({
        bid_id: id, version_id: version.id, to_email: input.to, cc: input.cc, subject: input.subject, message: input.message, send_at: sendAt, email_message_ids: ids,
        created_by_membership_id: actor.membershipId,
      });
      await tx.collection('bid_acceptance_links').insertMany(links.map((l) => ({
        bid_id: id, version_id: version!.id, bid_email_id: e.id, sent_to: l.to, token_hash: l.hash, active_from: sendAt, expires_at: expiresAt,
      })));
      const sentAt = (await tx.collection('staffing_bids').findOne({ id }, { projection: { sent_at: 1 } }))?.sent_at ?? new Date();
      await tx.collection('staffing_bids').updateOne({ id }, { $set: { status: 'sent', sent_at: sentAt } });
      await this.audit.record(tx, { action: 'bid.proposal_scheduled', resourceType: 'staffing_bid', resourceId: id, changes: { to: input.to, cc: input.cc, sendAt: sendAt.toISOString(), version: b.version } });
      return { id: e.id, sendAt: sendAt.toISOString(), recipients: ids.length };
    });
  }

  /** The proposal PDF: a version as it was sent (or submitted), or a preview of the bid as it stands now. */
  async pdf(id: string, versionId?: string): Promise<{ fileName: string; content: Buffer }> {
    return this.db.tenant(async (tx) => {
      const b = await this.load(tx, id);
      await this.authz.require('bids:read', attrs(b), tx);
      if (versionId) {
        const v = await tx.collection('bid_versions').findOne({ id: versionId, bid_id: id });
        if (!v) throw Errors.notFound('Version');
        const content = v.pdf_storage_key ? await this.read(v.pdf_storage_key) : await renderProposal({ ...v.snapshot, pricing: v.pricing });
        return { fileName: `${b.code}-v${v.version}.pdf`, content };
      }
      const today = new Date().toISOString().slice(0, 10);
      const content = await renderProposal(await this.proposal(tx, b, await this.lines(tx, id), today, b.valid_until));
      return { fileName: `${b.code}-v${b.version}-preview.pdf`, content };
    });
  }

  /** The signed copy of an accepted proposal: the PDF as sent plus the acceptance record. */
  async signedPdf(id: string): Promise<{ fileName: string; content: Buffer }> {
    return this.db.tenant(async (tx) => {
      const b = await this.load(tx, id);
      await this.authz.require('bids:read', attrs(b), tx);
      const link = await tx.collection('bid_acceptance_links').findOne({ bid_id: id, decision: 'accepted', signed_pdf_storage_key: { $ne: null } });
      const v = link ? await tx.collection('bid_versions').findOne({ id: link.version_id }, { projection: { version: 1 } }) : undefined;
      if (!link || !v) throw Errors.notFound('Signed proposal');
      const l = { key: link.signed_pdf_storage_key as string, version: v.version as number };
      return { fileName: `${b.code}-v${l.version}-signed.pdf`, content: await this.read(l.key) };
    });
  }

  private async read(key: string) {
    const { stream } = await this.storage.open(key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }
}
