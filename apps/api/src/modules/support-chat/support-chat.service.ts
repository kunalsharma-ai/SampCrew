import { Injectable } from '@nestjs/common';
import {
  CONSOLE_TEAM_NAME,
  senderIdentity,
  type SenderLevel,
  type SupportCategory,
  type SupportConversationDetail,
  type SupportConversationInput,
  type SupportConversationView,
  type SupportDelivery,
  type SupportListQuery,
  type SupportMessageInput,
  type SupportMessageView,
  type SupportState,
  type SupportStatus,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { ilike, MongoService as DatabaseService, type PlatformTx, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { isSuperWorkspace, memberIdentities, superWorkspaceMembers } from '../communication/identity';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
type AnyTx = TenantTx | PlatformTx;

const PREVIEW = 140;
const preview = (body: string) => body.replace(/\s+/g, ' ').slice(0, PREVIEW);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const at = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);
export const supportLink = (id: string) => `/support/${id}`;
const PAGE = 100;

/** The viewing side: a Super Workspace member (membershipId) or a Console Admin (adminId). */
type Viewer = { side: 'workspace'; membershipId: string } | { side: 'console'; adminId: string };

/**
 * SampCrew Support chat between a company's Super Workspace and the Console Admin team. Messages live with the
 * company (tenant-scoped tables), so the workspace side only ever reads its own; the Console reads across companies
 * with its own permission (support:chat). HR Workspace and Employee Workspace members are refused on every call, and
 * an id from another company is simply not found.
 */
@Injectable()
export class SupportChatService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  // ----------------------------------------------------------------------------------------- shared views

  private state(c: Doc, side: Viewer['side'], unread: number): SupportState {
    if (c.status === 'resolved') return 'resolved';
    if (unread > 0) return 'unread';
    const ourLast = side === 'console' ? at(c.last_console_message_at) : at(c.last_workspace_message_at);
    const theirLast = side === 'console' ? at(c.last_workspace_message_at) : at(c.last_console_message_at);
    return theirLast > ourLast ? 'waiting' : 'replied';
  }

  /** Unread for the viewer: the other side's messages after their read position. */
  private async unreadCounts(tx: AnyTx, convs: Doc[], viewer: Viewer): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!convs.length) return out;
    const reads = viewer.side === 'workspace'
      ? new Map((await tx.collection('support_reads').find({ conversation_id: { $in: convs.map((c) => c.id) }, membership_id: viewer.membershipId }, { projection: { conversation_id: 1, last_read_at: 1 } })).map((r) => [r.conversation_id as string, r.last_read_at as Date | null]))
      : null;
    for (const c of convs) {
      const since = viewer.side === 'console' ? c.console_read_at : reads!.get(c.id);
      const otherSide = viewer.side === 'console' ? 'member' : 'console';
      const lastOther = viewer.side === 'console' ? c.last_workspace_message_at : c.last_console_message_at;
      if (!lastOther || (since && at(since) >= at(lastOther))) { out.set(c.id, 0); continue; }
      out.set(c.id, await tx.collection('support_messages').count({ tenant_id: c.tenant_id, conversation_id: c.id, sender_kind: otherSide, ...(since ? { created_at: { $gt: since } } : {}) }));
    }
    return out;
  }

  private async views(tx: AnyTx, convs: Doc[], viewer: Viewer): Promise<SupportConversationView[]> {
    if (!convs.length) return [];
    const unread = await this.unreadCounts(tx, convs, viewer);
    const tenants = new Map((await tx.collection('tenants').find({ id: { $in: [...new Set(convs.map((c) => c.tenant_id as string))] } }, { projection: { name: 1, slug: 1 } })).map((t) => [t.id as string, t]));
    const admins = viewer.side === 'console'
      ? new Map((await tx.collection('platform_admins').find({ id: { $in: convs.map((c) => c.handled_by_admin_id).filter(Boolean) } }, { projection: { full_name: 1 } })).map((a) => [a.id as string, a.full_name as string]))
      : new Map<string, string>();
    const firsts = await tx.collection('support_messages').aggregate([
      { $match: { conversation_id: { $in: convs.map((c) => c.id) }, sender_kind: { $ne: 'system' } } },
      { $sort: { created_at: 1 } },
      { $group: { _id: '$conversation_id', name: { $first: '$sender_name' }, level: { $first: '$sender_level' }, workspace: { $first: '$sender_workspace' } } },
    ]);
    const first = new Map(firsts.map((f) => [(f._id ?? f.id) as string, f]));
    return convs.map((c) => {
      const t = tenants.get(c.tenant_id);
      const f = first.get(c.id);
      const n = unread.get(c.id) ?? 0;
      return {
        id: c.id, number: c.number, subject: c.subject, category: c.category as SupportCategory, status: c.status as SupportStatus,
        state: this.state(c, viewer.side, n),
        workspace: { id: c.tenant_id, name: (t?.name as string) ?? 'Workspace', slug: (t?.slug as string) ?? '' },
        startedBy: f ? senderIdentity(f.name, f.level as SenderLevel, f.workspace ?? null) : null,
        lastMessage: c.last_message ? { body: c.last_message.body, senderName: c.last_message.senderName, fromConsole: !!c.last_message.fromConsole, at: iso(c.last_message.at)! } : null,
        unread: n,
        handledBy: viewer.side === 'console' && c.handled_by_admin_id ? admins.get(c.handled_by_admin_id) ?? null : null,
        createdAt: iso(c.created_at)!, updatedAt: iso(c.last_message_at ?? c.created_at)!,
      };
    });
  }

  private messageViews(c: Doc, rows: Doc[], viewer: Viewer): SupportMessageView[] {
    const delivery = (m: Doc): SupportDelivery => {
      const t = at(m.created_at);
      const [read, got] = m.sender_kind === 'console' ? [c.workspace_read_at, c.workspace_delivered_at] : [c.console_read_at, c.console_delivered_at];
      if (read && at(read) >= t) return 'read';
      if (got && at(got) >= t) return 'delivered';
      return 'sent';
    };
    return rows.map((m) => {
      const ourSide = viewer.side === 'console' ? m.sender_kind === 'console' : m.sender_kind === 'member';
      const mine = viewer.side === 'console' ? m.sender_admin_id === viewer.adminId : m.sender_membership_id === viewer.membershipId;
      return {
        id: m.id, conversationId: m.conversation_id,
        sender: senderIdentity(m.sender_name, m.sender_level as SenderLevel, m.sender_workspace ?? null),
        fromConsole: m.sender_kind === 'console', mine, ourSide, body: m.body, createdAt: iso(m.created_at)!,
        delivery: ourSide && m.sender_kind !== 'system' ? delivery(m) : null,
        system: m.sender_kind === 'system',
      };
    });
  }

  private async messages(tx: AnyTx, c: Doc, viewer: Viewer, before?: string) {
    const rows = await tx.collection('support_messages').find(
      { tenant_id: c.tenant_id, conversation_id: c.id, ...(before ? { created_at: { $lt: new Date(before) } } : {}) },
      { sort: { created_at: -1 }, limit: PAGE + 1 },
    );
    return { messages: this.messageViews(c, rows.slice(0, PAGE).reverse(), viewer), hasOlder: rows.length > PAGE };
  }

  /** Live events: the company's Super Workspace members, and/or the Console Admin team. */
  private async live(tx: AnyTx, tenantId: string, type: string, data: Record<string, unknown>, to: { workspace?: string[]; console?: boolean }) {
    if (to.workspace?.length) await tx.collection('live_events').insert({ tenant_id: tenantId, membership_ids: to.workspace, type, data });
    if (to.console) await tx.collection('live_events').insert({ tenant_id: tenantId, membership_ids: [], console: true, type, data });
  }

  private async store(tx: AnyTx, c: Doc, m: { kind: 'member' | 'console' | 'system'; membershipId?: string; adminId?: string; name: string; level: SenderLevel; workspace: string | null; body: string; clientId?: string }) {
    const row = await tx.collection('support_messages').insert({
      tenant_id: c.tenant_id, conversation_id: c.id, sender_kind: m.kind, sender_membership_id: m.membershipId ?? null, sender_admin_id: m.adminId ?? null,
      sender_name: m.name, sender_level: m.level, sender_workspace: m.workspace, body: m.body, client_id: m.clientId ?? null,
    });
    const now = new Date(row.created_at ?? Date.now());
    if (m.kind === 'system') return row;
    const fromConsole = m.kind === 'console';
    await tx.collection('support_conversations').updateOne({ id: c.id, tenant_id: c.tenant_id }, {
      $set: {
        last_message_at: now,
        last_message: { body: preview(m.body), senderName: m.name, fromConsole, at: now },
        ...(fromConsole
          ? { last_console_message_at: now, console_read_at: now, console_delivered_at: now, handled_by_admin_id: m.adminId }
          : { last_workspace_message_at: now, workspace_read_at: now, workspace_delivered_at: now }),
        // A new message reopens a resolved conversation.
        status: 'open', resolved_at: null,
      },
    });
    return row;
  }

  // ----------------------------------------------------------------------------------------- Super Workspace side

  /** The caller, refused unless they are on the Super Workspace level of this company. */
  private async workspaceViewer(tx: TenantTx): Promise<Viewer & { side: 'workspace' }> {
    const actor = requestContext.tenantActor();
    if (!(await isSuperWorkspace(tx, actor.membershipId))) throw Errors.forbidden('Only the Super Workspace can contact SampCrew Support');
    return { side: 'workspace', membershipId: actor.membershipId };
  }

  private async ownConversation(tx: TenantTx, id: string) {
    const c = await tx.collection('support_conversations').findOne({ id });
    if (!c) throw Errors.notFound('Conversation');
    return c;
  }

  private filterViews(views: SupportConversationView[], q: SupportListQuery) {
    const needle = q.q?.toLowerCase();
    return views.filter((v) => (!q.state || v.state === q.state) && (!needle || [v.subject, v.workspace.name, v.workspace.slug, v.lastMessage?.body, v.startedBy?.name, `#${v.number}`].some((f) => (f ?? '').toLowerCase().includes(needle))));
  }

  workspaceList(q: SupportListQuery) {
    return this.db.tenant(async (tx) => {
      const viewer = await this.workspaceViewer(tx);
      const convs = await tx.collection('support_conversations').find({}, { sort: { last_message_at: -1, created_at: -1 }, limit: 300 });
      // Listing marks the Console team's messages as received here.
      if (convs.some((c) => c.last_console_message_at)) await tx.collection('support_conversations').update({ last_console_message_at: { $ne: null } }, { $set: { workspace_delivered_at: new Date() } });
      const views = await this.views(tx, convs, viewer);
      return { items: this.filterViews(views, q), unread: views.reduce((n, v) => n + v.unread, 0) };
    });
  }

  workspaceUnread() {
    return this.db.tenant(async (tx) => {
      const actor = requestContext.tenantActor();
      if (!(await isSuperWorkspace(tx, actor.membershipId))) return { unread: 0, allowed: false };
      const convs = await tx.collection('support_conversations').find({ last_console_message_at: { $ne: null } }, { limit: 300 });
      const counts = await this.unreadCounts(tx, convs, { side: 'workspace', membershipId: actor.membershipId });
      return { unread: [...counts.values()].reduce((a, b) => a + b, 0), allowed: true };
    });
  }

  workspaceStart(input: SupportConversationInput) {
    return this.db.tenant(async (tx) => {
      const viewer = await this.workspaceViewer(tx);
      if (input.clientId) {
        const dup = await tx.collection('support_messages').findOne({ sender_membership_id: viewer.membershipId, client_id: input.clientId });
        if (dup) return { id: dup.conversation_id as string, created: false };
      }
      const number = (await tx.collection('support_conversations').count({})) + 1;
      const c = await tx.collection('support_conversations').insert({
        tenant_id: tx.tenantId, number, subject: input.subject, category: input.category, status: 'open', started_by_membership_id: viewer.membershipId,
      });
      await this.workspaceSendIn(tx, c, viewer, input.body, input.clientId);
      await this.audit.record(tx, { action: 'support_chat.started', resourceType: 'support_conversation', resourceId: c.id, changes: { subject: input.subject, category: input.category } });
      return { id: c.id as string, created: true };
    });
  }

  private async workspaceSendIn(tx: TenantTx, c: Doc, viewer: { membershipId: string }, body: string, clientId?: string) {
    const me = (await memberIdentities(tx, [viewer.membershipId])).get(viewer.membershipId);
    const row = await this.store(tx, c, { kind: 'member', membershipId: viewer.membershipId, name: me?.name ?? 'Super Workspace', level: 'super', workspace: me?.workspace ?? null, body, clientId });
    const now = new Date(row.created_at ?? Date.now());
    await tx.collection('support_reads').upsert(
      { conversation_id: c.id, membership_id: viewer.membershipId },
      { conversation_id: c.id, membership_id: viewer.membershipId, last_read_at: now, last_delivered_at: now },
      { $set: { last_read_at: now, last_delivered_at: now } },
    );
    const team = await superWorkspaceMembers(tx);
    await this.live(tx, tx.tenantId, 'support.message', { conversationId: c.id, messageId: row.id }, { workspace: team, console: true });
    return row;
  }

  workspaceConversation(id: string, before?: string) {
    return this.db.tenant(async (tx) => {
      const viewer = await this.workspaceViewer(tx);
      const c = await this.ownConversation(tx, id);
      if (c.last_console_message_at) {
        await tx.collection('support_conversations').updateOne({ id }, { $set: { workspace_delivered_at: new Date() } });
        c.workspace_delivered_at = new Date();
      }
      const [view] = await this.views(tx, [c], viewer);
      return { conversation: view!, ...(await this.messages(tx, c, viewer, before)) } satisfies SupportConversationDetail;
    });
  }

  workspaceSend(id: string, input: SupportMessageInput) {
    return this.db.tenant(async (tx) => {
      const viewer = await this.workspaceViewer(tx);
      const c = await this.ownConversation(tx, id);
      const dup = input.clientId ? await tx.collection('support_messages').findOne({ conversation_id: id, sender_membership_id: viewer.membershipId, client_id: input.clientId }) : undefined;
      const row = dup ?? (await this.workspaceSendIn(tx, c, viewer, input.body, input.clientId));
      const fresh = (await tx.collection('support_conversations').findOne({ id }))!;
      return this.messageViews(fresh, [row], viewer)[0]!;
    });
  }

  workspaceRead(id: string) {
    return this.db.tenant(async (tx) => {
      const viewer = await this.workspaceViewer(tx);
      const c = await this.ownConversation(tx, id);
      const now = new Date();
      await tx.collection('support_reads').upsert(
        { conversation_id: id, membership_id: viewer.membershipId },
        { conversation_id: id, membership_id: viewer.membershipId, last_read_at: now, last_delivered_at: now },
        { $set: { last_read_at: now, last_delivered_at: now } },
      );
      await tx.collection('support_conversations').updateOne({ id }, { $set: { workspace_read_at: now, workspace_delivered_at: now } });
      await this.notifications.markReadByLink(tx, viewer.membershipId, supportLink(id));
      await this.live(tx, tx.tenantId, 'support.read', { conversationId: id, side: 'workspace' }, { workspace: [viewer.membershipId], console: !!c.last_console_message_at });
      return { ok: true };
    });
  }

  workspaceStatus(id: string, status: SupportStatus) {
    return this.db.tenant(async (tx) => {
      const viewer = await this.workspaceViewer(tx);
      const c = await this.ownConversation(tx, id);
      if (c.status === status) return { ok: true };
      const me = (await memberIdentities(tx, [viewer.membershipId])).get(viewer.membershipId);
      await this.setStatus(tx, c, status, { kind: 'system', name: me?.name ?? 'Super Workspace', level: 'super', workspace: me?.workspace ?? null });
      return { ok: true };
    });
  }

  private async setStatus(tx: AnyTx, c: Doc, status: SupportStatus, by: { kind: 'system'; name: string; level: SenderLevel; workspace: string | null }) {
    await tx.collection('support_conversations').updateOne({ id: c.id, tenant_id: c.tenant_id }, { $set: { status, resolved_at: status === 'resolved' ? new Date() : null } });
    await this.store(tx, c, { ...by, body: status === 'resolved' ? `${by.name} marked this conversation resolved` : `${by.name} reopened this conversation` });
    await this.audit.record(tx, { tenantId: c.tenant_id, action: status === 'resolved' ? 'support_chat.resolved' : 'support_chat.reopened', resourceType: 'support_conversation', resourceId: c.id });
    const team = await superWorkspaceMembers(tx, c.tenant_id);
    await this.live(tx, c.tenant_id, 'support.changed', { conversationId: c.id, status }, { workspace: team, console: true });
  }

  // ----------------------------------------------------------------------------------------- Console side

  private consoleViewer(): Viewer & { side: 'console' } {
    return { side: 'console', adminId: requestContext.platformActor().adminId };
  }

  private async consoleConversation(tx: PlatformTx, id: string) {
    const c = await tx.collection('support_conversations').findOne({ id });
    if (!c) throw Errors.notFound('Conversation');
    return c;
  }

  consoleList(q: SupportListQuery) {
    return this.db.platform(async (tx) => {
      const viewer = this.consoleViewer();
      const filter: Doc = { ...(q.tenantId ? { tenant_id: q.tenantId } : {}) };
      if (q.q) {
        // Search covers company names, subjects and message text.
        const tenants = await tx.collection('tenants').distinct<string>('id', { $or: [{ name: ilike(q.q) }, { slug: ilike(q.q) }] });
        const inMessages = await tx.collection('support_messages').distinct<string>('conversation_id', { body: ilike(q.q), ...(q.tenantId ? { tenant_id: q.tenantId } : {}) });
        filter.$or = [{ tenant_id: { $in: tenants } }, { subject: ilike(q.q) }, { id: { $in: inMessages } }];
      }
      const convs = await tx.collection('support_conversations').find(filter, { sort: { last_message_at: -1, created_at: -1 }, limit: 500 });
      // Listing marks the workspaces' messages as received by the Console team.
      if (convs.some((c) => c.last_workspace_message_at)) await tx.collection('support_conversations').update({ id: { $in: convs.map((c) => c.id) }, last_workspace_message_at: { $ne: null } }, { $set: { console_delivered_at: new Date() } });
      const views = await this.views(tx, convs, viewer);
      const items = this.filterViews(views, { ...q, q: undefined });
      const counts = { all: views.length, unread: 0, waiting: 0, replied: 0, resolved: 0 } as Record<string, number>;
      for (const v of views) counts[v.state] = (counts[v.state] ?? 0) + 1;
      return { items, counts, unread: views.reduce((n, v) => n + v.unread, 0) };
    });
  }

  consoleUnread() {
    return this.db.platform(async (tx) => {
      const all = await tx.collection('support_conversations').find({ last_workspace_message_at: { $ne: null } }, { projection: { tenant_id: 1, last_workspace_message_at: 1, console_read_at: 1 }, sort: { last_message_at: -1 }, limit: 1000 });
      const convs = all.filter((c) => !c.console_read_at || at(c.last_workspace_message_at) > at(c.console_read_at));
      const counts = await this.unreadCounts(tx, convs, this.consoleViewer());
      return { unread: [...counts.values()].reduce((a, b) => a + b, 0), conversations: [...counts.values()].filter((n) => n > 0).length };
    });
  }

  consoleDetail(id: string, before?: string) {
    return this.db.platform(async (tx) => {
      const viewer = this.consoleViewer();
      const c = await this.consoleConversation(tx, id);
      if (c.last_workspace_message_at) {
        await tx.collection('support_conversations').updateOne({ id }, { $set: { console_delivered_at: new Date() } });
        c.console_delivered_at = new Date();
      }
      const [view] = await this.views(tx, [c], viewer);
      const t = await tx.collection('tenants').findOne({ id: c.tenant_id });
      const sub = await tx.collection('subscriptions').findOne({ tenant_id: c.tenant_id });
      const plan = sub ? await tx.collection('plans').findOne({ id: sub.plan_id }, { projection: { name: 1 } }) : undefined;
      const supers = await superWorkspaceMembers(tx, c.tenant_id);
      const users = await tx.collection('memberships').find({ tenant_id: c.tenant_id, id: { $in: supers } }, { projection: { user_id: 1 } });
      const names = (await tx.collection('users').find({ id: { $in: users.map((u) => u.user_id) } }, { projection: { full_name: 1 } })).map((u) => ({ name: (u.full_name as string) ?? 'Unnamed' }));
      const people = await tx.collection('memberships').count({ tenant_id: c.tenant_id, status: 'active' });
      return {
        conversation: view!,
        ...(await this.messages(tx, c, viewer, before)),
        workspaceInfo: t ? { status: t.status as string, plan: (plan?.name as string) ?? null, country: (t.country_code as string) ?? null, superWorkspace: names, people, createdAt: iso(t.created_at)! } : null,
      } satisfies SupportConversationDetail;
    });
  }

  private async adminName(tx: PlatformTx, adminId: string) {
    const a = await tx.collection('platform_admins').findOne({ id: adminId }, { projection: { full_name: 1 } });
    return (a?.full_name as string) ?? 'Console Admin';
  }

  consoleSend(id: string, input: SupportMessageInput) {
    return this.db.platform(async (tx) => {
      const viewer = this.consoleViewer();
      const c = await this.consoleConversation(tx, id);
      const dup = input.clientId ? await tx.collection('support_messages').findOne({ tenant_id: c.tenant_id, conversation_id: id, sender_admin_id: viewer.adminId, client_id: input.clientId }) : undefined;
      if (dup) return this.messageViews(c, [dup], viewer)[0]!;
      const name = await this.adminName(tx, viewer.adminId);
      const row = await this.store(tx, c, { kind: 'console', adminId: viewer.adminId, name, level: 'console', workspace: CONSOLE_TEAM_NAME, body: input.body, clientId: input.clientId });
      const team = await superWorkspaceMembers(tx, c.tenant_id);
      await this.notifications.notify(tx, {
        membershipIds: team, kind: 'support.reply', category: 'communication',
        title: `${name} (Console Admin) replied: ${c.subject}`, body: preview(input.body), link: supportLink(id),
        dedupeKey: `support:${id}`, resource: { type: 'support_conversation', id },
      });
      await this.live(tx, c.tenant_id, 'support.message', { conversationId: id, messageId: row.id }, { workspace: team, console: true });
      await this.audit.record(tx, { tenantId: c.tenant_id, action: 'support_chat.replied', resourceType: 'support_conversation', resourceId: id });
      const fresh = (await tx.collection('support_conversations').findOne({ id }))!;
      return this.messageViews(fresh, [row], viewer)[0]!;
    });
  }

  /** Console Admins read as a team: marks the conversation read (or unread again) for every Console Admin. */
  consoleRead(id: string, read: boolean) {
    return this.db.platform(async (tx) => {
      const c = await this.consoleConversation(tx, id);
      const now = new Date();
      if (read) await tx.collection('support_conversations').updateOne({ id }, { $set: { console_read_at: now, console_delivered_at: now } });
      else {
        // Unread again: the read position goes back to just before the workspace's last message.
        const last = c.last_workspace_message_at ? new Date(at(c.last_workspace_message_at) - 1) : null;
        await tx.collection('support_conversations').updateOne({ id }, { $set: { console_read_at: last } });
      }
      const team = read && c.last_workspace_message_at ? await superWorkspaceMembers(tx, c.tenant_id) : [];
      await this.live(tx, c.tenant_id, 'support.read', { conversationId: id, side: 'console', read }, { workspace: team, console: true });
      return { ok: true };
    });
  }

  consoleStatus(id: string, status: SupportStatus) {
    return this.db.platform(async (tx) => {
      const viewer = this.consoleViewer();
      const c = await this.consoleConversation(tx, id);
      if (c.status === status) return { ok: true };
      await this.setStatus(tx, c, status, { kind: 'system', name: await this.adminName(tx, viewer.adminId), level: 'console', workspace: CONSOLE_TEAM_NAME });
      return { ok: true };
    });
  }
}
