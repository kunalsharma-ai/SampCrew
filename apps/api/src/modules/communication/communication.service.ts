import { Injectable } from '@nestjs/common';
import type { AudienceInput, CommGroupInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { memberNames } from '../employees/employee-view';
import { describeAudience, resolveAudience } from './audience';
import { ChatService, hrTeam } from './chat.service';
import { CommEmailService } from './email.service';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const DAY = 86_400_000;

/** HR's groups of people, the audience preview, the Communication dashboard and each employee's communication record. */
@Injectable()
export class CommunicationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly emails: CommEmailService,
    private readonly chat: ChatService,
  ) {}

  groups() {
    return this.db.tenant(async (tx) => {
      const rows = await tx.collection('comm_groups').find({ archived_at: null }, { sort: { name: 1 } });
      const active = new Set(await tx.collection('memberships').distinct<string>('id', { status: 'active' }));
      const names = await memberNames(tx, rows.flatMap((g) => g.membership_ids as string[]));
      return {
        items: rows.map((g) => ({
          id: g.id, name: g.name, description: g.description, updatedAt: iso(g.updated_at), chatConversationId: g.chat_conversation_id ?? null,
          members: (g.membership_ids as string[]).filter((m) => active.has(m)).map((m) => ({ membershipId: m, name: names.get(m) ?? null })),
        })),
      };
    });
  }

  saveGroup(id: string | null, input: CommGroupInput) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: input.membershipIds }, status: 'active' }));
      const ids = [...new Set(input.membershipIds)].filter((m) => active.has(m));
      if (!ids.length) throw Errors.badRequest('no_members', 'Add at least one person');
      const clash = await tx.collection('comm_groups').findOne({ archived_at: null, name: { $regex: `^${input.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }, ...(id ? { id: { $ne: id } } : {}) });
      if (clash) throw Errors.conflict('duplicate_name', 'There is already a group with this name');
      const fields = { name: input.name, description: input.description, membership_ids: ids };
      if (id) {
        const n = await tx.collection('comm_groups').update({ id, archived_at: null }, { $set: fields });
        if (!n) throw Errors.notFound('Group');
        // People added to the group join its chat, when it has one.
        const g = await tx.collection('comm_groups').findOne({ id });
        const conv = g?.chat_conversation_id ? await tx.collection('chat_conversations').findOne({ id: g.chat_conversation_id, archived_at: null }) : undefined;
        if (conv) await this.chat.syncGroupChat(tx, conv, ids);
      } else id = (await tx.collection('comm_groups').insert({ ...fields, created_by_membership_id: s.membershipId })).id as string;
      await this.audit.record(tx, { action: 'comm_group.saved', resourceType: 'comm_group', resourceId: id!, changes: { name: input.name, members: ids.length } });
      return { id };
    });
  }

  archiveGroup(id: string) {
    return this.db.tenant(async (tx) => {
      const n = await tx.collection('comm_groups').update({ id, archived_at: null }, { $set: { archived_at: new Date() } });
      if (!n) throw Errors.notFound('Group');
      await this.audit.record(tx, { action: 'comm_group.archived', resourceType: 'comm_group', resourceId: id });
      return { ok: true };
    });
  }

  /** How many people an audience reaches right now, and its description, before sending. */
  preview(a: AudienceInput) {
    return this.db.tenant(async (tx) => {
      const people = await resolveAudience(tx, a);
      const names = await memberNames(tx, people.slice(0, 8).map((p) => p.membershipId));
      return { count: people.length, label: await describeAudience(tx, a), sample: people.slice(0, 8).map((p) => names.get(p.membershipId) ?? 'Unnamed') };
    });
  }

  /** The Communication dashboard for HR: email delivery, chat activity, conversations waiting for HR, open help requests. */
  dashboard() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      await this.emails.syncDelivery(tx);
      const since30 = new Date(Date.now() - 30 * DAY);
      const since7 = new Date(Date.now() - 7 * DAY);
      const sent = await tx.collection('comm_emails').find({ status: { $ne: 'draft' }, sent_at: { $gte: since30 } }, { projection: { recipient_count: 1, sent_count: 1, failed_count: 1 } });
      const recipients = sent.reduce((n, e) => n + (e.recipient_count as number), 0);
      const delivered = sent.reduce((n, e) => n + (e.sent_count as number), 0);
      const failed = sent.reduce((n, e) => n + (e.failed_count as number), 0);
      const drafts = await tx.collection('comm_emails').count({ status: 'draft' });
      const recentEmails = await tx.collection('comm_emails').find({ status: { $ne: 'draft' } }, { sort: { sent_at: -1 }, limit: 5 });
      const messages7 = await tx.collection('chat_messages').count({ created_at: { $gte: since7 }, system: false });
      const active7 = (await tx.collection('chat_messages').distinct<string>('conversation_id', { created_at: { $gte: since7 }, system: false })).length;
      // HR conversations whose latest message came from the employee: waiting for an HR reply.
      const hrConvs = await tx.collection('chat_conversations').find({ kind: 'hr', last_message_at: { $ne: null }, archived_at: null }, { sort: { last_message_at: -1 }, limit: 500 });
      const waiting = hrConvs.filter((c) => c.last_message?.senderMembershipId && c.last_message.senderMembershipId === c.employee_membership_id);
      const names = await memberNames(tx, [...waiting.map((c) => c.employee_membership_id), ...recentEmails.map((e) => e.sent_by_membership_id)]);
      const openCases = await tx.collection('helpdesk_cases').count({ status: { $nin: ['resolved', 'closed'] } });
      const team = await hrTeam(tx);
      return {
        email: { sent30: sent.length, recipients30: recipients, delivered30: delivered, failed30: failed, drafts, deliveryRate: recipients ? Math.round((delivered / recipients) * 100) : null },
        chat: { messages7, activeConversations7: active7, waitingForHr: waiting.length },
        helpdesk: { openCases },
        hrTeamSize: team.length,
        youAreInHrTeam: team.includes(s.membershipId),
        waiting: waiting.slice(0, 8).map((c) => ({ conversationId: c.id, employeeName: names.get(c.employee_membership_id) ?? 'Employee', preview: c.last_message.body, at: iso(c.last_message_at) })),
        recentEmails: await Promise.all(recentEmails.map(async (e) => ({
          id: e.id, subject: e.subject, status: e.status, recipientCount: e.recipient_count, sentCount: e.sent_count, failedCount: e.failed_count,
          audienceLabel: await describeAudience(tx, e.audience), sentAt: iso(e.sent_at), sentByName: names.get(e.sent_by_membership_id) ?? null,
        }))),
      };
    });
  }

  /** One employee's communication record: emails they were sent, their HR conversation, their help requests. */
  employeeRecord(employeeId: string) {
    return this.db.tenant(async (tx) => {
      const e = await tx.collection('employees').findOne({ id: employeeId }, { projection: { membership_id: 1, first_name: 1, last_name: 1 } });
      if (!e) throw Errors.notFound('Employee');
      const emails = (await this.emails.forEmployeeIn(tx, employeeId)).items;
      const hr = e.membership_id ? await tx.collection('chat_conversations').findOne({ kind: 'hr', employee_membership_id: e.membership_id }) : null;
      const cases = await tx.collection('helpdesk_cases').find({ employee_id: employeeId }, { sort: { created_at: -1 }, limit: 20, projection: { subject: 1, status: 1, number: 1, created_at: 1 } });
      return {
        employeeId, membershipId: e.membership_id ?? null, name: `${e.first_name} ${e.last_name ?? ''}`.trim(),
        emails,
        hrConversation: hr ? { id: hr.id, lastMessage: hr.last_message?.body ?? null, at: iso(hr.last_message_at) } : null,
        cases: cases.map((c) => ({ id: c.id, subject: c.subject, status: c.status, number: c.number, createdAt: iso(c.created_at) })),
      };
    });
  }
}
