import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { MongoService as DatabaseService, type PlatformTx, type TenantTx, type UserTx } from '../database/mongo.service';

/** How long a dispatcher owns an event it took; after that another dispatcher may deliver it again. */
const LEASE_SECONDS = 120;

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
 *
 * Each event is taken under a short lease (its available_at moves forward), delivered outside any transaction,
 * then marked published, or failed with a back-off, so a slow handler never holds a transaction open.
 */
@Injectable()
export class OutboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Outbox');
  private readonly handlers = new Map<string, Handler[]>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly db: DatabaseService) {}

  async publish(tx: TenantTx | UserTx | PlatformTx, tenantId: string | null, type: string, payload: Record<string, unknown>): Promise<void> {
    await tx.collection('outbox_events').insert({ tenant_id: tenantId, type, payload });
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
      let delivered = 0;
      for (; delivered < batch; delivered++) {
        const row = await this.claim();
        if (!row) break;
        const event: DomainEvent = { id: row.id, tenantId: row.tenant_id ?? null, type: row.type, payload: row.payload, occurredAt: row.occurred_at.toISOString() };
        try {
          for (const h of this.handlers.get(row.type) ?? []) await h(event);
          await this.db.platform((tx) => tx.collection('outbox_events').updateOne({ id: row.id }, { $set: { published_at: new Date() }, $inc: { attempts: 1 } }));
        } catch (err) {
          const delay = Math.min(2 ** row.attempts * 5, 3600);
          await this.db.platform((tx) =>
            tx.collection('outbox_events').updateOne({ id: row.id }, { $set: { last_error: (err as Error).message.slice(0, 1000), available_at: new Date(Date.now() + delay * 1000) }, $inc: { attempts: 1 } }),
          );
          this.logger.warn(`Event ${row.type} ${row.id} failed (attempt ${row.attempts + 1}): ${(err as Error).message}`);
        }
      }
      return delivered;
    } finally {
      this.running = false;
    }
  }

  /** Takes the oldest event that is due, moving its available_at past the lease so no other dispatcher takes it meanwhile. */
  private claim() {
    return this.db.platform(async (tx) => {
      const events = tx.collection<{ id: string; tenant_id?: string | null; type: string; payload: Record<string, unknown>; occurred_at: Date; attempts: number; available_at: Date }>('outbox_events');
      const now = new Date();
      const next = await events.findOne({ published_at: null, available_at: { $lte: now } }, { sort: { occurred_at: 1 } });
      if (!next) return undefined;
      // Two dispatchers taking the same event write the same document; MongoDB lets only one transaction commit.
      await events.updateOne({ id: next.id, available_at: next.available_at }, { $set: { available_at: new Date(now.getTime() + LEASE_SECONDS * 1000) } });
      return next;
    });
  }
}
