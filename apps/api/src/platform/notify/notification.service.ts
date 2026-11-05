import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { many, type Tx } from '../database/database.service';

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

  async notify(tx: Tx, notice: Notice): Promise<number> {
    const ids = [...new Set(notice.membershipIds.filter((x): x is string => !!x))];
    if (!ids.length) return 0;
    const recipients = await many<{ id: string; email: string; tenant_id: string; status: string }>(
      tx,
      `select m.id, u.email::text as email, m.tenant_id, m.status from memberships m join users u on u.id = m.user_id where m.id = any($1::uuid[])`,
      [ids],
    );
    const active = recipients.filter((r) => r.status === 'active');
    for (const r of active) {
      await tx.query(
        `insert into notifications (tenant_id, membership_id, kind, title, body, link) values ($1, $2, $3, $4, $5, $6)`,
        [r.tenant_id, r.id, notice.kind, notice.title, notice.body ?? null, notice.link ?? null],
      );
      if (notice.email) {
        const url = notice.link ? `${this.config.WEB_PUBLIC_URL}${notice.link}` : this.config.WEB_PUBLIC_URL;
        await this.queueEmail(tx, r.tenant_id, r.email, notice.title, `${notice.body ? `${notice.body}\n\n` : ''}Open CREW: ${url}`, notice.kind);
      }
    }
    return active.length;
  }

  async queueEmail(tx: Tx, tenantId: string | null, to: string, subject: string, text: string, template: string) {
    await tx.query(
      `insert into email_messages (tenant_id, to_email, subject, text_body, template) values ($1, $2, $3, $4, $5)`,
      [tenantId, to, subject, `${text}\n\n--\nCREW by SAMPLEDGE. You received this because you have an account in a CREW workspace.`, template],
    );
  }
}
