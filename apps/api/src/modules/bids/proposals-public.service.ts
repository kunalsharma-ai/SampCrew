import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { BidPricing, ProposalAcceptInput, ProposalDeclineInput, PublicProposal } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx as Tx } from '../../platform/database/mongo.service';
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
    const t = await this.db.platform(async (tx) => {
      const l = await tx.collection('bid_acceptance_links').findOne({ token_hash: hash }, { projection: { tenant_id: 1 } });
      if (!l || !(await tx.collection('tenants').exists({ id: l.tenant_id, status: 'active' }))) return undefined;
      return { tenant_id: l.tenant_id as string };
    });
    if (!t) throw Errors.notFound('Proposal');
    return this.db.tenant(async (tx) => {
      const e = await this.entitlements.current(tx);
      if (!e.features.has('staffing_bids')) throw Errors.notFound('Proposal');
      const links = tx.collection('bid_acceptance_links');
      if (lock) await links.lock({ token_hash: hash });
      const link = (await links.findOne({ token_hash: hash }, {
        projection: { id: 1, bid_id: 1, version_id: 1, bid_email_id: 1, sent_to: 1, active_from: 1, expires_at: 1, revoked_at: 1, decision: 1, decided_at: 1, signer_name: 1, signer_title: 1, decline_reason: 1 },
      })) as unknown as LinkRow | undefined;
      if (!link || (link.revoked_at && !link.decision) || link.active_from.getTime() > Date.now()) throw Errors.notFound('Proposal');
      if (lock) await tx.collection('staffing_bids').lock({ id: link.bid_id });
      const bid = (await tx.collection('staffing_bids').findOne({ id: link.bid_id }, { projection: { code: 1, title: 1, status: 1, version: 1, owner_membership_id: 1 } })) as unknown as Context['bid'];
      const version = (await tx.collection('bid_versions').findOne({ id: link.version_id }, { projection: { version: 1, snapshot: 1, pricing: 1, pdf_storage_key: 1 } })) as unknown as Context['version'];
      const sentTo = link.sent_to;
      const answered = await links.exists({ bid_id: link.bid_id, decision: { $ne: null } });
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
      const links = tx.collection('bid_acceptance_links');
      const first = !(await links.exists({ id: c.link.id, first_viewed_at: { $ne: null } }));
      await links.updateOne({ id: c.link.id }, first ? { $inc: { view_count: 1 }, $set: { first_viewed_at: new Date() } } : { $inc: { view_count: 1 } });
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
        ? ((await tx.collection('bid_acceptance_links').findOne({ id: c.link.id }, { projection: { signed_pdf_storage_key: 1 } }))?.signed_pdf_storage_key as string | null)
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
      await tx.collection('bid_acceptance_links').updateOne({ id: c.link.id }, { $set: {
        decision: 'accepted', decided_at: at, signer_name: input.signerName, signer_title: input.signerTitle, signer_email: input.signerEmail, signature: input.signature,
        decided_ip: ctx?.ip ?? null, decided_user_agent: ctx?.userAgent?.slice(0, 500) ?? null, pdf_sha256: sha, signed_pdf_storage_key: key,
      } });
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
      await tx.collection('bid_acceptance_links').updateOne({ id: c.link.id }, { $set: {
        decision: 'declined', decided_at: at, signer_name: input.signerName, signer_email: input.signerEmail, decline_reason: input.reason,
        decided_ip: ctx?.ip ?? null, decided_user_agent: ctx?.userAgent?.slice(0, 500) ?? null,
      } });
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
    await tx.collection('staffing_bids').updateOne({ id: c.link.bid_id }, { $set: { status, decided_at: new Date(), outcome_reason: reason } });
  }

  private async read(key: string) {
    const { stream } = await this.storage.open(key);
    const chunks: Buffer[] = [];
    for await (const ch of stream) chunks.push(ch as Buffer);
    return Buffer.concat(chunks);
  }
}
