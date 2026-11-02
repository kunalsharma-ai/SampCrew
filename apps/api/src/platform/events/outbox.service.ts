import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DatabaseService, type Tx } from '../database/database.service';

export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  tenantId: string | null;
  type: string;
  payload: T;
  occurredAt: string;
}

type Handler = (event: DomainEvent) => Promise<void>;

/**
 * Transactional outbox. publish() writes the event in the caller's transaction; a dispatcher loop delivers
 * committed events to subscribers at least once. Handlers must be idempotent.
 */
@Injectable()
export class OutboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Outbox');
  private readonly handlers = new Map<string, Handler[]>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly db: DatabaseService) {}

  async publish(tx: Tx, tenantId: string | null, type: string, payload: Record<string, unknown>): Promise<void> {
    await tx.query('insert into outbox_events (tenant_id, type, payload) values ($1, $2, $3)', [tenantId, type, JSON.stringify(payload)]);
  }

  subscribe(type: string, handler: Handler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  onApplicationBootstrap() {
    if (process.env.CREW_DISABLE_DISPATCHER === 'true') return;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One timer tick. A database that is briefly unreachable (a restart, a failover) must not take the API down with
   * an unhandled rejection: log it and try again on the next tick.
   */
  async tick(): Promise<void> {
    await this.dispatchOnce().catch((err: Error) => this.logger.error(`Outbox tick failed: ${err.message}`));
  }

  /** Delivers one batch. Exposed for tests and for a dedicated worker process. */
  async dispatchOnce(batch = 50): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.db.platform(async (tx) => {
        const { rows } = await tx.query<{ id: string; tenant_id: string | null; type: string; payload: Record<string, unknown>; occurred_at: Date; attempts: number }>(
          `select id, tenant_id, type, payload, occurred_at, attempts from outbox_events
            where published_at is null and available_at <= now()
            order by occurred_at limit $1 for update skip locked`,
          [batch],
        );
        for (const row of rows) {
          const event: DomainEvent = { id: row.id, tenantId: row.tenant_id, type: row.type, payload: row.payload, occurredAt: row.occurred_at.toISOString() };
          try {
            for (const h of this.handlers.get(row.type) ?? []) await h(event);
            await tx.query('update outbox_events set published_at = now(), attempts = attempts + 1 where id = $1', [row.id]);
          } catch (err) {
            const delay = Math.min(2 ** row.attempts * 5, 3600);
            await tx.query(
              `update outbox_events set attempts = attempts + 1, last_error = $2, available_at = now() + make_interval(secs => $3) where id = $1`,
              [row.id, (err as Error).message.slice(0, 1000), delay],
            );
            this.logger.warn(`Event ${row.type} ${row.id} failed (attempt ${row.attempts + 1}): ${(err as Error).message}`);
          }
        }
        return rows.length;
      });
    } finally {
      this.running = false;
    }
  }
}
