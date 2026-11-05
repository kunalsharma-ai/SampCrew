import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { BidPricing, ProposalAcceptInput, ProposalDeclineInput, PublicProposal } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, one, type Tx } from '../../platform/database/database.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { StorageService } from '../../platform/storage/storage.service';
import { appendAcceptance, type ProposalData } from './proposal-pdf';

/** Tokens are 24 random bytes in base64url: exactly 32 characters. */
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

interface LinkRow {
  id: string;
  bid_id: string;
  version_id: string;
  bid_email_id: string;
  sent_to: string;
  active_from: Date;
  expires_at: Date;
  revoked_at: Date | null;
  decision: 'accepted' | 'declined' | null;
  decided_at: Date | null;
  signer_name: string | null;
  signer_title: string | null;
  decline_reason: string | null;
}

interface Context {
  link: LinkRow;
  bid: { code: string; title: string; status: string; version: number; owner_membership_id: string };
  version: { version: number; snapshot: Omit<ProposalData, 'pricing'>; pricing: BidPricing; pdf_storage_key: string };
  sentTo: string;
  answered: boolean;
}

/**
 * The client's side of a proposal: the private link in the proposal email opens the proposal, and the client
 * accepts it with a typed signature or declines it with a reason. No sign-in; the link is the credential, and
 * only its SHA-256 is stored. Accepting marks the bid won and keeps a signed copy of the PDF with the evidence.
 */
@Injectable()
export class ProposalsPublicService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
  ) {}

  /** Finds the workspace for a token and runs fn inside it. Unknown, revoked or not-yet-sent links are 404. */
  private async withLink<T>(token: string, fn: (tx: Tx, c: Context, tenantId: string) => Promise<T>, lock = false): Promise<T> {
    if (!TOKEN.test(token)) throw Errors.notFound('Proposal');
    const hash = createHash('sha256').update(token).digest('hex');
    const t = await this.db.platform((tx) =>
      one<{ tenant_id: string }>(tx, `select l.tenant_id from bid_acceptance_links l join tenants t on t.id = l.tenant_id where l.token_hash = $1 and t.status = 'active'`, [hash]),
    );
    if (!t) throw Errors.notFound('Proposal');
    return this.db.tenant(async (tx) => {
      const e = await this.entitlements.current(tx);
      if (!e.features.has('recruitment')) throw Errors.notFound('Proposal');
      const link = await one<LinkRow>(
        tx,
        `select id, bid_id, version_id, bid_email_id, sent_to::text, active_from, expires_at, revoked_at, decision, decided_at, signer_name, signer_title, decline_reason
           from bid_acceptance_links where token_hash = $1${lock ? ' for update' : ''}`,
        [hash],
      );
      if (!link || (link.revoked_at && !link.decision) || link.active_from.getTime() > Date.now()) throw Errors.notFound('Proposal');
      const bid = (await one<Context['bid']>(tx, `select code, title, status, version, owner_membership_id from staffing_bids where id = $1${lock ? ' for update' : ''}`, [link.bid_id]))!;
      const version = (await one<Context['version']>(tx, 'select version, snapshot, pricing, pdf_storage_key from bid_versions where id = $1', [link.version_id]))!;
      const sentTo = link.sent_to;
      const answered = !!(await one(tx, 'select 1 from bid_acceptance_links where bid_id = $1 and decision is not null', [link.bid_id]));
      return fn(tx, { link, bid, version, sentTo, answered }, t.tenant_id);
    }, { tenantId: t.tenant_id });
  }

  private status(c: Context): PublicProposal['status'] {
    if (c.link.decision) return c.link.decision;
    if (c.bid.status === 'withdrawn') return 'withdrawn';
    if (c.answered || c.bid.status === 'won' || c.bid.status === 'lost') return 'closed';
    if (c.bid.version !== c.version.version || c.bid.status !== 'sent') return 'replaced';
    if (c.link.expires_at.getTime() < Date.now()) return 'expired';
    return 'open';
  }

  private view(c: Context): PublicProposal {
    const s = c.version.snapshot;
    const p = c.version.pricing;
    return {
      status: this.status(c),
      organisation: s.workspace, code: s.code, version: s.version, title: s.title, clientName: s.client.name, issuedOn: s.issuedOn,
      validUntil: s.validUntil, expiresAt: c.link.expires_at.toISOString(), currency: s.currency, startDate: s.startDate,
      durationMonths: s.durationMonths, coverNote: s.coverNote, terms: s.terms, preparedBy: s.preparedBy,
      // Rates and totals only: never pay, costs or margins.
      lines: p.lines.map((l) => ({ roleTitle: l.roleTitle, location: l.location, headcount: l.headcount, billMonthly: l.billMonthly, monthlyRevenue: l.monthlyRevenue })),
      headcount: p.headcount, monthlyRevenue: p.monthlyRevenue, contractRevenue: p.contractRevenue,
      // Versions priced before fees existed have none.
      fees: (p.fees ?? []).map((f) => ({ label: f.label, amount: f.amount, billing: f.billing })), feesTotal: p.feesTotal ?? '0.00',
      decision: c.link.decision
        ? { kind: c.link.decision, by: c.link.signer_name!, title: c.link.signer_title, at: c.link.decided_at!.toISOString(), reason: c.link.decline_reason }
        : null,
    };
  }

  /** Opens the proposal. Counts the view; the first view tells the bid owner. */
  async get(token: string): Promise<PublicProposal> {
    return this.withLink(token, async (tx, c, tenantId) => {
      const first = !(await one(tx, 'select 1 from bid_acceptance_links where id = $1 and first_viewed_at is not null', [c.link.id]));
      await tx.query('update bid_acceptance_links set view_count = view_count + 1, first_viewed_at = coalesce(first_viewed_at, now()) where id = $1', [c.link.id]);
      if (first && this.status(c) === 'open') {
        await this.notifications.notify(tx, {
          membershipIds: [c.bid.owner_membership_id], kind: 'bid.viewed',
          title: `${c.version.snapshot.client.name} opened proposal ${c.bid.code}`, link: `/staffing/bids/${c.link.bid_id}`,
        });
        await this.audit.record(tx, { action: 'bid.proposal_viewed', resourceType: 'staffing_bid', resourceId: c.link.bid_id, tenantId, metadata: { sentTo: c.sentTo } });
      }
      return this.view(c);
    });
  }

  /** The PDF the link was sent with (or the signed copy once accepted). */
  async pdf(token: string): Promise<{ fileName: string; content: Buffer }> {
    return this.withLink(token, async (tx, c) => {
      const signed = c.link.decision === 'accepted'
        ? (await one<{ k: string | null }>(tx, 'select signed_pdf_storage_key as k from bid_acceptance_links where id = $1', [c.link.id]))!.k
        : null;
      return { fileName: `${c.bid.code}-v${c.version.version}${signed ? '-signed' : ''}.pdf`, content: await this.read(signed ?? c.version.pdf_storage_key) };
    });
  }

  private open(c: Context) {
    const s = this.status(c);
    if (s === 'open') return;
    const why: Record<string, string> = {
      accepted: 'This proposal has already been accepted',
      declined: 'This proposal has already been declined',
      closed: 'This proposal has already been answered',
      withdrawn: 'This proposal has been withdrawn',
      replaced: 'This proposal has been replaced by a newer version',
      expired: 'This link has expired',
    };
    throw Errors.conflict(`proposal_${s}`, why[s]!);
  }

  async accept(token: string, input: ProposalAcceptInput): Promise<PublicProposal> {
    const ctx = requestContext.get();
    return this.withLink(token, async (tx, c, tenantId) => {
      this.open(c);
      const original = await this.read(c.version.pdf_storage_key);
      const sha = createHash('sha256').update(original).digest('hex');
      const at = new Date();
      const signed = await appendAcceptance(original, {
        code: c.bid.code, version: c.version.version, clientName: c.version.snapshot.client.name, workspace: c.version.snapshot.workspace,
        signerName: input.signerName, signerTitle: input.signerTitle, signerEmail: input.signerEmail, signature: input.signature,
        acceptedAt: at.toISOString(), ip: ctx?.ip ?? null, userAgent: ctx?.userAgent ?? null, pdfSha256: sha, linkSentTo: c.sentTo,
      });
      const key = this.storage.newKey(tenantId);
      await this.storage.put(key, signed);
      await tx.query(
        `update bid_acceptance_links set decision = 'accepted', decided_at = $2, signer_name = $3, signer_title = $4, signer_email = $5, signature = $6,
                decided_ip = $7, decided_user_agent = $8, pdf_sha256 = $9, signed_pdf_storage_key = $10 where id = $1`,
        [c.link.id, at.toISOString(), input.signerName, input.signerTitle, input.signerEmail, input.signature, ctx?.ip ?? null, ctx?.userAgent?.slice(0, 500) ?? null, sha, key],
      );
      await this.close(tx, c, 'won', `Accepted online by ${input.signerName}, ${input.signerTitle}`);
      await this.notifications.notify(tx, {
        membershipIds: [c.bid.owner_membership_id], kind: 'bid.accepted', email: true,
        title: `${c.version.snapshot.client.name} accepted proposal ${c.bid.code}`,
        body: `${input.signerName} (${input.signerTitle}) accepted ${c.bid.code}: ${c.bid.title}. The bid is marked won and the signed copy is on the bid.`,
        link: `/staffing/bids/${c.link.bid_id}`,
      });
      await this.audit.record(tx, {
        action: 'bid.accepted_online', resourceType: 'staffing_bid', resourceId: c.link.bid_id, tenantId,
        changes: { status: 'won' }, metadata: { signerName: input.signerName, signerTitle: input.signerTitle, signerEmail: input.signerEmail, version: c.version.version, pdfSha256: sha, sentTo: c.sentTo },
      });
      return this.view({ ...c, link: { ...c.link, decision: 'accepted', decided_at: at, signer_name: input.signerName, signer_title: input.signerTitle } });
    }, true);
  }

  async decline(token: string, input: ProposalDeclineInput): Promise<PublicProposal> {
    const ctx = requestContext.get();
    return this.withLink(token, async (tx, c, tenantId) => {
      this.open(c);
      const at = new Date();
      await tx.query(
        `update bid_acceptance_links set decision = 'declined', decided_at = $2, signer_name = $3, signer_email = $4, decline_reason = $5, decided_ip = $6, decided_user_agent = $7 where id = $1`,
        [c.link.id, at.toISOString(), input.signerName, input.signerEmail, input.reason, ctx?.ip ?? null, ctx?.userAgent?.slice(0, 500) ?? null],
      );
      await this.close(tx, c, 'lost', `Declined online by ${input.signerName}: ${input.reason}`.slice(0, 1000));
      await this.notifications.notify(tx, {
        membershipIds: [c.bid.owner_membership_id], kind: 'bid.declined', email: true,
        title: `${c.version.snapshot.client.name} declined proposal ${c.bid.code}`, body: `${input.signerName}: ${input.reason}`,
        link: `/staffing/bids/${c.link.bid_id}`,
      });
      await this.audit.record(tx, {
        action: 'bid.declined_online', resourceType: 'staffing_bid', resourceId: c.link.bid_id, tenantId,
        changes: { status: 'lost' }, metadata: { signerName: input.signerName, signerEmail: input.signerEmail, reason: input.reason, version: c.version.version },
      });
      return this.view({ ...c, link: { ...c.link, decision: 'declined', decided_at: at, signer_name: input.signerName, signer_title: null, decline_reason: input.reason } });
    }, true);
  }

  /** Records the outcome on the bid. Other links for the bid then show it as answered. */
  private async close(tx: Tx, c: Context, status: 'won' | 'lost', reason: string) {
    await tx.query(`update staffing_bids set status = $2, decided_at = now(), outcome_reason = $3 where id = $1`, [c.link.bid_id, status, reason]);
  }

  private async read(key: string) {
    const { stream } = await this.storage.open(key);
    const chunks: Buffer[] = [];
    for await (const ch of stream) chunks.push(ch as Buffer);
    return Buffer.concat(chunks);
  }
}
