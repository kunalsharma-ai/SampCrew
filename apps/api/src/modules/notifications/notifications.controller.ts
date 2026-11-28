import { AllowWhenLocked, AllowWithoutMfa } from '../../platform/authz/decorators';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  DEFAULT_NOTIFICATION_POLICY, NOTIFICATION_CATEGORY_KEYS, notificationListQuery, notificationPolicyInput, notificationPreferencesInput, notificationReadInput,
  resolveNotificationPreferences, type NotificationCategory, type NotificationPolicy,
} from '@crew/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { ilike, membershipUserNames, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { LiveService } from '../../platform/notify/live.service';
import { NotificationService, notificationView } from '../../platform/notify/notification.service';
import { touchPresence } from '../../platform/notify/presence';
import { Doc } from '../../platform/openapi/openapi';
import { isSuperWorkspace } from '../communication/identity';

/** Longest a live stream stays open; the browser reconnects at once, which also re-checks the session. */
const STREAM_MAX_MS = 15 * 60_000;
const HEARTBEAT_MS = 25_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function unreadCount(tx: TenantTx, me: string) {
  return tx.collection('notifications').count({ membership_id: me, read_at: null });
}

/** The workspace's notification policy (Super Workspace), or the default one when it never saved one. */
export async function notificationPolicy(tx: TenantTx): Promise<NotificationPolicy> {
  const row = await tx.collection('notification_policies').findOne({});
  return notificationPolicyInput.safeParse(row?.policy ?? {}).data ?? DEFAULT_NOTIFICATION_POLICY;
}

/** Only what a person chose is stored, never the organisation's locks (they are applied when read). */
function storable(p: ReturnType<typeof resolveNotificationPreferences>) {
  const { locks: _locks, customised: _customised, ...rest } = p;
  return rest;
}

/**
 * The signed-in member's notifications: the bell, the Notification Center, preferences and the live stream. Everyone
 * sees only their own. Notifications are raised by modules through NotificationService (docs/notifications.md).
 */
@Controller('notifications')
@AllowWhenLocked()
export class NotificationsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly live: LiveService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Doc({ summary: 'Your notifications, newest first; filter by unread, category, priority or text, page with `before`', query: notificationListQuery })
  list(@Query(new ZodPipe(notificationListQuery)) q: z.infer<typeof notificationListQuery>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => {
      const notes = tx.collection('notifications');
      const filter: Row = { membership_id: me };
      if (q.unread === 'true') filter.read_at = null;
      if (q.unread === 'false') filter.read_at = { $ne: null };
      if (q.action === 'true') filter.action_required = true;
      if (q.category) filter.category = q.category;
      if (q.priority) filter.priority = q.priority;
      if (q.q) filter.$or = [{ title: ilike(q.q) }, { body: ilike(q.q) }];
      if (q.before) filter.updated_at = { $lt: new Date(q.before) };
      const items = await notes.find(filter, { sort: { updated_at: -1, created_at: -1 }, limit: q.limit + 1 });
      const names = await membershipUserNames(tx, items.map((n) => n.actor_membership_id));
      const page = items.slice(0, q.limit).map((n) => notificationView(n, names));
      return { unread: await unreadCount(tx, me), items: page, nextBefore: items.length > q.limit ? page.at(-1)!.updatedAt : null };
    });
  }

  @Get('unread-count')
  @Doc({ summary: 'Number of unread notifications' })
  count() {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => ({ unread: await unreadCount(tx, me) }));
  }

  @Get('summary')
  @Doc({ summary: 'Unread and total notifications per category, and the latest important unread ones (Home and the Notification Center)' })
  summary() {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => {
      const notes = tx.collection('notifications');
      const rows = await notes.aggregate<{ id: string; total: number; unread: number }>([
        { $match: { membership_id: me } },
        { $group: { _id: { $ifNull: ['$category', 'legacy'] }, total: { $sum: 1 }, unread: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$read_at', null] }, null] }, 1, 0] } } } },
      ]);
      const by = new Map<string, { total: number; unread: number }>(NOTIFICATION_CATEGORY_KEYS.map((k) => [k, { total: 0, unread: 0 }]));
      for (const r of rows) {
        if (r.id === 'legacy') continue;
        by.set(r.id, { total: r.total, unread: r.unread });
      }
      const important = await notes.find({ membership_id: me, read_at: null, priority: { $in: ['high', 'urgent'] } }, { sort: { updated_at: -1 }, limit: 5 });
      return {
        unread: await unreadCount(tx, me),
        /** Unread notices that ask this person to act. */
        actionNeeded: await notes.count({ membership_id: me, read_at: null, action_required: true }),
        categories: [...by.entries()].map(([category, c]) => ({ category: category as NotificationCategory, ...c })),
        important: important.map((n) => notificationView(n)),
      };
    });
  }

  @Post(':id/read')
  @HttpCode(204)
  @Doc({ summary: 'Mark one notification read' })
  async read(@Param('id', UuidPipe) id: string) {
    const me = requestContext.tenantActor().membershipId;
    const found = await this.db.tenant(async (tx) => {
      const notes = tx.collection('notifications');
      if (!(await notes.exists({ id, membership_id: me }))) return false;
      if (await notes.updateOne({ id, read_at: null }, { $set: { read_at: new Date() } })) await this.notifications.signal(tx, [me], 'notifications.read');
      return true;
    });
    if (!found) throw Errors.notFound('Notification');
  }

  @Post(':id/unread')
  @HttpCode(204)
  @Doc({ summary: 'Mark one notification unread again' })
  async unread(@Param('id', UuidPipe) id: string) {
    const me = requestContext.tenantActor().membershipId;
    const found = await this.db.tenant(async (tx) => {
      const notes = tx.collection('notifications');
      const n = await notes.findOne({ id, membership_id: me });
      if (!n) return false;
      // Another unread notice may already hold the same fold key; this one then stays read.
      if (n.read_at && !(n.dedupe_key && (await notes.exists({ membership_id: me, dedupe_key: n.dedupe_key, read_at: null })))) {
        await notes.updateOne({ id }, { $set: { read_at: null } });
        await this.notifications.signal(tx, [me], 'notifications.read');
      }
      return true;
    });
    if (!found) throw Errors.notFound('Notification');
  }

  @Post('read-all')
  @HttpCode(204)
  @Doc({ summary: 'Mark all your notifications read, or those of one category, or those about one page', body: notificationReadInput })
  async readAll(@Body(new ZodPipe(notificationReadInput)) body: z.infer<typeof notificationReadInput>) {
    const me = requestContext.tenantActor().membershipId;
    await this.db.tenant(async (tx) => {
      const filter: Row = { membership_id: me, read_at: null };
      if (body?.category) filter.category = body.category;
      if (body?.link) filter.link = body.link;
      if (await tx.collection('notifications').update(filter, { $set: { read_at: new Date() } })) await this.notifications.signal(tx, [me], 'notifications.read');
    });
  }

  @Get('preferences')
  @AllowWithoutMfa()
  @Doc({ summary: 'Your notification preferences: in app, email, phone push and sound per category, sound, pop-ups, desktop and quiet hours, with what your organisation locked (`locks`)' })
  preferences() {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => resolveNotificationPreferences((await tx.collection('member_preferences').findOne({ membership_id: me }))?.notifications, await notificationPolicy(tx)));
  }

  @Put('preferences')
  @Doc({ summary: 'Change your notification preferences (anything your organisation locked stays as it decided)', body: notificationPreferencesInput })
  setPreferences(@Body(new ZodPipe(notificationPreferencesInput)) body: z.infer<typeof notificationPreferencesInput>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => {
      const policy = await notificationPolicy(tx);
      // The person's own choices are kept as they made them; the policy is applied when they are read, so a choice
      // the organisation overrides now comes back if the organisation relaxes its policy later.
      const value = storable(resolveNotificationPreferences(body));
      await tx.collection('member_preferences').upsert({ membership_id: me }, { membership_id: me, notifications: value }, { $set: { notifications: value, updated_at: new Date() } });
      return resolveNotificationPreferences(value, policy);
    });
  }

  @Get('policy')
  @Doc({ summary: "Your organisation's notification policy (Super Workspace only): categories everyone sees, required emails, whether sound, desktop and phone push are allowed, starting choices" })
  async policy() {
    return this.db.tenant(async (tx) => {
      await this.superOnly(tx);
      const row = await tx.collection('notification_policies').findOne({});
      return { policy: await notificationPolicy(tx), updatedAt: row?.updated_at ?? null, members: await tx.collection('memberships').count({ status: 'active' }) };
    });
  }

  @Put('policy')
  @Doc({ summary: "Change your organisation's notification policy (Super Workspace only). It applies to everyone at once, above their own settings.", body: notificationPolicyInput })
  setPolicy(@Body(new ZodPipe(notificationPolicyInput)) body: z.infer<typeof notificationPolicyInput>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => {
      await this.superOnly(tx);
      const before = await notificationPolicy(tx);
      const policy = notificationPolicyInput.parse(body);
      await tx.collection('notification_policies').upsert({}, { policy, updated_by: me }, { $set: { policy, updated_by: me } });
      await this.audit.record(tx, { action: 'notifications.policy_changed', resourceType: 'notification_policy', resourceId: tx.tenantId, changes: { from: before, to: policy } });
      // Everyone's open pages pick up the new rules (locked switches, sound) on their next refresh.
      const everyone = await tx.collection('memberships').distinct<string>('id', { status: 'active' });
      await this.notifications.signal(tx, everyone, 'notifications.policy');
      const row = await tx.collection('notification_policies').findOne({});
      return { policy, updatedAt: row?.updated_at ?? null, members: everyone.length };
    });
  }

  private async superOnly(tx: TenantTx) {
    if (!(await isSuperWorkspace(tx, requestContext.tenantActor().membershipId))) throw Errors.forbidden('Only the Super Workspace can change the notification policy');
  }

  /**
   * Server-sent events for the signed-in member: new notifications (with the unread count), read changes, chat
   * messages and read receipts. The Web Portal proxies it at /live. The stream closes after 15 minutes and the browser
   * reconnects, so a signed-out session stops receiving events soon after.
   */
  @Get('stream')
  @Doc({ summary: 'Live updates (text/event-stream): notifications, read changes, chat messages and read receipts' })
  stream(@Req() req: Request, @Res() res: Response) {
    const actor = requestContext.tenantActor();
    const scope = { tenantId: actor.tenantId, userId: actor.userId };
    res.status(200).set({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const send = (type: string, data: unknown) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // A queue keeps events in order while each notification is loaded.
    let chain = Promise.resolve();
    const sub = this.live.subscribe(actor.tenantId, actor.membershipId).subscribe((m) => {
      chain = chain.then(async () => {
        try {
          if (m.type === 'notification') {
            const out = await this.db.tenant(async (tx) => {
              const n = await tx.collection('notifications').findOne({ id: m.data.notificationId, membership_id: actor.membershipId });
              if (!n) return null;
              const names = await membershipUserNames(tx, [n.actor_membership_id]);
              return { notification: notificationView(n, names), folded: Boolean(m.data.folded), self: m.data.by === actor.membershipId, unread: await unreadCount(tx, actor.membershipId) };
            }, scope);
            if (out) send('notification', out);
          } else if (m.type === 'notifications.read') {
            send('notifications.read', { unread: await this.db.tenant((tx) => unreadCount(tx, actor.membershipId), scope) });
          } else send(m.type, m.data);
        } catch {
          // A failed lookup skips one event; the browser refreshes its counts on the next one.
        }
      });
    });
    send('ready', { at: new Date().toISOString() });
    // The open stream is what "online" means in the chat: stamp it now and on every heartbeat.
    void touchPresence(this.db, scope, actor.membershipId);
    const beat = setInterval(() => {
      res.write(`: ping\n\n`);
      void touchPresence(this.db, scope, actor.membershipId);
    }, HEARTBEAT_MS);
    const end = setTimeout(() => res.end(), STREAM_MAX_MS);
    const close = () => {
      clearInterval(beat);
      clearTimeout(end);
      sub.unsubscribe();
    };
    req.on('close', close);
    res.on('close', close);
  }
}
