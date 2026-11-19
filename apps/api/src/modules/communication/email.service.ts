import { Injectable } from '@nestjs/common';
import { type EmailDraftInput, emailInput, type EmailStatus, htmlToText } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { ilike, MongoService as DatabaseService, type TenantTx, usersTable } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { memberNames } from '../employees/employee-view';
import { describeAudience, resolveAudience, safeHtml } from './audience';
import { fileViews } from './chat.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const FOOTER = 'Sent by your HR team through SampCrew.';

/**
 * Emails from HR to people: everyone, chosen people, departments, designations or HR's own groups, with rich text,
 * attachments, Cc and Bcc. Each person gets their own copy (nobody sees the others' addresses); Cc and Bcc addresses
 * get one copy each. Delivery goes through the workspace's email provider (the mail queue), and each person's status
 * (queued, sent, failed, not sent because email is not set up) is kept and shown, also on the person's record.
 */
@Injectable()
export class CommEmailService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  /** Copies delivery results from the mail queue to the recipients, and settles each email's status. */
  async syncDelivery(tx: TenantTx, emailIds?: string[]) {
    const recipients = tx.collection('comm_email_recipients');
    const waiting = await recipients.find({ status: 'queued', email_message_id: { $ne: null }, ...(emailIds ? { email_id: { $in: emailIds } } : {}) }, { limit: 5000 });
    if (!waiting.length) return;
    const messages = await this.db.platform((p) => p.collection('email_messages').find({ id: { $in: waiting.map((w) => w.email_message_id) } }, { projection: { status: 1, last_error: 1, sent_at: 1 } }));
    const byId = new Map(messages.map((m) => [m.id as string, m]));
    const touched = new Set<string>();
    for (const w of waiting) {
      const m = byId.get(w.email_message_id);
      if (!m || m.status === 'queued') continue;
      const status = m.status === 'sent' ? 'sent' : m.status === 'skipped' ? 'skipped' : 'failed';
      await recipients.updateOne({ id: w.id }, { $set: { status, error: m.last_error ?? null, sent_at: m.sent_at ?? null } });
      touched.add(w.email_id);
    }
    for (const id of touched) await this.settle(tx, id);
  }

  private async settle(tx: TenantTx, id: string) {
    const rows = await tx.collection('comm_email_recipients').find({ email_id: id }, { projection: { status: 1 } });
    const sent = rows.filter((r) => r.status === 'sent').length;
    const failed = rows.filter((r) => r.status === 'failed' || r.status === 'skipped').length;
    const queued = rows.length - sent - failed;
    const status: EmailStatus = queued ? 'sending' : failed === 0 ? 'sent' : sent === 0 ? 'failed' : 'partly_failed';
    await tx.collection('comm_emails').updateOne({ id }, { $set: { status, sent_count: sent, failed_count: failed } });
  }

  private async views(tx: TenantTx, rows: Doc[]) {
    const names = await memberNames(tx, rows.flatMap((r) => [r.created_by_membership_id, r.sent_by_membership_id]));
    return Promise.all(rows.map(async (r) => ({
      id: r.id, subject: r.subject, status: r.status, preview: (r.text as string).slice(0, 160), audience: r.audience, audienceLabel: await describeAudience(tx, r.audience),
      cc: r.cc, bcc: r.bcc, recipientCount: r.recipient_count, sentCount: r.sent_count, failedCount: r.failed_count, fileCount: (r.file_ids as string[]).length,
      createdByName: names.get(r.created_by_membership_id) ?? null, sentByName: r.sent_by_membership_id ? names.get(r.sent_by_membership_id) ?? null : null,
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), sentAt: iso(r.sent_at),
    })));
  }

  /** Emails, newest first: drafts and sent ones, or those one employee was sent. */
  list(q: { status?: EmailStatus; q?: string; employeeId?: string; before?: string; limit: number }) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('helpdesk:manage', undefined, tx);
      const filter: Doc = {};
      if (q.status) filter.status = q.status;
      if (q.q) filter.$or = [{ subject: ilike(q.q) }, { text: ilike(q.q) }];
      if (q.employeeId) filter.id = { $in: await tx.collection('comm_email_recipients').distinct<string>('email_id', { employee_id: q.employeeId }) };
      if (q.before) filter.updated_at = { $lt: new Date(q.before) };
      const rows = await tx.collection('comm_emails').find(filter, { sort: { updated_at: -1 }, limit: q.limit + 1 });
      await this.syncDelivery(tx, rows.filter((r) => r.status === 'sending').map((r) => r.id));
      const fresh = rows.length ? await tx.collection('comm_emails').find({ id: { $in: rows.map((r) => r.id) } }, { sort: { updated_at: -1 } }) : [];
      const page = fresh.slice(0, q.limit);
      return { items: await this.views(tx, page), nextBefore: fresh.length > q.limit ? iso(page.at(-1)!.updated_at) : null };
    });
  }

  /** One email with its body, files and every recipient's delivery status. */
  get(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('helpdesk:manage', undefined, tx);
      await this.syncDelivery(tx, [id]);
      const r = await tx.collection('comm_emails').findOne({ id });
      if (!r) throw Errors.notFound('Email');
      const recipients = await tx.collection('comm_email_recipients').find({ email_id: id }, { sort: { kind: 1, address: 1 }, limit: 5000 });
      const names = await memberNames(tx, recipients.map((x) => x.membership_id));
      const files = await fileViews(tx, r.file_ids);
      return {
        ...(await this.views(tx, [r]))[0],
        html: r.html, text: r.text, files: (r.file_ids as string[]).map((f) => files.get(f)).filter(Boolean),
        recipients: recipients.map((x) => ({
          id: x.id, kind: x.kind, address: x.address, name: x.membership_id ? names.get(x.membership_id) ?? null : null, employeeId: x.employee_id ?? null,
          status: x.status, error: x.error ?? null, sentAt: iso(x.sent_at),
        })),
      };
    });
  }

  private async checkFiles(tx: TenantTx, ids: string[], membershipId: string) {
    if (!ids.length) return;
    const n = await tx.collection('comm_files').count({ id: { $in: ids }, uploaded_by_membership_id: membershipId });
    if (n !== new Set(ids).size) throw Errors.badRequest('unknown_file', 'Upload the attachments again');
  }

  /** Saves a draft (new, or changes to one not sent yet). */
  saveDraft(id: string | null, input: EmailDraftInput) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      await this.authz.require('helpdesk:manage', undefined, tx);
      await this.checkFiles(tx, input.fileIds, s.membershipId);
      const html = safeHtml(input.html);
      const fields = { subject: input.subject, html, text: htmlToText(html), audience: input.audience, cc: input.cc, bcc: input.bcc, file_ids: input.fileIds };
      if (id) {
        const n = await tx.collection('comm_emails').update({ id, status: 'draft' }, { $set: fields });
        if (!n) throw Errors.conflict('not_a_draft', 'This email was already sent');
        return { id };
      }
      const row = await tx.collection('comm_emails').insert({ ...fields, created_by_membership_id: s.membershipId });
      await this.audit.record(tx, { action: 'comm_email.drafted', resourceType: 'comm_email', resourceId: row.id, changes: { subject: input.subject } });
      return { id: row.id as string };
    });
  }

  deleteDraft(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('helpdesk:manage', undefined, tx);
      const n = await tx.collection('comm_emails').delete({ id, status: 'draft' });
      if (!n) throw Errors.conflict('not_a_draft', 'Only drafts can be deleted; sent emails are kept');
      await this.audit.record(tx, { action: 'comm_email.draft_deleted', resourceType: 'comm_email', resourceId: id });
      return { ok: true };
    });
  }

  /** Sends a draft (saved with the given content first), or a new email when id is null. */
  send(id: string | null, raw: EmailDraftInput) {
    const parsed = emailInput.safeParse(raw);
    if (!parsed.success) throw Errors.validation(parsed.error.issues);
    const input = parsed.data;
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      await this.authz.require('helpdesk:manage', undefined, tx);
      await this.checkFiles(tx, input.fileIds, s.membershipId);
      const html = safeHtml(input.html);
      const text = htmlToText(html);
      if (!text) throw Errors.badRequest('empty_body', 'Write the message');
      const people = await resolveAudience(tx, input.audience);
      if (!people.length) throw Errors.badRequest('no_recipients', 'Nobody with an active login is in this audience');
      const members = await tx.collection('memberships').find({ id: { $in: people.map((p) => p.membershipId) } }, { projection: { user_id: 1 } });
      const emails = new Map((await (await usersTable(tx)).find({ id: { $in: members.map((m) => m.user_id) } }, { projection: { email: 1 } })).map((u) => [u.id as string, u.email as string]));
      const addressOf = new Map(members.map((m) => [m.id as string, emails.get(m.user_id)]));
      const fields = { subject: input.subject, html, text, audience: input.audience, cc: input.cc, bcc: input.bcc, file_ids: input.fileIds };
      let emailId = id;
      if (emailId) {
        const n = await tx.collection('comm_emails').update({ id: emailId, status: 'draft' }, { $set: fields });
        if (!n) throw Errors.conflict('not_a_draft', 'This email was already sent');
      } else {
        emailId = (await tx.collection('comm_emails').insert({ ...fields, created_by_membership_id: s.membershipId })).id as string;
      }
      const files = input.fileIds.length ? await tx.collection('comm_files').find({ id: { $in: input.fileIds } }) : [];
      const attachments = files.map((f) => ({ filename: f.name, contentType: f.type, storageKey: f.storage_key }));
      const body = (copyNote: string) => ({
        text_body: `${copyNote}${text}\n\n--\n${FOOTER}`,
        html_body: `${copyNote ? `<p><em>${escapeHtml(copyNote.trim())}</em></p>` : ''}${html}<hr><p style="color:#6b7280;font-size:12px">${FOOTER}</p>`,
      });
      const queue = async (address: string, kind: 'to' | 'cc' | 'bcc', person?: { membershipId: string; employeeId: string | null }) => {
        const note = kind === 'to' ? '' : `Copy of an email sent to ${people.length === 1 ? '1 person' : `${people.length} people`}.\n\n`;
        const m = await tx.collection('email_messages').insert({ tenant_id: tx.tenantId, to_email: address, subject: input.subject, template: 'communication.email', attachments, ...body(note) });
        return { email_id: emailId, kind, address, membership_id: person?.membershipId ?? null, employee_id: person?.employeeId ?? null, email_message_id: m.id };
      };
      const rows: Doc[] = [];
      for (const p of people) {
        const address = addressOf.get(p.membershipId);
        if (address) rows.push(await queue(address, 'to', p));
      }
      const extra = new Set(rows.map((r) => r.address.toLowerCase()));
      for (const [kind, list] of [['cc', input.cc], ['bcc', input.bcc]] as const) {
        for (const a of list) if (!extra.has(a)) { extra.add(a); rows.push(await queue(a, kind)); }
      }
      await tx.collection('comm_email_recipients').insertMany(rows);
      await tx.collection('comm_emails').updateOne({ id: emailId }, {
        $set: { status: 'sending', sent_at: new Date(), sent_by_membership_id: s.membershipId, recipient_count: rows.length, sent_count: 0, failed_count: 0 },
      });
      await this.audit.record(tx, {
        action: 'comm_email.sent', resourceType: 'comm_email', resourceId: emailId,
        changes: { subject: input.subject, audience: input.audience, cc: input.cc.length, bcc: input.bcc.length, files: input.fileIds.length }, metadata: { recipients: rows.length },
      });
      return { id: emailId, recipients: rows.length };
    });
  }

  /** Emails an employee was sent (their communication record); the caller checks access. */
  async forEmployeeIn(tx: TenantTx, employeeId: string) {
    const queued = await tx.collection('comm_email_recipients').distinct<string>('email_id', { employee_id: employeeId, status: 'queued' });
    if (queued.length) await this.syncDelivery(tx, queued);
    const rows = await tx.collection('comm_email_recipients').find({ employee_id: employeeId, kind: 'to' }, { sort: { created_at: -1 }, limit: 200 });
    const emails = new Map((await tx.collection('comm_emails').find({ id: { $in: rows.map((r) => r.email_id) } }, { projection: { subject: 1, sent_at: 1, text: 1 } })).map((e) => [e.id as string, e]));
    return {
      items: rows.map((r) => ({
        emailId: r.email_id, subject: emails.get(r.email_id)?.subject ?? '', preview: ((emails.get(r.email_id)?.text as string | undefined) ?? '').slice(0, 140),
        status: r.status, address: r.address, error: r.error ?? null, sentAt: iso(r.sent_at ?? emails.get(r.email_id)?.sent_at),
      })),
    };
  }

  /** Emails from HR that you were sent, to read in SampCrew too. */
  inbox() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const recips = await tx.collection('comm_email_recipients').find({ membership_id: s.membershipId, kind: 'to' }, { sort: { created_at: -1 }, limit: 100 });
      const emails = await tx.collection('comm_emails').find({ id: { $in: recips.map((r) => r.email_id) } }, { sort: { sent_at: -1 } });
      const files = await fileViews(tx, emails.flatMap((e) => e.file_ids as string[]));
      const names = await memberNames(tx, emails.map((e) => e.sent_by_membership_id));
      return {
        items: emails.map((e) => ({
          id: e.id, subject: e.subject, html: e.html, sentAt: iso(e.sent_at), sentByName: names.get(e.sent_by_membership_id) ?? null,
          files: (e.file_ids as string[]).map((f) => files.get(f)).filter(Boolean),
        })),
      };
    });
  }
}
