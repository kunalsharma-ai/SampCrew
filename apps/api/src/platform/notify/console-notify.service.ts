import { Injectable, Logger } from '@nestjs/common';
import { CONSOLE_NOTIFICATION_CAP, type ConsoleNotificationCategory, type ConsoleNotificationPriority } from '@crew/contracts';
import { MongoService as DatabaseService, PlatformTx } from '../database/mongo.service';

export interface ConsoleNotifyInput {
  category: ConsoleNotificationCategory;
  /** A stable event name, such as payment.failed or company.created. */
  kind: string;
  priority?: ConsoleNotificationPriority;
  title: string;
  body?: string | null;
  /** Where the notification leads in the Console (a path such as /clients/<id>?tab=billing). `:company` is replaced by the company id. */
  href?: string | null;
  tenantId?: string | null;
  companyId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** The same key is only ever notified once (reminders that a job may try again). */
  dedupeKey?: string | null;
}

/**
 * Console notifications: writes one row per event to platform_notifications and pushes it to the Console Admins
 * connected to the live stream. Who sees a notification is decided when it is read, from its category's permission
 * (CONSOLE_NOTIFICATION_CAP), so a role change applies to old notifications too.
 *
 * Inside a platform transaction the notification commits with the change it describes. From a workspace transaction
 * (which cannot reach platform tables) call `later` once that transaction has committed.
 */
@Injectable()
export class ConsoleNotifyService {
  private readonly logger = new Logger(ConsoleNotifyService.name);

  constructor(private readonly db: DatabaseService) {}

  async emit(tx: PlatformTx, input: ConsoleNotifyInput): Promise<void> {
    const notifications = tx.collection('platform_notifications');
    if (input.dedupeKey && (await notifications.exists({ dedupe_key: input.dedupeKey }))) return;
    const companyId = input.companyId ?? (input.tenantId ? ((await tx.collection<{ company_id?: string | null }>('tenants').findOne({ id: input.tenantId }, { projection: { company_id: 1 } }))?.company_id ?? null) : null);
    const row = await notifications.insert({
      category: input.category, kind: input.kind, priority: input.priority ?? 'normal', title: input.title.slice(0, 300), body: input.body?.slice(0, 1000) ?? null,
      href: input.href ? (companyId ? input.href.replace(':company', companyId) : input.href.includes(':company') ? null : input.href) : null, tenant_id: input.tenantId ?? null, company_id: companyId, entity_type: input.entityType ?? null, entity_id: input.entityId ?? null,
      dedupe_key: input.dedupeKey ?? null,
    });
    await tx.collection('live_events').insert({
      tenant_id: input.tenantId ?? null, membership_ids: [], console: true, type: 'console.notification',
      data: { id: row.id, category: input.category, priority: input.priority ?? 'normal', title: input.title.slice(0, 300), requiredCap: CONSOLE_NOTIFICATION_CAP[input.category] },
    });
  }

  /** The same, in its own platform transaction; a failure is logged, never thrown (the change itself has committed). */
  async later(input: ConsoleNotifyInput): Promise<void> {
    try {
      await this.db.platform((tx) => this.emit(tx, input));
    } catch (err) {
      this.logger.warn(`Console notification ${input.kind} not written: ${(err as Error).message}`);
    }
  }
}
