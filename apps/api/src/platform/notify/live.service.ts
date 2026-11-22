import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { ChangeStream, Document } from 'mongodb';
import { Observable, type Subscriber } from 'rxjs';
import { MongoService as DatabaseService } from '../database/mongo.service';

export interface LiveMessage {
  type: string;
  data: Record<string, unknown>;
}

interface Listener {
  tenantId: string;
  membershipId: string;
  push: (m: LiveMessage) => void;
}

/** A Console Admin connected to the support inbox. Gets the events written with `console: true`, from every workspace. */
interface ConsoleListener {
  adminId: string;
  push: (m: LiveMessage & { tenantId: string }) => void;
}

const KEEP_MS = 60 * 60_000;
const POLL_MS = 1_500;

/**
 * Fans out live events (collection live_events) to the members connected to this API server. Every server watches the
 * collection with a change stream, so an event written by one server reaches people connected to any other. When
 * change streams are not available (a standalone MongoDB), it polls instead.
 */
@Injectable()
export class LiveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveService.name);
  private readonly listeners = new Set<Listener>();
  private readonly consoleListeners = new Set<ConsoleListener>();
  private stream: ChangeStream | null = null;
  private poll: NodeJS.Timeout | null = null;
  private sweep: NodeJS.Timeout | null = null;
  private lastSeen = new Date();
  private starting: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    // Old events are only useful for a reconnecting browser for a minute or two; keep an hour, sweep every 10 minutes.
    this.sweep = setInterval(() => void this.prune(), 10 * 60_000);
    this.sweep.unref();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.sweep) clearInterval(this.sweep);
    if (this.poll) clearInterval(this.poll);
    await this.stream?.close().catch(() => undefined);
  }

  /** How many browsers are connected to this server (health and tests). */
  get connections(): number {
    return this.listeners.size + this.consoleListeners.size;
  }

  /** A stream of the Console Admin team's events (support chat), ending when the subscriber unsubscribes. */
  subscribeConsole(adminId: string): Observable<LiveMessage & { tenantId: string }> {
    return new Observable<LiveMessage & { tenantId: string }>((sub) => {
      const l: ConsoleListener = { adminId, push: (m) => sub.next(m) };
      this.consoleListeners.add(l);
      void this.ensureWatching();
      return () => {
        this.consoleListeners.delete(l);
      };
    });
  }

  /** A stream of the events for one member, ending when the subscriber unsubscribes. */
  subscribe(tenantId: string, membershipId: string): Observable<LiveMessage> {
    return new Observable<LiveMessage>((sub: Subscriber<LiveMessage>) => {
      const l: Listener = { tenantId, membershipId, push: (m) => sub.next(m) };
      this.listeners.add(l);
      void this.ensureWatching();
      return () => {
        this.listeners.delete(l);
      };
    });
  }

  private ensureWatching(): Promise<void> {
    if (this.stream || this.poll || this.stopped) return Promise.resolve();
    this.starting ??= this.startWatching().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startWatching() {
    const db = await this.db.database();
    this.lastSeen = new Date();
    try {
      const stream = db.collection('live_events').watch([{ $match: { operationType: 'insert' } }], { fullDocument: 'default' });
      stream.on('change', (c: Document) => this.dispatch(c.fullDocument));
      stream.on('error', (err: Error) => {
        this.logger.warn(`Live change stream stopped (${err.message}); polling instead`);
        this.stream = null;
        void stream.close().catch(() => undefined);
        this.startPolling();
      });
      // Opening a change stream on a standalone server fails at the first read; force it now.
      await stream.tryNext().catch((err: Error) => {
        throw err;
      });
      this.stream = stream;
    } catch (err) {
      this.logger.warn(`Change streams unavailable (${(err as Error).message}); polling live events`);
      this.startPolling();
    }
  }

  private startPolling() {
    if (this.poll || this.stopped) return;
    this.poll = setInterval(() => void this.pollOnce(), POLL_MS);
    this.poll.unref();
  }

  private async pollOnce() {
    try {
      const db = await this.db.database();
      const rows = await db.collection('live_events').find({ created_at: { $gt: this.lastSeen } }).sort({ created_at: 1 }).limit(500).toArray();
      for (const r of rows) {
        this.dispatch(r);
        if (r.created_at > this.lastSeen) this.lastSeen = r.created_at;
      }
    } catch (err) {
      this.logger.warn(`Polling live events failed: ${(err as Error).message}`);
    }
  }

  private dispatch(doc: Document | undefined) {
    if (!doc) return;
    if (doc.console === true) {
      for (const l of this.consoleListeners) l.push({ type: doc.type, data: doc.data ?? {}, tenantId: doc.tenant_id });
      return;
    }
    const ids = new Set<string>(doc.membership_ids ?? []);
    for (const l of this.listeners) {
      if (l.tenantId === doc.tenant_id && ids.has(l.membershipId)) l.push({ type: doc.type, data: doc.data ?? {} });
    }
  }

  private async prune() {
    try {
      const db = await this.db.database();
      await db.collection('live_events').deleteMany({ created_at: { $lt: new Date(Date.now() - KEEP_MS) } });
    } catch (err) {
      this.logger.warn(`Pruning live events failed: ${(err as Error).message}`);
    }
  }
}
