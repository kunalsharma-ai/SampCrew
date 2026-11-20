import { Injectable } from '@nestjs/common';
import type { ChatMessageInput, ChatMessageView, CommFile, ConversationInput, ConversationView, MessageDelivery } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { ilike, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { memberNames } from '../employees/employee-view';
import { CURRENT_STATUSES } from './audience';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const PREVIEW = 140;
const preview = (body: string, files: number) => (body ? body.replace(/\s+/g, ' ').slice(0, PREVIEW) : files === 1 ? 'Sent a file' : `Sent ${files} files`);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
export const chatLink = (id: string) => `/communication/chat/${id}`;

/** Files as messages and emails list them, with the link the Web Portal serves them from. */
export async function fileViews(tx: TenantTx, ids: string[]): Promise<Map<string, CommFile>> {
  if (!ids.length) return new Map();
  const rows = await tx.collection('comm_files').find({ id: { $in: [...new Set(ids)] } }, { projection: { name: 1, type: 1, size: 1 } });
  return new Map(rows.map((f) => [f.id as string, { id: f.id, name: f.name, type: f.type, size: f.size, href: `/communication-files/${f.id}` }]));
}

/** Active members holding `helpdesk:manage`: the HR team that answers employees' messages to HR. */
export async function hrTeam(tx: TenantTx): Promise<string[]> {
  const perms = await tx.collection('role_permissions').find({ permission: 'helpdesk:manage' }, { projection: { role_id: 1 } });
  const ids = await tx.collection('role_assignments').distinct<string>('membership_id', { role_id: { $in: perms.map((p) => p.role_id) } });
  return tx.collection('memberships').distinct<string>('id', { id: { $in: ids }, status: 'active' });
}

/**
 * Internal chat. One to one conversations, groups people make, department conversations HR makes (members follow the
 * department), and each employee's conversation with the HR team, which everyone who handles the HR helpdesk can
 * read and answer. New messages arrive live and fold into one notification per conversation; each member's read and
 * received positions give "Sent", "Delivered" and "Read" on your own messages.
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private isHr(s: Subject) {
    return hasPermission(s, 'helpdesk:manage').allowed;
  }

  /** The conversation and the caller's place in it, or not found when they may not see it. */
  private async access(tx: TenantTx, id: string, s: Subject) {
    const conv = await tx.collection('chat_conversations').findOne({ id, archived_at: null });
    if (!conv) throw Errors.notFound('Conversation');
    const member = await tx.collection('chat_members').findOne({ conversation_id: id, membership_id: s.membershipId });
    if (conv.kind === 'hr') {
      const asEmployee = conv.employee_membership_id === s.membershipId;
      if (!asEmployee && !this.isHr(s)) throw Errors.notFound('Conversation');
      return { conv, member, asHr: !asEmployee };
    }
    if (conv.kind === 'department') await this.syncDepartment(tx, conv);
    const current = conv.kind === 'department' ? await tx.collection('chat_members').findOne({ conversation_id: id, membership_id: s.membershipId }) : member;
    if (!current || current.left_at) throw Errors.notFound('Conversation');
    return { conv, member: current, asHr: false };
  }

  /** Members of a conversation who should hear about a new message (everyone but the sender). */
  private async audience(tx: TenantTx, conv: Doc): Promise<{ id: string; muted: boolean }[]> {
    const rows = await tx.collection('chat_members').find({ conversation_id: conv.id, left_at: null }, { projection: { membership_id: 1, muted: 1 } });
    const out = new Map(rows.map((r) => [r.membership_id as string, { id: r.membership_id as string, muted: !!r.muted }]));
    if (conv.kind === 'hr') {
      out.set(conv.employee_membership_id, { id: conv.employee_membership_id, muted: false });
      for (const id of await hrTeam(tx)) if (!out.has(id)) out.set(id, { id, muted: false });
    }
    return [...out.values()];
  }

  /** Makes a department conversation's members the department's current people (sub-departments included). */
  private async syncDepartment(tx: TenantTx, conv: Doc) {
    const departments = await tx.collection('departments').find({}, { projection: { parent_id: 1 } });
    const tree = new Set<string>([conv.department_id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const d of departments) if (d.parent_id && tree.has(d.parent_id) && !tree.has(d.id)) { tree.add(d.id); grew = true; }
    }
    const emps = await tx.collection('employees').find({ status: { $in: CURRENT_STATUSES }, current_department_id: { $in: [...tree] }, membership_id: { $ne: null } }, { projection: { membership_id: 1 } });
    const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: emps.map((e) => e.membership_id) }, status: 'active' }));
    const rows = await tx.collection('chat_members').find({ conversation_id: conv.id }, { projection: { membership_id: 1, left_at: 1, role: 1 } });
    const now = new Date();
    for (const r of rows) {
      const stays = active.has(r.membership_id) || r.role === 'owner';
      if (!stays && !r.left_at) await tx.collection('chat_members').updateOne({ id: r.id }, { $set: { left_at: now } });
      if (stays && r.left_at) await tx.collection('chat_members').updateOne({ id: r.id }, { $set: { left_at: null, joined_at: now } });
    }
    const have = new Set(rows.map((r) => r.membership_id as string));
    const add = [...active].filter((id) => !have.has(id));
    if (add.length) await tx.collection('chat_members').insertMany(add.map((id) => ({ conversation_id: conv.id, membership_id: id, role: 'member' })));
  }

  /** Joins the caller to department conversations of their department (and the departments above it). */
  private async joinMyDepartments(tx: TenantTx, s: Subject) {
    if (!s.employeeId) return;
    const e = await tx.collection('employees').findOne({ id: s.employeeId }, { projection: { current_department_id: 1 } });
    if (!e?.current_department_id) return;
    const departments = new Map((await tx.collection('departments').find({}, { projection: { parent_id: 1 } })).map((d) => [d.id as string, (d.parent_id as string | null) ?? null]));
    const chain: string[] = [];
    for (let d: string | null = e.current_department_id; d && !chain.includes(d); d = departments.get(d) ?? null) chain.push(d);
    const convs = await tx.collection('chat_conversations').find({ kind: 'department', department_id: { $in: chain }, archived_at: null }, { projection: { _id: 1 } });
    for (const c of convs) {
      const m = await tx.collection('chat_members').findOne({ conversation_id: c.id, membership_id: s.membershipId });
      if (!m) await tx.collection('chat_members').insert({ conversation_id: c.id, membership_id: s.membershipId, role: 'member' });
      else if (m.left_at) await tx.collection('chat_members').updateOne({ id: m.id }, { $set: { left_at: null, joined_at: new Date() } });
    }
  }

  /** Conversations as the list shows them, newest activity first. */
  private async views(tx: TenantTx, convs: Doc[], s: Subject): Promise<ConversationView[]> {
    if (!convs.length) return [];
    const ids = convs.map((c) => c.id as string);
    const members = await tx.collection('chat_members').find({ conversation_id: { $in: ids }, left_at: null }, { projection: { conversation_id: 1, membership_id: 1, role: 1, muted: 1, last_read_at: 1 } });
    const names = await memberNames(tx, [...members.map((m) => m.membership_id), ...convs.map((c) => c.employee_membership_id), ...convs.map((c) => c.last_message?.senderMembershipId)]);
    const deptNames = new Map((await tx.collection('departments').find({ id: { $in: convs.map((c) => c.department_id).filter(Boolean) } }, { projection: { name: 1 } })).map((d) => [d.id as string, d.name as string]));
    const out: ConversationView[] = [];
    for (const c of convs) {
      const mine = members.find((m) => m.conversation_id === c.id && m.membership_id === s.membershipId);
      const people = members.filter((m) => m.conversation_id === c.id);
      const unread = await tx.collection('chat_messages').count({
        conversation_id: c.id, deleted_at: null, sender_membership_id: { $ne: s.membershipId },
        ...(mine?.last_read_at ? { created_at: { $gt: mine.last_read_at } } : mine ? { created_at: { $gt: mine.joined_at ?? new Date(0) } } : {}),
      });
      let title = c.title as string;
      let subtitle: string | null = null;
      if (c.kind === 'direct') {
        const other = people.find((m) => m.membership_id !== s.membershipId);
        title = (other && names.get(other.membership_id)) || 'Former colleague';
        subtitle = 'Direct message';
      } else if (c.kind === 'hr') {
        const asEmployee = c.employee_membership_id === s.membershipId;
        title = asEmployee ? 'HR team' : names.get(c.employee_membership_id) ?? 'Employee';
        subtitle = asEmployee ? 'Your conversation with HR' : 'Message to HR';
      } else if (c.kind === 'department') {
        title = title || deptNames.get(c.department_id) || 'Department';
        subtitle = `Department · ${people.length} people`;
      } else subtitle = `Group · ${people.length} people`;
      out.push({
        id: c.id, kind: c.kind, title, subtitle, memberCount: people.length,
        members: people.map((m) => ({ membershipId: m.membership_id, name: names.get(m.membership_id) ?? null })),
        lastMessage: c.last_message ? { body: c.last_message.body, senderName: c.last_message.senderMembershipId ? names.get(c.last_message.senderMembershipId) ?? null : null, at: iso(c.last_message.at)! } : null,
        unread, muted: !!mine?.muted,
        canManage: c.kind === 'group' ? mine?.role === 'owner' : c.kind === 'department' ? this.isHr(s) : false,
        updatedAt: iso(c.last_message_at ?? c.created_at)!,
      });
    }
    return out;
  }

  /** The caller's conversations as the list shows them. */
  private async listFor(tx: TenantTx, s: Subject, q: { q?: string; kind?: string }) {
    const mine = await tx.collection('chat_members').distinct<string>('conversation_id', { membership_id: s.membershipId, left_at: null });
    const or: Doc[] = [{ id: { $in: mine } }, { kind: 'hr', employee_membership_id: s.membershipId }];
    if (this.isHr(s)) or.push({ kind: 'hr' });
    const convs = await tx.collection('chat_conversations').find(
      { $or: or, archived_at: null, ...(q.kind ? { kind: q.kind } : {}) },
      { sort: { last_message_at: -1, created_at: -1 }, limit: 200 },
    );
    // An HR conversation with no messages yet is only shown to the employee who opened it.
    const visible = convs.filter((c) => c.kind !== 'hr' || c.last_message_at || c.employee_membership_id === s.membershipId);
    let views = await this.views(tx, visible, s);
    if (q.q) {
      const needle = q.q.toLowerCase();
      views = views.filter((v) => v.title.toLowerCase().includes(needle) || v.members.some((m) => (m.name ?? '').toLowerCase().includes(needle)));
    }
    return views;
  }

  /** Your conversations, newest first. Also marks everything waiting for you as delivered. */
  conversations(q: { q?: string; kind?: string } = {}) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      await this.joinMyDepartments(tx, s);
      await tx.collection('chat_members').update({ membership_id: s.membershipId, left_at: null }, { $set: { last_delivered_at: new Date() } });
      if (this.isHr(s)) await this.deliverToHr(tx);
      const views = await this.listFor(tx, s, q);
      return { items: views, unread: views.reduce((n, v) => n + (v.muted ? 0 : v.unread), 0), isHr: this.isHr(s) };
    });
  }

  /** Total unread messages (for the menu badge). */
  unread() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const views = await this.listFor(tx, s, {});
      return { unread: views.reduce((n, v) => n + (v.muted ? 0 : v.unread), 0) };
    });
  }

  /** Starts a conversation, or returns the existing one for a direct message or an employee's HR conversation. */
  open(input: ConversationInput) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const convs = tx.collection('chat_conversations');
      const members = tx.collection('chat_members');
      const activeIds = async (ids: string[]) => new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: ids }, status: 'active' }));
      if (input.kind === 'direct') {
        if (input.membershipId === s.membershipId) throw Errors.badRequest('self', 'Choose someone else to message');
        if (!(await activeIds([input.membershipId])).size) throw Errors.badRequest('unknown_person', 'That person is not in the workspace');
        const key = [s.membershipId, input.membershipId].sort().join(':');
        const found = await convs.findOne({ direct_key: key });
        if (found) return { id: found.id as string, created: false };
        const c = await convs.insert({ kind: 'direct', direct_key: key, created_by_membership_id: s.membershipId });
        await members.insertMany([s.membershipId, input.membershipId].map((m) => ({ conversation_id: c.id, membership_id: m, role: 'member' })));
        return { id: c.id as string, created: true };
      }
      if (input.kind === 'hr') {
        const employee = input.membershipId && input.membershipId !== s.membershipId ? input.membershipId : s.membershipId;
        if (employee !== s.membershipId && !this.isHr(s)) throw Errors.forbidden('Only the HR team can start a conversation with an employee');
        if (!(await activeIds([employee])).size) throw Errors.badRequest('unknown_person', 'That person is not in the workspace');
        const found = await convs.findOne({ kind: 'hr', employee_membership_id: employee });
        if (found) return { id: found.id as string, created: false };
        const c = await convs.insert({ kind: 'hr', employee_membership_id: employee, title: '', created_by_membership_id: s.membershipId });
        await members.insert({ conversation_id: c.id, membership_id: employee, role: 'member' });
        return { id: c.id as string, created: true };
      }
      if (input.kind === 'group') {
        const ok = await activeIds(input.membershipIds);
        const ids = [...new Set([s.membershipId, ...input.membershipIds.filter((m) => ok.has(m))])];
        if (ids.length < 2) throw Errors.badRequest('too_few', 'Add at least one other person');
        const c = await convs.insert({ kind: 'group', title: input.title, created_by_membership_id: s.membershipId });
        await members.insertMany(ids.map((m) => ({ conversation_id: c.id, membership_id: m, role: m === s.membershipId ? 'owner' : 'member' })));
        const name = (await memberNames(tx, [s.membershipId])).get(s.membershipId) ?? 'Someone';
        await this.post(tx, c, null, `${name} created the group "${input.title}"`, [], true);
        await this.audit.record(tx, { action: 'chat.group_created', resourceType: 'chat_conversation', resourceId: c.id, changes: { title: input.title, members: ids.length } });
        return { id: c.id as string, created: true };
      }
      if (!this.isHr(s)) throw Errors.forbidden('Only the HR team can start a department conversation');
      const dept = await tx.collection('departments').findOne({ id: input.departmentId });
      if (!dept) throw Errors.badRequest('unknown_department', 'Choose a department');
      const found = await convs.findOne({ kind: 'department', department_id: input.departmentId, archived_at: null });
      if (found) return { id: found.id as string, created: false };
      const c = await convs.insert({ kind: 'department', department_id: input.departmentId, title: input.title || dept.name, created_by_membership_id: s.membershipId });
      await members.insert({ conversation_id: c.id, membership_id: s.membershipId, role: 'owner' });
      await this.syncDepartment(tx, c);
      await this.post(tx, c, null, `Conversation for everyone in ${dept.name}`, [], true);
      await this.audit.record(tx, { action: 'chat.department_created', resourceType: 'chat_conversation', resourceId: c.id, changes: { departmentId: input.departmentId } });
      return { id: c.id as string, created: true };
    });
  }

  /**
   * The chat of one of HR's groups (Communication > Groups): opened the first time it is asked for, with the group's
   * members in it and the person opening it as its owner. Afterwards it is the same conversation, and people added
   * to the group since join it (people who left the chat themselves are not pulled back in).
   */
  groupChat(groupId: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!this.isHr(s)) throw Errors.forbidden();
      const g = await tx.collection('comm_groups').findOne({ id: groupId, archived_at: null });
      if (!g) throw Errors.notFound('Group');
      const convs = tx.collection('chat_conversations');
      let conv = g.chat_conversation_id ? await convs.findOne({ id: g.chat_conversation_id, archived_at: null }) : undefined;
      let created = false;
      if (!conv) {
        conv = await convs.insert({ kind: 'group', title: (g.name as string).slice(0, 80), created_by_membership_id: s.membershipId });
        await tx.collection('comm_groups').updateOne({ id: groupId }, { $set: { chat_conversation_id: conv.id } });
        created = true;
      }
      await this.syncGroupChat(tx, conv, [...(g.membership_ids as string[]), s.membershipId], s.membershipId);
      if (created) {
        const name = (await memberNames(tx, [s.membershipId])).get(s.membershipId) ?? 'Someone';
        await this.post(tx, conv, null, `${name} opened the chat for the group "${g.name as string}"`, [], true);
        await this.audit.record(tx, { action: 'chat.group_created', resourceType: 'chat_conversation', resourceId: conv.id as string, changes: { title: g.name, fromGroup: groupId } });
      }
      return { id: conv.id as string, created };
    });
  }

  /** Adds the group's active members who were never in its chat. Owner is the person who opened it. */
  async syncGroupChat(tx: TenantTx, conv: Doc, membershipIds: string[], owner?: string) {
    const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: membershipIds }, status: 'active' }));
    const already = new Set(await tx.collection('chat_members').distinct<string>('membership_id', { conversation_id: conv.id }));
    const add = [...new Set(membershipIds)].filter((m) => active.has(m) && !already.has(m));
    if (add.length) await tx.collection('chat_members').insertMany(add.map((m) => ({ conversation_id: conv.id, membership_id: m, role: m === owner && !already.size ? 'owner' : 'member' })));
  }

  /** One conversation with its latest messages (oldest first), and what each of your messages has reached. */
  conversation(id: string, q: { before?: string; limit: number }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const { conv, member, asHr } = await this.access(tx, id, s);
      if (member) await tx.collection('chat_members').updateOne({ id: member.id }, { $set: { last_delivered_at: new Date() } });
      const rows = await tx.collection('chat_messages').find(
        { conversation_id: id, ...(q.before ? { created_at: { $lt: new Date(q.before) } } : {}) },
        { sort: { created_at: -1 }, limit: q.limit + 1 },
      );
      const page = rows.slice(0, q.limit).reverse();
      const view = (await this.views(tx, [conv], s))[0]!;
      return { conversation: { ...view, asHr }, messages: await this.messageViews(tx, conv, page, s), hasOlder: rows.length > q.limit };
    });
  }

  private async messageViews(tx: TenantTx, conv: Doc, rows: Doc[], s: Subject): Promise<ChatMessageView[]> {
    const names = await memberNames(tx, rows.map((m) => m.sender_membership_id));
    const files = await fileViews(tx, rows.flatMap((m) => (m.deleted_at ? [] : (m.file_ids as string[]))));
    // Read and received positions of everyone else, for the ticks on your own messages.
    const others = (await tx.collection('chat_members').find({ conversation_id: conv.id, left_at: null, membership_id: { $ne: s.membershipId } }, { projection: { membership_id: 1, last_read_at: 1, last_delivered_at: 1 } }));
    const hrTeamIds = conv.kind === 'hr' ? new Set(await hrTeam(tx)) : null;
    const delivery = (m: Doc): MessageDelivery => {
      const at = new Date(m.created_at).getTime();
      const reached = (d: Date | null | undefined) => !!d && new Date(d).getTime() >= at;
      let group = others;
      if (conv.kind === 'hr') {
        // The employee's message reaches HR when anyone in the team has it; HR's reaches the employee.
        const employeeSide = s.membershipId === conv.employee_membership_id;
        group = others.filter((o) => (employeeSide ? hrTeamIds!.has(o.membership_id) : o.membership_id === conv.employee_membership_id));
        if (employeeSide) {
          if (group.some((o) => reached(o.last_read_at))) return 'read';
          return reached(conv.hr_delivered_at) || group.some((o) => reached(o.last_delivered_at)) ? 'delivered' : 'sent';
        }
        if (!group.length) return 'sent';
      }
      if (!group.length) return 'sent';
      if (group.every((o) => reached(o.last_read_at))) return 'read';
      if (group.every((o) => reached(o.last_delivered_at) || reached(o.last_read_at))) return 'delivered';
      return 'sent';
    };
    return rows.map((m) => ({
      id: m.id, conversationId: m.conversation_id, senderMembershipId: m.sender_membership_id ?? null,
      senderName: m.sender_membership_id ? names.get(m.sender_membership_id) ?? null : null,
      body: m.deleted_at ? '' : m.body, files: m.deleted_at ? [] : (m.file_ids as string[]).map((f) => files.get(f)).filter((f): f is CommFile => !!f),
      createdAt: iso(m.created_at)!, editedAt: iso(m.edited_at), deleted: !!m.deleted_at, system: !!m.system,
      delivery: m.sender_membership_id === s.membershipId && !m.system ? delivery(m) : null,
    }));
  }

  /** Stores a message and tells everyone else in the conversation. */
  private async post(tx: TenantTx, conv: Doc, sender: string | null, body: string, fileIds: string[], system = false, clientId?: string) {
    const m = await tx.collection('chat_messages').insert({ conversation_id: conv.id, sender_membership_id: sender, body, file_ids: fileIds, system, client_id: clientId ?? null });
    const now = new Date(m.created_at ?? Date.now());
    await tx.collection('chat_conversations').updateOne({ id: conv.id }, { $set: { last_message_at: now, last_message: { body: preview(body, fileIds.length), senderMembershipId: sender, at: now } } });
    const audience = (await this.audience(tx, conv)).filter((a) => a.id !== sender);
    await this.notifications.signal(tx, [...audience.map((a) => a.id), sender], 'chat.message', { conversationId: conv.id, messageId: m.id, senderMembershipId: sender });
    if (!system && sender) {
      const name = (await memberNames(tx, [sender])).get(sender) ?? 'Someone';
      const where = conv.kind === 'group' || conv.kind === 'department' ? ` in ${conv.title}` : conv.kind === 'hr' && sender !== conv.employee_membership_id ? ' (HR team)' : conv.kind === 'hr' ? ' to HR' : '';
      await this.notifications.notify(tx, {
        membershipIds: audience.filter((a) => !a.muted).map((a) => a.id),
        kind: conv.kind === 'hr' ? 'chat.hr_message' : 'chat.message', category: 'communication',
        title: `New message from ${name}${where}`, body: preview(body, fileIds.length), link: chatLink(conv.id),
        dedupeKey: `chat:${conv.id}`, resource: { type: 'chat_conversation', id: conv.id }, actorMembershipId: sender,
      });
    }
    return m;
  }

  send(id: string, input: ChatMessageInput) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const { conv, member } = await this.access(tx, id, s);
      if (input.clientId) {
        const dup = await tx.collection('chat_messages').findOne({ sender_membership_id: s.membershipId, client_id: input.clientId });
        if (dup) return (await this.messageViews(tx, conv, [dup], s))[0]!;
      }
      if (input.fileIds.length) {
        const own = await tx.collection('comm_files').count({ id: { $in: input.fileIds }, uploaded_by_membership_id: s.membershipId });
        if (own !== new Set(input.fileIds).size) throw Errors.badRequest('unknown_file', 'Upload the files again and send');
      }
      const m = await this.post(tx, conv, s.membershipId, input.body, input.fileIds, false, input.clientId);
      const now = new Date();
      if (member) await tx.collection('chat_members').updateOne({ id: member.id }, { $set: { last_read_at: now, last_delivered_at: now } });
      else await tx.collection('chat_members').insert({ conversation_id: id, membership_id: s.membershipId, role: conv.kind === 'hr' ? 'hr' : 'member', last_read_at: now, last_delivered_at: now });
      return (await this.messageViews(tx, conv, [m], s))[0]!;
    });
  }

  /** You have read the conversation up to now: clears its unread count and notification, and tells the others. */
  read(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const { conv, member } = await this.access(tx, id, s);
      const now = new Date();
      if (member) await tx.collection('chat_members').updateOne({ id: member.id }, { $set: { last_read_at: now, last_delivered_at: now } });
      else await tx.collection('chat_members').insert({ conversation_id: id, membership_id: s.membershipId, role: conv.kind === 'hr' && conv.employee_membership_id !== s.membershipId ? 'hr' : 'member', last_read_at: now, last_delivered_at: now });
      await this.notifications.markReadByLink(tx, s.membershipId, chatLink(id));
      const others = (await this.audience(tx, conv)).map((a) => a.id).filter((x) => x !== s.membershipId);
      await this.notifications.signal(tx, others, 'chat.read', { conversationId: id, membershipId: s.membershipId, at: now.toISOString() });
      return { ok: true };
    });
  }

  /**
   * HR conversations reach "the HR team", which may not have opened them yet (so has no member row): mark the
   * employees' messages as received by HR when anyone in the team gets them.
   */
  private async deliverToHr(tx: TenantTx) {
    await tx.collection('chat_conversations').update({ kind: 'hr', last_message_at: { $ne: null }, archived_at: null }, { $set: { hr_delivered_at: new Date() } });
  }

  /** Your app has received new messages (called when a live message arrives), so senders see "Delivered". */
  delivered() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const rows = await tx.collection('chat_members').find({ membership_id: s.membershipId, left_at: null }, { projection: { conversation_id: 1 } });
      await tx.collection('chat_members').update({ membership_id: s.membershipId, left_at: null }, { $set: { last_delivered_at: new Date() } });
      const recent = new Date(Date.now() - 10 * 60_000);
      const hr = this.isHr(s);
      if (hr) await this.deliverToHr(tx);
      const convs = await tx.collection('chat_conversations').find(hr
        ? { $or: [{ id: { $in: rows.map((r) => r.conversation_id) } }, { kind: 'hr' }], last_message_at: { $gt: recent } }
        : { id: { $in: rows.map((r) => r.conversation_id) }, last_message_at: { $gt: recent } });
      for (const c of convs) {
        const others = (await this.audience(tx, c)).map((a) => a.id).filter((x) => x !== s.membershipId);
        await this.notifications.signal(tx, others, 'chat.read', { conversationId: c.id, membershipId: s.membershipId, delivered: true });
      }
      return { ok: true };
    });
  }

  /** Deletes your own message (the others see "Message deleted"). */
  deleteMessage(id: string, messageId: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const { conv } = await this.access(tx, id, s);
      const m = await tx.collection('chat_messages').findOne({ id: messageId, conversation_id: id });
      if (!m || m.system) throw Errors.notFound('Message');
      if (m.sender_membership_id !== s.membershipId) throw Errors.forbidden('You can delete only your own messages');
      await tx.collection('chat_messages').updateOne({ id: messageId }, { $set: { deleted_at: new Date(), body: '', file_ids: [] } });
      const others = (await this.audience(tx, conv)).map((a) => a.id);
      await this.notifications.signal(tx, others, 'chat.updated', { conversationId: id, messageId });
      return { ok: true };
    });
  }

  /** Renames a group or department conversation, or changes a group's members (the group's owner, or HR for departments). */
  manage(id: string, input: { title?: string; add?: string[]; remove?: string[] }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const { conv, member } = await this.access(tx, id, s);
      const owner = conv.kind === 'group' ? member?.role === 'owner' : conv.kind === 'department' && this.isHr(s);
      if (!owner) throw Errors.forbidden('Only the person who made the group can change it');
      const name = (await memberNames(tx, [s.membershipId])).get(s.membershipId) ?? 'Someone';
      if (input.title && input.title !== conv.title) {
        await tx.collection('chat_conversations').updateOne({ id }, { $set: { title: input.title } });
        await this.post(tx, { ...conv, title: input.title }, null, `${name} renamed the conversation to "${input.title}"`, [], true);
      }
      if (conv.kind === 'group' && (input.add?.length || input.remove?.length)) {
        const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: input.add ?? [] }, status: 'active' }));
        const names = await memberNames(tx, [...(input.add ?? []), ...(input.remove ?? [])]);
        for (const m of input.add ?? []) {
          if (!active.has(m)) continue;
          const row = await tx.collection('chat_members').findOne({ conversation_id: id, membership_id: m });
          if (row && !row.left_at) continue;
          if (row) await tx.collection('chat_members').updateOne({ id: row.id }, { $set: { left_at: null, joined_at: new Date() } });
          else await tx.collection('chat_members').insert({ conversation_id: id, membership_id: m, role: 'member' });
          await this.post(tx, conv, null, `${name} added ${names.get(m) ?? 'someone'}`, [], true);
        }
        for (const m of input.remove ?? []) {
          if (m === s.membershipId) continue;
          const n = await tx.collection('chat_members').update({ conversation_id: id, membership_id: m, left_at: null }, { $set: { left_at: new Date() } });
          if (n) await this.post(tx, conv, null, `${name} removed ${names.get(m) ?? 'someone'}`, [], true);
        }
      }
      await this.audit.record(tx, { action: 'chat.conversation_changed', resourceType: 'chat_conversation', resourceId: id, changes: input });
      return { ok: true };
    });
  }

  /** Leaves a group (its owner hands it to the longest-standing member). */
  leave(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const { conv, member } = await this.access(tx, id, s);
      if (conv.kind !== 'group' || !member) throw Errors.badRequest('cannot_leave', 'You can leave groups only');
      await tx.collection('chat_members').updateOne({ id: member.id }, { $set: { left_at: new Date() } });
      if (member.role === 'owner') {
        const next = await tx.collection('chat_members').findOne({ conversation_id: id, left_at: null }, { sort: { joined_at: 1 } });
        if (next) await tx.collection('chat_members').updateOne({ id: next.id }, { $set: { role: 'owner' } });
      }
      const name = (await memberNames(tx, [s.membershipId])).get(s.membershipId) ?? 'Someone';
      await this.post(tx, conv, null, `${name} left`, [], true);
      return { ok: true };
    });
  }

  /** Mutes or unmutes a conversation for you: messages still arrive, without notifications. */
  mute(id: string, muted: boolean) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const { conv, member } = await this.access(tx, id, s);
      if (member) await tx.collection('chat_members').updateOne({ id: member.id }, { $set: { muted } });
      else await tx.collection('chat_members').insert({ conversation_id: id, membership_id: s.membershipId, role: conv.kind === 'hr' ? 'hr' : 'member', muted });
      return { ok: true };
    });
  }

  /** Messages containing some text, in conversations you can see. */
  search(q: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const mine = await tx.collection('chat_members').distinct<string>('conversation_id', { membership_id: s.membershipId, left_at: null });
      const or: Doc[] = [{ id: { $in: mine } }, { kind: 'hr', employee_membership_id: s.membershipId }];
      if (this.isHr(s)) or.push({ kind: 'hr' });
      const convs = await tx.collection('chat_conversations').find({ $or: or, archived_at: null });
      const views = new Map((await this.views(tx, convs, s)).map((v) => [v.id, v]));
      const hits = await tx.collection('chat_messages').find(
        { conversation_id: { $in: convs.map((c) => c.id) }, deleted_at: null, system: false, body: ilike(q) },
        { sort: { created_at: -1 }, limit: 50 },
      );
      const names = await memberNames(tx, hits.map((h) => h.sender_membership_id));
      return {
        items: hits.map((h) => ({
          messageId: h.id, conversationId: h.conversation_id, conversationTitle: views.get(h.conversation_id)?.title ?? '',
          senderName: names.get(h.sender_membership_id) ?? null, body: h.body, createdAt: iso(h.created_at),
        })),
      };
    });
  }

  /** People you can message, for the new-conversation picker. */
  people(q: string | undefined) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const members = await tx.collection('memberships').find({ status: 'active', id: { $ne: s.membershipId } }, { projection: { employee_id: 1, user_id: 1 }, limit: 2000 });
      const names = await memberNames(tx, members.map((m) => m.id));
      const emps = new Map((await tx.collection('employees').find({ id: { $in: members.map((m) => m.employee_id).filter(Boolean) } }, { projection: { current_department_id: 1, current_designation_id: 1 } })).map((e) => [e.id as string, e]));
      const [depts, desigs] = await Promise.all([
        tx.collection('departments').find({}, { projection: { name: 1 } }),
        tx.collection('designations').find({}, { projection: { name: 1 } }),
      ]);
      const dn = new Map(depts.map((d) => [d.id as string, d.name as string]));
      const gn = new Map(desigs.map((d) => [d.id as string, d.name as string]));
      const needle = q?.toLowerCase();
      return {
        items: members
          .map((m) => {
            const e = m.employee_id ? emps.get(m.employee_id) : undefined;
            return { membershipId: m.id as string, name: names.get(m.id) ?? 'Unnamed', department: e ? dn.get(e.current_department_id) ?? null : null, designation: e ? gn.get(e.current_designation_id) ?? null : null };
          })
          .filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.department ?? '').toLowerCase().includes(needle) || (p.designation ?? '').toLowerCase().includes(needle))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 100),
      };
    });
  }

  /** The actor's membership id (for controllers that need it). */
  me() {
    return requestContext.tenantActor().membershipId;
  }
}
