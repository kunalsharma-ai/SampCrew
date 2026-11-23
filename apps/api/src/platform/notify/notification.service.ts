import { Inject, Injectable } from '@nestjs/common';
import {
  categoryOfKind, inQuietHours, resolveNotificationPreferences, type NotificationCategory, type QuietHours, type NotificationPriority, type NotificationView,
} from '@crew/contracts';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { requestContext } from '../context/request-context';
import { type AnyTx, type PlatformTx, type TenantTx, usersTable } from '../database/mongo.service';

/**
 * One notification for one or more people. This is the API every module uses (see docs/architecture/notifications.md):
 *
 *   await this.notifications.notify(tx, { membershipIds: [m], kind: 'leave.approved', title: 'Leave approved', link: '/leave' });
 *
 * Only `membershipIds`, `kind` and `title` are needed. Everything else is optional and has a sensible default.
 */
export interface Notice {
  /** Recipients by workspace membership. Suspended members, duplicates and empty values are skipped. */
  membershipIds: (string | null | undefined)[];
  /** What happened, as `module.event` (e.g. `leave.approved`). The prefix decides the category unless one is given. */
  kind: string;
  title: string;
  body?: string;
  /** Path inside the Web Portal, e.g. /leave. Opening the notice goes there. */
  link?: string;
  /** Also send an email (queued in the same transaction, delivered by MailerService), unless the person turned email off for this category. */
  email?: boolean;
  /** Overrides the category worked out from `kind` (contracts NOTIFICATION_CATEGORIES). */
  category?: NotificationCategory;
  /** low, normal (default), high or urgent. High and urgent stand out in the bell and may play a sound. */
  priority?: NotificationPriority;
  /**
   * Repeated events with the same key fold into one unread notice per person instead of piling up (for example one
   * notice per chat conversation: "3 new messages from Asha"). The notice's text is replaced and its count goes up.
   */
  dedupeKey?: string;
  /** The record this is about, so its page can mark its notices read when opened. */
  resource?: { type: string; id: string };
  /** Who caused it; shown as "from" in the Notification Center. Defaults to nobody. */
  actorMembershipId?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** A stored notification as the API returns it; older rows without the newer fields get their derived values. */
export function notificationView(n: Doc, names?: Map<string, string | null>): NotificationView {
  return {
    id: n.id,
    kind: n.kind,
    category: (n.category as NotificationCategory | undefined) ?? categoryOfKind(n.kind),
    priority: (n.priority as NotificationPriority | undefined) ?? 'normal',
    title: n.title,
    body: n.body ?? null,
    link: n.link ?? null,
    count: n.count ?? 1,
    actorName: n.actor_membership_id ? names?.get(n.actor_membership_id) ?? null : null,
    readAt: n.read_at ?? null,
    createdAt: n.created_at,
    updatedAt: n.updated_at ?? n.created_at,
  };
}

/**
 * In-app notifications, their email copies, phone pushes and live updates. Everything is written in the caller's
 * transaction, so a notification exists if and only if the change that caused it was committed, and the live stream
 * only ever shows committed changes.
 */
@Injectable()
export class NotificationService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async notify(tx: TenantTx | PlatformTx, notice: Notice): Promise<number> {
    const ids = [...new Set(notice.membershipIds.filter((x): x is string => !!x))];
    if (!ids.length) return 0;
    const category = notice.category ?? categoryOfKind(notice.kind);
    const priority = notice.priority ?? 'normal';
    const memberships = await tx.collection('memberships').find({ id: { $in: ids } });
    const emails = new Map((await (await usersTable(tx)).find({ id: { $in: memberships.map((m) => m.user_id) } }, { projection: { email: 1 } })).map((u) => [u.id as string, u.email as string]));
    const resolved = new Map(
      (await tx.collection('member_preferences').find({ membership_id: { $in: ids } }, { projection: { membership_id: 1, notifications: 1 } }))
        .map((p) => [p.membership_id as string, resolveNotificationPreferences(p.notifications)]),
    );
    const prefs = new Map([...resolved].map(([id, p]) => [id, p.categories[category]]));
    const active = memberships.filter((m) => m.status === 'active').map((m) => ({ id: m.id as string, tenant_id: m.tenant_id as string, email: emails.get(m.user_id)! }));
    const live: Doc[] = [];
    // Who caused it, so their own open page does not pop up a notice about what they just did.
    const by = (() => { const a = requestContext.get()?.actor; return a?.kind === 'user' ? a.membershipId : null; })();
    for (const r of active) {
      const channel = prefs.get(r.id) ?? { inApp: true, email: true };
      if (channel.inApp) {
        const n = await this.store(tx, r, notice, category, priority);
        live.push({ tenant_id: r.tenant_id, membership_ids: [r.id], type: 'notification', data: { notificationId: n.id, folded: n.folded, by } });
        if (!n.folded) {
          // A push to each signed-in phone. It carries only the notification id; the app loads the text after sign-in.
          const devices = await tx.collection('mobile_devices').find({ membership_id: r.id, push_token: { $ne: null }, revoked_at: null }, { projection: { _id: 1, tenant_id: 1 } });
          if (devices.length) {
            // Quiet hours hold a phone push until they end (urgent notices go at once); the notice is in the app meanwhile.
            const quiet = resolved.get(r.id)?.quiet;
            const holdUntil = quiet && priority !== 'urgent' ? await this.quietUntil(tx, r.tenant_id, quiet) : null;
            await tx.collection('push_messages').insertMany(devices.map((d) => ({ tenant_id: d.tenant_id, mobile_device_id: d.id, notification_id: n.id, ...(holdUntil ? { next_attempt_at: holdUntil } : {}) })));
          }
        }
      }
      if (notice.email && (channel.email || category === 'system')) {
        const url = notice.link ? `${this.config.WEB_PUBLIC_URL}${notice.link}` : this.config.WEB_PUBLIC_URL;
        await this.queueEmail(tx, r.tenant_id, r.email, notice.title, `${notice.body ? `${notice.body}\n\n` : ''}Open SampCrew: ${url}`, notice.kind);
      }
    }
    if (live.length) await tx.collection('live_events').insertMany(live);
    return active.length;
  }

  /** When the person's quiet hours end, if they are in them now (read in the workspace's time zone), else null. */
  private async quietUntil(tx: TenantTx | PlatformTx, tenantId: string, q: QuietHours): Promise<Date | null> {
    if (!q.enabled) return null;
    let tz = 'UTC';
    try {
      tz = ((await tx.collection('tenants').findOne({ id: tenantId }, { projection: { timezone: 1 } }))?.timezone as string | undefined) ?? 'UTC';
    } catch {
      // Outside a workspace (Console) there is no tenant to read: UTC.
    }
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const now = Number(parts.find((x) => x.type === 'hour')!.value) * 60 + Number(parts.find((x) => x.type === 'minute')!.value);
    if (!inQuietHours(q, now)) return null;
    const end = Number(q.to.slice(0, 2)) * 60 + Number(q.to.slice(3, 5));
    return new Date(Date.now() + (((end - now + 1440) % 1440) || 1440) * 60_000);
  }

  /** Inserts the notice, or folds it into the person's unread notice with the same dedupe key. */
  private async store(tx: TenantTx | PlatformTx, r: { id: string; tenant_id: string }, notice: Notice, category: string, priority: string) {
    const now = new Date();
    const fields = {
      kind: notice.kind, title: notice.title, body: notice.body ?? null, link: notice.link ?? null, category, priority,
      resource_type: notice.resource?.type ?? null, resource_id: notice.resource?.id ?? null, actor_membership_id: notice.actorMembershipId ?? null, updated_at: now,
    };
    if (notice.dedupeKey) {
      const folded = await tx.collection('notifications').updateAndGet(
        { membership_id: r.id, dedupe_key: notice.dedupeKey, read_at: null },
        { $set: fields, $inc: { count: 1 } },
      );
      if (folded) return { id: folded.id as string, folded: true };
    }
    const n = await tx.collection('notifications').insert({ tenant_id: r.tenant_id, membership_id: r.id, dedupe_key: notice.dedupeKey ?? null, count: 1, ...fields });
    return { id: n.id as string, folded: false };
  }

  /**
   * Tells people's open browsers that something changed (no notification is stored), for example a chat message
   * they are looking at, or a read receipt. Written in the caller's transaction like everything else.
   */
  async signal(tx: TenantTx, membershipIds: (string | null | undefined)[], type: string, data: Record<string, unknown> = {}) {
    const ids = [...new Set(membershipIds.filter((x): x is string => !!x))];
    if (ids.length) await tx.collection('live_events').insert({ tenant_id: tx.tenantId, membership_ids: ids, type, data });
  }

  /** Marks read the caller's notices about one page or record (called when that page is opened). */
  async markReadByLink(tx: TenantTx, membershipId: string, link: string) {
    const n = await tx.collection('notifications').update({ membership_id: membershipId, link, read_at: null }, { $set: { read_at: new Date() } });
    if (n) await this.signal(tx, [membershipId], 'notifications.read');
    return n;
  }

  /**
   * Queues an email. `footer` replaces the default member footer, for example for job applicants, who have no
   * SampCrew account.
   */
  async queueEmail(tx: AnyTx, tenantId: string | null, to: string, subject: string, text: string, template: string, footer?: string) {
    const foot = footer ?? 'SampCrew by SAMPLEDGE. You received this because you have an account in a SampCrew workspace.';
    await tx.collection('email_messages').insert({ tenant_id: tenantId, to_email: to, subject, text_body: `${text}\n\n--\n${foot}`, template });
  }
}
