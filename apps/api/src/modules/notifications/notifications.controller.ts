import { AllowWhenLocked, AllowWithoutMfa } from '../../platform/authz/decorators';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  NOTIFICATION_CATEGORY_KEYS, notificationListQuery, notificationPreferencesInput, notificationReadInput, resolveNotificationPreferences,
  type NotificationCategory,
} from '@crew/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requestContext } from '../../platform/context/request-context';
import { ilike, membershipUserNames, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { LiveService } from '../../platform/notify/live.service';
import { NotificationService, notificationView } from '../../platform/notify/notification.service';
import { Doc } from '../../platform/openapi/openapi';

/** Longest a live stream stays open; the browser reconnects at once, which also re-checks the session. */
const STREAM_MAX_MS = 15 * 60_000;
const HEARTBEAT_MS = 25_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function unreadCount(tx: TenantTx, me: string) {
  return tx.collection('notifications').count({ membership_id: me, read_at: null });
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
  @Doc({ summary: 'Your notification preferences: in-app and email per category, sound and pop-ups' })
  preferences() {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => resolveNotificationPreferences((await tx.collection('member_preferences').findOne({ membership_id: me }))?.notifications));
  }

  @Put('preferences')
  @Doc({ summary: 'Change your notification preferences', body: notificationPreferencesInput })
  setPreferences(@Body(new ZodPipe(notificationPreferencesInput)) body: z.infer<typeof notificationPreferencesInput>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => {
      const value = resolveNotificationPreferences(body);
      await tx.collection('member_preferences').upsert({ membership_id: me }, { membership_id: me, notifications: value }, { $set: { notifications: value, updated_at: new Date() } });
      return value;
    });
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
    const beat = setInterval(() => res.write(`: ping\n\n`), HEARTBEAT_MS);
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
