import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { type AnyTx, type PlatformTx, type TenantTx, usersTable } from '../database/mongo.service';

export interface Notice {
  /** Recipients by workspace membership. Suspended members are skipped. */
  membershipIds: (string | null | undefined)[];
  kind: string;
  title: string;
  body?: string;
  /** Path inside the Web Portal, e.g. /leave. */
  link?: string;
  /** Also send an email (queued in the same transaction, delivered by MailerService). */
  email?: boolean;
}

/**
 * In-app notifications and their email copies. Both are written in the caller's transaction, so a
 * notification exists if and only if the change that caused it was committed.
 */
@Injectable()
export class NotificationService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async notify(tx: TenantTx | PlatformTx, notice: Notice): Promise<number> {
    const ids = [...new Set(notice.membershipIds.filter((x): x is string => !!x))];
    if (!ids.length) return 0;
    const memberships = await tx.collection('memberships').find({ id: { $in: ids } });
    const emails = new Map((await (await usersTable(tx)).find({ id: { $in: memberships.map((m) => m.user_id) } }, { projection: { email: 1 } })).map((u) => [u.id as string, u.email as string]));
    const active = memberships.filter((m) => m.status === 'active').map((m) => ({ id: m.id as string, tenant_id: m.tenant_id as string, email: emails.get(m.user_id)! }));
    for (const r of active) {
      const n = await tx.collection('notifications').insert({ tenant_id: r.tenant_id, membership_id: r.id, kind: notice.kind, title: notice.title, body: notice.body ?? null, link: notice.link ?? null });
      // A push to each signed-in phone. It carries only the notification id; the app loads the text after sign-in.
      const devices = await tx.collection('mobile_devices').find({ membership_id: r.id, push_token: { $ne: null }, revoked_at: null }, { projection: { _id: 1, tenant_id: 1 } });
      if (devices.length) await tx.collection('push_messages').insertMany(devices.map((d) => ({ tenant_id: d.tenant_id, mobile_device_id: d.id, notification_id: n.id })));
      if (notice.email) {
        const url = notice.link ? `${this.config.WEB_PUBLIC_URL}${notice.link}` : this.config.WEB_PUBLIC_URL;
        await this.queueEmail(tx, r.tenant_id, r.email, notice.title, `${notice.body ? `${notice.body}\n\n` : ''}Open SampCrew: ${url}`, notice.kind);
      }
    }
    return active.length;
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
