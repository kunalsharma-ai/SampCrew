import { Injectable } from '@nestjs/common';
import {
  CONSOLE_NOTIFICATION_CAP, CONSOLE_NOTIFICATION_CATEGORIES, type ConsoleNotification, type ConsoleNotificationCategory, type ConsoleNotificationPrefs, type ConsoleNotificationSummary,
} from '@crew/contracts';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';

interface Row { id: string; category: ConsoleNotificationCategory; kind: string; priority: ConsoleNotification['priority']; title: string; body: string | null; href: string | null; company_id: string | null; tenant_id: string | null; created_at: Date }

const DEFAULT_PREFS: ConsoleNotificationPrefs = { muted: [], sound: false, desktop: false };

/**
 * The reading side of Console notifications: the bell, the menu badges, the dashboard panel and the history page all
 * read this. An admin sees only categories their role allows; muted categories stay in the history but leave the
 * badge. Unread means created after the admin joined and after their last "Mark all as read", and not read since.
 */
@Injectable()
export class ConsoleNotificationsService {
  constructor(private readonly db: DatabaseService) {}

  private visible(): ConsoleNotificationCategory[] {
    const perms = requestContext.platformActor().permissions;
    return CONSOLE_NOTIFICATION_CATEGORIES.filter((c) => perms.includes(CONSOLE_NOTIFICATION_CAP[c]));
  }

  private async me(tx: PlatformTx) {
    const a = requestContext.platformActor();
    const row = await tx.collection<{ created_at: Date; notifications_read_before: Date | null; notification_prefs: Partial<ConsoleNotificationPrefs> | null }>('platform_admins').findOne({ id: a.adminId });
    const prefs = { ...DEFAULT_PREFS, ...(row?.notification_prefs ?? {}) };
    const since = Math.max(row?.created_at?.getTime() ?? 0, row?.notifications_read_before?.getTime() ?? 0);
    return { adminId: a.adminId, prefs, since: new Date(since) };
  }

  summary(): Promise<ConsoleNotificationSummary> {
    return this.db.platform(async (tx) => {
      const me = await this.me(tx);
      const cats = this.visible().filter((c) => !me.prefs.muted.includes(c));
      const read = await tx.collection('platform_notification_reads').distinct<string>('notification_id', { admin_id: me.adminId });
      const match = { category: { $in: cats }, created_at: { $gt: me.since }, _id: { $nin: read } };
      const groups = await tx.collection('platform_notifications').aggregate<{ id: ConsoleNotificationCategory; n: number }>([{ $match: match }, { $group: { _id: '$category', n: { $sum: 1 } } }]);
      const byCategory = Object.fromEntries(groups.map((g) => [g.id, g.n]));
      const latest = await tx.collection<Row>('platform_notifications').find({ category: { $in: this.visible() } }, { sort: { created_at: -1 }, limit: 8 });
      return { unread: groups.reduce((a, g) => a + g.n, 0), byCategory, latest: await this.views(tx, latest, me.since, new Set(read)), prefs: me.prefs };
    });
  }

  list(q: { category?: ConsoleNotificationCategory; unread?: 'true' | 'false'; before?: string; limit: number }) {
    return this.db.platform(async (tx) => {
      const me = await this.me(tx);
      const cats = this.visible();
      const read = new Set(await tx.collection('platform_notification_reads').distinct<string>('notification_id', { admin_id: me.adminId }));
      const filter: Record<string, unknown> = { category: q.category ? (cats.includes(q.category) ? q.category : '__none__') : { $in: cats } };
      if (q.before) filter.created_at = { $lt: new Date(q.before) };
      if (q.unread === 'true') {
        filter.created_at = { ...((filter.created_at as object) ?? {}), $gt: me.since };
        filter.id = { $nin: [...read] };
      }
      const rows = await tx.collection<Row>('platform_notifications').find(filter, { sort: { created_at: -1 }, limit: q.limit + 1 });
      const items = await this.views(tx, rows.slice(0, q.limit), me.since, read);
      return { items, next: rows.length > q.limit ? items.at(-1)!.createdAt : null, categories: cats };
    });
  }

  markRead(ids: string[]) {
    return this.db.platform(async (tx) => {
      const me = await this.me(tx);
      const known = await tx.collection('platform_notifications').distinct<string>('id', { id: { $in: ids }, category: { $in: this.visible() } });
      for (const id of known) {
        if (!(await tx.collection('platform_notification_reads').exists({ admin_id: me.adminId, notification_id: id }))) await tx.collection('platform_notification_reads').insert({ admin_id: me.adminId, notification_id: id });
      }
      return { read: known.length };
    });
  }

  markUnread(ids: string[]) {
    return this.db.platform(async (tx) => {
      const me = await this.me(tx);
      const n = await tx.collection('platform_notification_reads').delete({ admin_id: me.adminId, notification_id: { $in: ids } });
      return { unread: n };
    });
  }

  markAllRead() {
    return this.db.platform(async (tx) => {
      const me = await this.me(tx);
      const now = new Date();
      await tx.collection('platform_admins').updateOne({ id: me.adminId }, { $set: { notifications_read_before: now } });
      // Individual reads before that moment are covered by it now.
      await tx.collection('platform_notification_reads').delete({ admin_id: me.adminId, read_at: { $lte: now } });
      return { at: now.toISOString() };
    });
  }

  setPrefs(prefs: ConsoleNotificationPrefs) {
    return this.db.platform(async (tx) => {
      const me = await this.me(tx);
      await tx.collection('platform_admins').updateOne({ id: me.adminId }, { $set: { notification_prefs: prefs } });
      return prefs;
    });
  }

  private async views(tx: PlatformTx, rows: Row[], since: Date, read: Set<string>): Promise<ConsoleNotification[]> {
    const names = new Map((await tx.collection<{ id: string; name: string }>('companies').find({ id: { $in: [...new Set(rows.map((r) => r.company_id).filter(Boolean))] } }, { projection: { name: 1 } })).map((c) => [c.id, c.name]));
    return rows.map((r) => ({
      id: r.id, category: r.category, kind: r.kind, priority: r.priority, title: r.title, body: r.body ?? null, href: r.href ?? null, clientId: r.company_id ?? null, tenantId: r.tenant_id ?? null,
      companyName: r.company_id ? names.get(r.company_id) ?? null : null, createdAt: r.created_at.toISOString(), read: r.created_at <= since || read.has(r.id),
    }));
  }
}
