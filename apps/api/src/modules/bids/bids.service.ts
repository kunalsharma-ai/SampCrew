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
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import type { EmailAttachment } from '../../platform/notify/mailer.service';
import { NotificationService } from '../../platform/notify/notification.service';
import { StorageService } from '../../platform/storage/storage.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { uniqueAs } from '../employees/employees.service';
import { type ProposalData, renderProposal } from './proposal-pdf';

/** Row scope: "own" means bids the member owns; "entity" means bids raised under their legal entity. */
const BID_SCOPE = { membershipId: 'b.owner_membership_id', legalEntityId: 'b.legal_entity_id', departmentId: 'null::uuid', locationId: 'null::uuid' };
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

const BID_COLS = `id, code, client_id, legal_entity_id, title, mode, status, currency, to_char(start_date, 'YYYY-MM-DD') as start_date, duration_months,
  on_cost_pct::text, overhead_pct::text, target_margin_pct::text, template_id, cover_note, terms, to_char(valid_until, 'YYYY-MM-DD') as valid_until,
  version, approval_request_id, owner_membership_id, rate_card_id, fees`;

const CLIENT_COLS = `c.id, c.name, c.legal_name as "legalName", c.industry, c.contact_name as "contactName", c.contact_email as "contactEmail",
  c.contact_phone as "contactPhone", c.address, c.currency, c.notes, c.archived_at as "archivedAt", c.created_at as "createdAt"`;

const TEMPLATE_COLS = `id, name, cover_note as "coverNote", terms, validity_days as "validityDays", on_cost_pct::text as "onCostPct",
  overhead_pct::text as "overheadPct", target_margin_pct::text as "targetMarginPct", is_default as "isDefault", updated_at as "updatedAt"`;

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
        const b = await one<{ code: string; title: string; owner_membership_id: string }>(
          tx,
          `update staffing_bids set status = 'approved', approved_at = now() where id = $1 and status = 'pending_approval' returning code, title, owner_membership_id`,
          [req.resource_id],
        );
        if (!b) return;
        await this.audit.record(tx, { action: 'bid.approved', resourceType: 'staffing_bid', resourceId: req.resource_id });
      },
      onRejected: async (tx, req) => {
        await tx.query(`update staffing_bids set status = 'rejected' where id = $1 and status = 'pending_approval'`, [req.resource_id]);
        await this.audit.record(tx, { action: 'bid.rejected', resourceType: 'staffing_bid', resourceId: req.resource_id });
      },
    });
  }

  private async load(tx: Tx, id: string, lock = false): Promise<BidRow> {
    const b = await one<BidRow>(tx, `select ${BID_COLS} from staffing_bids where id = $1${lock ? ' for update' : ''}`, [id]);
    if (!b) throw Errors.notFound('Bid');
    return b;
  }

  private async lines(tx: Tx, bidId: string): Promise<LineRow[]> {
    return many<LineRow>(
      tx,
      `select role_title as "roleTitle", designation_id as "designationId", headcount, location, pay_monthly::text as "payMonthly",
              bill_monthly::text as "billMonthly", notes from bid_lines where bid_id = $1 order by seq`,
      [bidId],
    );
  }

  private async card(tx: Tx, id: string | null) {
    return id ? one<{ id: string; name: string; currency: string; lines: RateCardInput['lines'] }>(tx, `select id, name, currency, lines from bid_rate_cards where id = $1`, [id]) : null;
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
    return this.db.tenant(async (tx) => many<RateCard>(
      tx,
      `select r.id, r.name, r.client_id as "clientId", c.name as "clientName", r.currency, r.notes, r.lines, r.updated_at as "updatedAt"
         from bid_rate_cards r left join clients c on c.id = r.client_id where r.archived_at is null order by r.client_id nulls first, lower(r.name)`,
    ));
  }

  async saveRateCard(id: string | null, input: RateCardInput) {
    return this.db.tenant(async (tx) => {
      if (input.clientId && !(await one(tx, 'select 1 from clients where id = $1 and archived_at is null', [input.clientId]))) throw Errors.badRequest('invalid_client', 'Choose an active client');
      const lines = JSON.stringify(input.lines.map((l) => ({ roleTitle: l.roleTitle.replace(/\s+/g, ' '), payMonthly: l.payMonthly, billMonthly: l.billMonthly })));
      const params = [input.name, input.clientId, input.currency, input.notes, lines];
      const r = id
        ? await one<{ id: string }>(
          tx, `update bid_rate_cards set name = $2, client_id = $3, currency = $4, notes = $5, lines = $6 where id = $1 and archived_at is null returning id`, [id, ...params],
        ).catch(uniqueAs('rate_card_exists', 'A rate card with that name already exists'))
        : await one<{ id: string }>(
          tx, `insert into bid_rate_cards (tenant_id, name, client_id, currency, notes, lines, created_by_membership_id) values (app_tenant_id(), $1, $2, $3, $4, $5, $6) returning id`,
          [...params, requestContext.tenantActor().membershipId],
        ).catch(uniqueAs('rate_card_exists', 'A rate card with that name already exists'));
      if (!r) throw Errors.notFound('Rate card');
      await this.audit.record(tx, { action: id ? 'bid_rate_card.updated' : 'bid_rate_card.created', resourceType: 'bid_rate_card', resourceId: r.id, changes: { name: input.name, roles: input.lines.length } });
      return one<RateCard>(
        tx, `select r.id, r.name, r.client_id as "clientId", c.name as "clientName", r.currency, r.notes, r.lines, r.updated_at as "updatedAt" from bid_rate_cards r left join clients c on c.id = r.client_id where r.id = $1`, [r.id],
      );
    });
  }

  async archiveRateCard(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await one(tx, `update bid_rate_cards set archived_at = now() where id = $1 and archived_at is null returning id`, [id]);
      if (!r) throw Errors.notFound('Rate card');
      await this.audit.record(tx, { action: 'bid_rate_card.archived', resourceType: 'bid_rate_card', resourceId: id });
    });
  }

  // Clients -----------------------------------------------------------------------------------------------

  async clients(includeArchived = false) {
    return this.db.tenant((tx) =>
      many(
        tx,
        `select ${CLIENT_COLS},
                (select count(*)::int from staffing_bids b where b.client_id = c.id) as "bidCount",
                (select count(*)::int from staffing_bids b where b.client_id = c.id and b.status = 'won') as "wonCount"
           from clients c ${includeArchived ? '' : 'where c.archived_at is null'} order by lower(c.name) limit 1000`,
      ),
    );
  }

  async createClient(input: ClientInput) {
    return this.db.tenant(async (tx) => {
      const c = await one<{ id: string }>(
        tx,
        `insert into clients (tenant_id, name, legal_name, industry, contact_name, contact_email, contact_phone, address, currency, notes, created_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [input.name, input.legalName ?? null, input.industry ?? null, input.contactName ?? null, input.contactEmail ?? null, input.contactPhone ?? null,
          input.address ?? null, input.currency, input.notes ?? null, requestContext.tenantActor().membershipId],
      ).catch(uniqueAs('client_exists', 'A client with that name already exists'));
      await this.audit.record(tx, { action: 'client.created', resourceType: 'client', resourceId: c!.id, changes: { name: input.name } });
      return one(tx, `select ${CLIENT_COLS} from clients c where c.id = $1`, [c!.id]);
    });
  }

  async updateClient(id: string, input: ClientInput) {
    return this.db.tenant(async (tx) => {
      const c = await one<{ id: string }>(
        tx,
        `update clients set name = $2, legal_name = $3, industry = $4, contact_name = $5, contact_email = $6, contact_phone = $7, address = $8, currency = $9, notes = $10
          where id = $1 returning id`,
        [id, input.name, input.legalName ?? null, input.industry ?? null, input.contactName ?? null, input.contactEmail ?? null, input.contactPhone ?? null,
          input.address ?? null, input.currency, input.notes ?? null],
      ).catch(uniqueAs('client_exists', 'A client with that name already exists'));
      if (!c) throw Errors.notFound('Client');
      await this.audit.record(tx, { action: 'client.updated', resourceType: 'client', resourceId: id });
      return one(tx, `select ${CLIENT_COLS} from clients c where c.id = $1`, [id]);
    });
  }

  async archiveClient(id: string) {
    return this.db.tenant(async (tx) => {
      const c = await one(tx, `update clients set archived_at = coalesce(archived_at, now()) where id = $1 returning id`, [id]);
      if (!c) throw Errors.notFound('Client');
      await this.audit.record(tx, { action: 'client.archived', resourceType: 'client', resourceId: id });
    });
  }

  // Templates ---------------------------------------------------------------------------------------------

  /** Every workspace starts with one standard template so a first bid needs no setup. */
  private async ensureTemplate(tx: Tx) {
    if (await one(tx, 'select 1 from bid_templates where archived_at is null limit 1')) return;
    await tx.query(
      `insert into bid_templates (tenant_id, name, cover_note, terms, is_default) values (app_tenant_id(), 'Standard proposal', $1, $2, true)`,
      [
        'Thank you for the opportunity to support your team. This proposal sets out the people we will provide, the monthly rates and the overall contract value.',
        'Rates are per person per month and cover salary, statutory contributions and our management fee. Invoices are raised monthly and payable within 30 days. Replacements for any exit are provided within 15 working days at no extra cost. Either party may end the agreement with 30 days written notice.',
      ],
    );
  }

  async templates() {
    return this.db.tenant(async (tx) => {
      await this.ensureTemplate(tx);
      return many(tx, `select ${TEMPLATE_COLS} from bid_templates where archived_at is null order by is_default desc, lower(name)`);
    });
  }

  async saveTemplate(id: string | null, input: BidTemplateInput) {
    return this.db.tenant(async (tx) => {
      if (input.isDefault) await tx.query(`update bid_templates set is_default = false where is_default and id is distinct from $1`, [id]);
      const params = [input.name, input.coverNote, input.terms, input.validityDays, input.onCostPct, input.overheadPct, input.targetMarginPct, input.isDefault];
      const t = id
        ? await one<{ id: string }>(
          tx,
          `update bid_templates set name = $2, cover_note = $3, terms = $4, validity_days = $5, on_cost_pct = $6, overhead_pct = $7, target_margin_pct = $8, is_default = $9
            where id = $1 and archived_at is null returning id`,
          [id, ...params],
        ).catch(uniqueAs('template_exists', 'A template with that name already exists'))
        : await one<{ id: string }>(
          tx,
          `insert into bid_templates (tenant_id, name, cover_note, terms, validity_days, on_cost_pct, overhead_pct, target_margin_pct, is_default)
           values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          params,
        ).catch(uniqueAs('template_exists', 'A template with that name already exists'));
      if (!t) throw Errors.notFound('Template');
      await this.audit.record(tx, { action: id ? 'bid_template.updated' : 'bid_template.created', resourceType: 'bid_template', resourceId: t.id });
      return one(tx, `select ${TEMPLATE_COLS} from bid_templates where id = $1`, [t.id]);
    });
  }

  async archiveTemplate(id: string) {
    return this.db.tenant(async (tx) => {
      const t = await one(tx, `update bid_templates set archived_at = now(), is_default = false where id = $1 and archived_at is null returning id`, [id]);
      if (!t) throw Errors.notFound('Template');
      await this.audit.record(tx, { action: 'bid_template.archived', resourceType: 'bid_template', resourceId: id });
    });
  }

  // Bids --------------------------------------------------------------------------------------------------

  async list(q: { status?: string; clientId?: string; q?: string }) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [];
      const where = [await this.authz.predicate('bids:read', BID_SCOPE, params, tx)];
      if (q.status) { params.push(q.status); where.push(`b.status = $${params.length}`); }
      if (q.clientId) { params.push(q.clientId); where.push(`b.client_id = $${params.length}`); }
      if (q.q) { params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(b.title ilike $${params.length} or b.code ilike $${params.length} or c.name ilike $${params.length})`); }
      return many(
        tx,
        `select b.id, b.code, b.title, b.status, b.mode, b.currency, b.headcount, b.monthly_revenue::text as "monthlyRevenue",
                b.contract_revenue::text as "contractRevenue", b.margin_pct::text as "marginPct", b.target_margin_pct::text as "targetMarginPct",
                b.duration_months as "durationMonths", to_char(b.start_date, 'YYYY-MM-DD') as "startDate", b.version, b.sent_at as "sentAt",
                b.updated_at as "updatedAt", c.id as "clientId", c.name as "clientName", u.full_name as "ownerName"
           from staffing_bids b join clients c on c.id = b.client_id
           join memberships m on m.id = b.owner_membership_id join users u on u.id = m.user_id
          where ${where.join(' and ')} order by b.updated_at desc limit 500`,
        params,
      );
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const b = await this.load(tx, id);
      await this.authz.require('bids:read', attrs(b), tx);
      const lines = await this.lines(tx, id);
      const card = await this.card(tx, b.rate_card_id);
      const s = await this.authz.subject(tx);
      const meta = await one<Record<string, unknown>>(
        tx,
        `select c.name as "clientName", c.contact_name as "clientContact", c.contact_email as "clientEmail", le.name as "legalEntityName",
                u.full_name as "ownerName", b.submitted_at as "submittedAt", b.approved_at as "approvedAt", b.sent_at as "sentAt",
                b.decided_at as "decidedAt", b.outcome_reason as "outcomeReason", b.created_at as "createdAt", b.updated_at as "updatedAt"
           from staffing_bids b join clients c on c.id = b.client_id join legal_entities le on le.id = b.legal_entity_id
           join memberships m on m.id = b.owner_membership_id join users u on u.id = m.user_id where b.id = $1`,
        [id],
      );
      const versions = await many<{ id: string; version: number; event: string; createdAt: string; createdBy: string | null; hasPdf: boolean; pricing: BidPricing }>(
        tx,
        `select v.id, v.version, v.event, v.created_at as "createdAt", u.full_name as "createdBy", v.pdf_storage_key is not null as "hasPdf", v.pricing
           from bid_versions v left join memberships m on m.id = v.created_by_membership_id left join users u on u.id = m.user_id
          where v.bid_id = $1 order by v.created_at desc`,
        [id],
      );
      const emails = await many<{ id: string; versionId: string; to: string; cc: string[]; subject: string; sendAt: string; cancelledAt: string | null; createdAt: string; ids: string[] }>(
        tx,
        `select id, version_id as "versionId", to_email::text as "to", cc, subject, send_at as "sendAt", cancelled_at as "cancelledAt", created_at as "createdAt",
                email_message_ids as "ids" from bid_emails where bid_id = $1 order by created_at desc`,
        [id],
      );
      const delivery = await this.delivery(emails.flatMap((e) => e.ids));
      const links = await many<{ emailId: string; to: string; firstViewedAt: string | null; viewCount: number; decision: string | null; decidedAt: string | null; expiresAt: string; revokedAt: string | null }>(
        tx,
        `select bid_email_id as "emailId", sent_to::text as "to", first_viewed_at as "firstViewedAt", view_count as "viewCount", decision, decided_at as "decidedAt", expires_at as "expiresAt", revoked_at as "revokedAt"
           from bid_acceptance_links where bid_id = $1 order by created_at, sent_to`,
        [id],
      );
      const acceptance = await one<{ decision: 'accepted' | 'declined'; sentTo: string; decidedAt: string; signerName: string; signerTitle: string | null; signerEmail: string; reason: string | null; ip: string | null; version: number; hasSignedPdf: boolean }>(
        tx,
        `select l.decision, l.sent_to::text as "sentTo", l.decided_at as "decidedAt", l.signer_name as "signerName", l.signer_title as "signerTitle", l.signer_email as "signerEmail",
                l.decline_reason as reason, l.decided_ip as ip, v.version, l.signed_pdf_storage_key is not null as "hasSignedPdf"
           from bid_acceptance_links l join bid_versions v on v.id = l.version_id where l.bid_id = $1 and l.decision is not null`,
        [id],
      );
      const approval = b.approval_request_id
        ? { id: b.approval_request_id, status: (await one<{ status: string }>(tx, 'select status from approval_requests where id = $1', [b.approval_request_id]))?.status, steps: await this.approvals.trail(tx, b.approval_request_id) }
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
    const rows = await this.db.platform((tx) =>
      many<{ id: string; status: string; sentAt: string | null; error: string | null }>(
        tx,
        `select id, status, sent_at as "sentAt", last_error as "error" from email_messages where id = any($1::uuid[]) and tenant_id = $2`,
        [ids, tenantId],
      ),
    );
    for (const r of rows) out.set(r.id, { status: r.status, sentAt: r.sentAt, error: r.error });
    return out;
  }

  private async checkRefs(tx: Tx, input: BidInput) {
    if (!(await one(tx, 'select 1 from clients where id = $1 and archived_at is null', [input.clientId]))) throw Errors.badRequest('invalid_client', 'Choose an active client');
    if (!(await one(tx, 'select 1 from legal_entities where id = $1', [input.legalEntityId]))) throw Errors.badRequest('invalid_entity', 'Choose a legal entity in this workspace');
    if (input.templateId && !(await one(tx, 'select 1 from bid_templates where id = $1', [input.templateId]))) throw Errors.badRequest('invalid_template', 'Choose a template in this workspace');
    if (input.rateCardId) {
      const card = await one<{ currency: string; clientId: string | null }>(tx, 'select currency, client_id as "clientId" from bid_rate_cards where id = $1 and archived_at is null', [input.rateCardId]);
      if (!card) throw Errors.badRequest('invalid_rate_card', 'Choose an active rate card');
      if (card.currency !== input.currency) throw Errors.badRequest('rate_card_currency', `This rate card is in ${card.currency}; the bid is in ${input.currency}`);
      if (card.clientId && card.clientId !== input.clientId) throw Errors.badRequest('rate_card_client', 'This rate card is for another client');
    }
    const designations = input.lines.map((l) => l.designationId).filter((x): x is string => !!x);
    if (designations.length) {
      const n = (await one<{ n: number }>(tx, 'select count(*)::int as n from designations where id = any($1::uuid[])', [designations]))!.n;
      if (n !== new Set(designations).size) throw Errors.badRequest('invalid_designation', 'Choose designations from this workspace');
    }
  }

  private async writeLines(tx: Tx, bidId: string, input: BidInput) {
    await tx.query('delete from bid_lines where bid_id = $1', [bidId]);
    for (const [i, l] of input.lines.entries()) {
      await tx.query(
        `insert into bid_lines (tenant_id, bid_id, seq, role_title, designation_id, headcount, location, pay_monthly, bill_monthly, notes)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [bidId, i + 1, l.roleTitle, l.designationId ?? null, l.headcount, l.location ?? null, l.payMonthly, l.billMonthly ?? null, l.notes ?? null],
      );
    }
    const p = priceBid(input, await this.card(tx, input.rateCardId ?? null));
    await tx.query(
      `update staffing_bids set headcount = $2, monthly_revenue = $3, contract_revenue = $4, margin_pct = $5, fees = $6, rate_card_id = $7 where id = $1`,
      [bidId, p.headcount, p.monthlyRevenue, p.contractRevenue, p.marginPct, JSON.stringify(input.fees ?? []), input.rateCardId ?? null],
    );
    return p;
  }

  private async nextCode(tx: Tx) {
    await tx.query(`select pg_advisory_xact_lock(hashtext('staffing_bids:' || app_tenant_id()::text))`);
    const n = (await one<{ n: number }>(tx, `select coalesce(max(substring(code from 5)::int), 0) + 1 as n from staffing_bids where code ~ '^BID-[0-9]+$'`))!.n;
    return `BID-${String(n).padStart(4, '0')}`;
  }

  async create(input: BidInput) {
    const me = requestContext.tenantActor().membershipId;
    const id = await this.db.tenant(async (tx) => {
      await this.authz.require('bids:manage', { membershipId: me, legalEntityId: input.legalEntityId }, tx);
      await this.checkRefs(tx, input);
      const code = await this.nextCode(tx);
      const b = (await one<{ id: string }>(
        tx,
        `insert into staffing_bids (tenant_id, code, client_id, legal_entity_id, title, mode, currency, start_date, duration_months, on_cost_pct, overhead_pct,
                                    target_margin_pct, template_id, cover_note, terms, valid_until, owner_membership_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning id`,
        [code, input.clientId, input.legalEntityId, input.title, input.mode, input.currency, input.startDate, input.durationMonths, input.onCostPct, input.overheadPct,
          input.targetMarginPct, input.templateId ?? null, input.coverNote, input.terms, input.validUntil ?? null, me],
      ))!;
      const p = await this.writeLines(tx, b.id, input);
      await this.audit.record(tx, { action: 'bid.created', resourceType: 'staffing_bid', resourceId: b.id, changes: { code, title: input.title, headcount: p.headcount, marginPct: p.marginPct } });
      return b.id;
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
      const used = await one(tx, 'select 1 from bid_versions where bid_id = $1 and version = $2', [id, b.version]);
      await tx.query(
        `update staffing_bids set client_id = $2, legal_entity_id = $3, title = $4, mode = $5, currency = $6, start_date = $7, duration_months = $8, on_cost_pct = $9,
                overhead_pct = $10, target_margin_pct = $11, template_id = $12, cover_note = $13, terms = $14, valid_until = $15,
                version = version + $16, status = case when status in ('approved', 'sent') then 'draft' else status end,
                approval_request_id = case when status in ('approved', 'sent') then null else approval_request_id end
          where id = $1`,
        [id, input.clientId, input.legalEntityId, input.title, input.mode, input.currency, input.startDate, input.durationMonths, input.onCostPct, input.overheadPct,
          input.targetMarginPct, input.templateId ?? null, input.coverNote, input.terms, input.validUntil ?? null, used ? 1 : 0],
      );
      const p = await this.writeLines(tx, id, input);
      await this.audit.record(tx, { action: 'bid.updated', resourceType: 'staffing_bid', resourceId: id, changes: { headcount: p.headcount, marginPct: p.marginPct, newVersion: !!used } });
    });
    return this.get(id);
  }

  async remove(id: string) {
    await this.db.tenant(async (tx) => {
      const b = await this.load(tx, id, true);
      await this.authz.require('bids:manage', attrs(b), tx);
      if (b.status !== 'draft' || (await one(tx, 'select 1 from bid_versions where bid_id = $1', [id]))) {
        throw Errors.conflict('bid_has_history', 'Only a draft that was never submitted can be deleted. Withdraw it instead.');
      }
      await tx.query('delete from staffing_bids where id = $1', [id]);
      await this.audit.record(tx, { action: 'bid.deleted', resourceType: 'staffing_bid', resourceId: id, changes: { code: b.code } });
    });
  }

  /** The proposal as the client will see it, frozen into a version. */
  private async proposal(tx: Tx, b: BidRow, lines: LineRow[], issuedOn: string, validUntil: string | null): Promise<ProposalData> {
    const m = (await one<{ legalName: string; clientName: string; clientLegal: string | null; contact: string | null; address: string | null; owner: string }>(
      tx,
      `select coalesce(nullif(le.legal_name, ''), le.name) as "legalName", c.name as "clientName", c.legal_name as "clientLegal", c.contact_name as contact,
              c.address, u.full_name as owner
         from staffing_bids b join legal_entities le on le.id = b.legal_entity_id join clients c on c.id = b.client_id
         join memberships mm on mm.id = b.owner_membership_id join users u on u.id = mm.user_id where b.id = $1`,
      [b.id],
    ))!;
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
      await tx.query(
        `insert into bid_versions (tenant_id, bid_id, version, event, snapshot, pricing, created_by_membership_id) values (app_tenant_id(), $1, $2, 'submitted', $3, $4, $5)`,
        [id, b.version, JSON.stringify(this.snapshot(b, lines, proposal)), JSON.stringify(p), requestContext.tenantActor().membershipId],
      );
      const flag = (p.lossMaking ? ' LOSS-MAKING' : p.belowTarget ? ' below target' : '') + (p.belowRateCard ? `; ${p.belowRateCard} role(s) below the rate card` : '');
      const fees = p.fees.length ? ` plus ${b.currency} ${formatAmount(p.feesTotal, b.currency)} in one-off fees` : '';
      const summary = `${b.code} ${proposal.client.name}: ${b.title}. ${p.headcount} people, ${b.currency} ${formatAmount(p.monthlyRevenue, b.currency)} a month for ${b.duration_months} months${fees}, margin ${p.marginPct}% (target ${pctText(b.target_margin_pct)}%)${flag}`;
      const approvalId = await this.approvals.start(tx, { resourceType: 'staffing_bid', resourceId: id, subjectEmployeeId: null, summary });
      await tx.query(`update staffing_bids set status = 'pending_approval', submitted_at = now(), approval_request_id = $2 where id = $1`, [id, approvalId]);
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
      await tx.query(`update staffing_bids set status = $2, decided_at = now(), outcome_reason = $3 where id = $1`, [id, input.outcome, input.reason ?? null]);
      await this.audit.record(tx, { action: `bid.${input.outcome}`, resourceType: 'staffing_bid', resourceId: id, changes: { reason: input.reason ?? null } });
      return { id, status: input.outcome };
    });
  }

  /** Stops proposal emails that have not gone yet. Returns how many were stopped. */
  private async cancelQueued(tx: Tx, bidId: string, emailId?: string) {
    const rows = await many<{ id: string; email_message_ids: string[] }>(
      tx,
      `select id, email_message_ids from bid_emails where bid_id = $1 and cancelled_at is null${emailId ? ' and id = $2' : ''}`,
      emailId ? [bidId, emailId] : [bidId],
    );
    let stopped = 0;
    const tenantId = requestContext.tenantActor().tenantId;
    for (const r of rows) {
      const n = await this.db.platform(async (ptx) =>
        (await ptx.query(`update email_messages set status = 'cancelled' where id = any($1::uuid[]) and tenant_id = $2 and status = 'queued' and attempts = 0`, [r.email_message_ids, tenantId])).rowCount ?? 0,
      );
      if (n > 0) {
        await tx.query('update bid_emails set cancelled_at = now() where id = $1', [r.id]);
        await tx.query('update bid_acceptance_links set revoked_at = now() where bid_email_id = $1 and decision is null', [r.id]);
        stopped++;
      }
    }
    return stopped;
  }

  async cancelEmail(bidId: string, emailId: string) {
    return this.db.tenant(async (tx) => {
      const b = await this.load(tx, bidId, true);
      await this.authz.require('bids:manage', attrs(b), tx);
      if (!(await one(tx, 'select 1 from bid_emails where id = $1 and bid_id = $2', [emailId, bidId]))) throw Errors.notFound('Scheduled email');
      if (!(await this.cancelQueued(tx, bidId, emailId))) throw Errors.conflict('already_sent', 'This email has already been sent or cancelled');
      // With nothing left going out, the proposal has not been sent after all.
      const live = await one(tx, 'select 1 from bid_emails where bid_id = $1 and cancelled_at is null', [bidId]);
      if (!live && b.status === 'sent') await tx.query(`update staffing_bids set status = 'approved', sent_at = null where id = $1`, [bidId]);
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
      let version = await one<{ id: string; pdf_storage_key: string }>(tx, `select id, pdf_storage_key from bid_versions where bid_id = $1 and version = $2 and event = 'sent'`, [id, b.version]);
      // If every email for that PDF was cancelled before it went, nobody has seen it: make it again so the issue
      // date is the day this email goes, not the day of the cancelled schedule.
      const unseen = version && !(await one(tx, 'select 1 from bid_emails where version_id = $1 and cancelled_at is null', [version.id]));
      if (!version || unseen) {
        const issued = sendAt.toISOString().slice(0, 10);
        let validUntil = b.valid_until;
        if (!validUntil) {
          const days = (await one<{ d: number }>(tx, `select coalesce((select validity_days from bid_templates where id = $1), 30) as d`, [b.template_id]))!.d;
          validUntil = new Date(sendAt.getTime() + days * 86_400_000).toISOString().slice(0, 10);
          await tx.query('update staffing_bids set valid_until = $2 where id = $1', [id, validUntil]);
        }
        const proposal = await this.proposal(tx, b, lines, issued, validUntil);
        const pdf = await renderProposal(proposal);
        const key = this.storage.newKey(actor.tenantId);
        await this.storage.put(key, pdf);
        const snap = JSON.stringify(this.snapshot({ ...b, valid_until: validUntil }, lines, proposal));
        version = unseen
          ? (await one<{ id: string; pdf_storage_key: string }>(
            tx,
            `update bid_versions set snapshot = $2, pricing = $3, pdf_storage_key = $4, created_at = now(), created_by_membership_id = $5 where id = $1 returning id, pdf_storage_key`,
            [version!.id, snap, JSON.stringify(proposal.pricing), key, actor.membershipId],
          ))!
          : (await one<{ id: string; pdf_storage_key: string }>(
            tx,
            `insert into bid_versions (tenant_id, bid_id, version, event, snapshot, pricing, pdf_storage_key, created_by_membership_id)
             values (app_tenant_id(), $1, $2, 'sent', $3, $4, $5, $6) returning id, pdf_storage_key`,
            [id, b.version, snap, JSON.stringify(proposal.pricing), key, actor.membershipId],
          ))!;
      }
      const attachment: EmailAttachment = { filename: `${b.code}-v${b.version}.pdf`, contentType: 'application/pdf', storageKey: version.pdf_storage_key };
      const p = this.price(b, lines, await this.card(tx, b.rate_card_id));
      const summary = `${input.message}\n\n${b.code}: ${b.title}\n${p.headcount} people for ${b.duration_months} months from ${b.start_date}\nMonthly total: ${b.currency} ${formatAmount(p.monthlyRevenue, b.currency)}\n${p.fees.length ? `One-off fees: ${b.currency} ${formatAmount(p.feesTotal, b.currency)}\n` : ''}Contract value: ${b.currency} ${formatAmount(p.contractRevenue, b.currency)}\n\nThe full proposal is attached as a PDF.`;
      // Each recipient gets a private link to review and accept or decline online, live from when the email goes
      // until the proposal's validity ends (at least a week). Only its hash is stored.
      const until = (await one<{ v: string }>(tx, `select to_char(valid_until, 'YYYY-MM-DD') as v from staffing_bids where id = $1`, [id]))!.v;
      const expiresAt = new Date(Math.max(Date.parse(`${until}T23:59:59Z`), sendAt.getTime() + 7 * 86_400_000));
      const web = this.config.WEB_PUBLIC_URL.replace(/\/$/, '');
      const links: { to: string; hash: string }[] = [];
      const ids: string[] = [];
      for (const to of [input.to, ...input.cc]) {
        const mid = randomUUID();
        const token = randomBytes(24).toString('base64url');
        links.push({ to, hash: createHash('sha256').update(token).digest('hex') });
        const body = `${summary}\n\nReview it and accept or decline online: ${web}/proposal/${token}\nThis link is for ${to} and works until ${expiresAt.toISOString().slice(0, 10)}.`;
        await tx.query(
          `insert into email_messages (id, tenant_id, to_email, subject, text_body, template, attachments, next_attempt_at) values ($1, app_tenant_id(), $2, $3, $4, 'bid.proposal', $5, $6)`,
          [mid, to, input.subject, body, JSON.stringify([attachment]), sendAt.toISOString()],
        );
        ids.push(mid);
      }
      const e = (await one<{ id: string }>(
        tx,
        `insert into bid_emails (tenant_id, bid_id, version_id, to_email, cc, subject, message, send_at, email_message_ids, created_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [id, version.id, input.to, input.cc, input.subject, input.message, sendAt.toISOString(), ids, actor.membershipId],
      ))!;
      for (const l of links) {
        await tx.query(
          `insert into bid_acceptance_links (tenant_id, bid_id, version_id, bid_email_id, sent_to, token_hash, active_from, expires_at) values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)`,
          [id, version.id, e.id, l.to, l.hash, sendAt.toISOString(), expiresAt.toISOString()],
        );
      }
      await tx.query(`update staffing_bids set status = 'sent', sent_at = coalesce(sent_at, now()) where id = $1`, [id]);
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
        const v = await one<{ version: number; pdf_storage_key: string | null; snapshot: Omit<ProposalData, 'pricing'>; pricing: BidPricing }>(
          tx, 'select version, pdf_storage_key, snapshot, pricing from bid_versions where id = $1 and bid_id = $2', [versionId, id],
        );
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
      const l = await one<{ key: string; version: number }>(
        tx,
        `select l.signed_pdf_storage_key as key, v.version from bid_acceptance_links l join bid_versions v on v.id = l.version_id
          where l.bid_id = $1 and l.decision = 'accepted' and l.signed_pdf_storage_key is not null`,
        [id],
      );
      if (!l) throw Errors.notFound('Signed proposal');
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
