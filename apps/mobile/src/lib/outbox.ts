import { mobileSync } from '@crew/contracts';

/**
 * The offline punch queue. Every punch is first written to the phone's storage with a per-device sequence
 * number and both clocks (wall clock and the app's monotonic clock), then sent. Punches stay queued until the
 * server answers for them: accepted and duplicate punches leave the queue, refused ones move to a list shown
 * to the person with the reason. Nothing is dropped silently.
 */

export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface Clock {
  now(): number;
  elapsed(): number;
  runId: string;
}

export interface PunchDraft {
  direction?: 'in' | 'out';
  latitude?: number;
  longitude?: number;
  accuracyM?: number;
  mockLocation?: boolean;
  note?: string;
}

export interface QueuedPunch extends PunchDraft {
  sequence: number;
  capturedAt: string;
  capturedElapsedMs: number;
  capturedRunId: string;
  /** Set once a send attempt failed, so the server knows the punch waited on the phone. */
  offline: boolean;
}

export interface RefusedPunch {
  sequence: number;
  capturedAt: string;
  direction?: 'in' | 'out';
  reason: string;
  message: string;
}

export interface SyncResult {
  sequence: number;
  status: 'accepted' | 'duplicate' | 'rejected';
  reason?: string;
  message?: string;
  punch?: { flags?: string[] };
}

export interface SyncBody {
  sentElapsedMs: number;
  sentRunId: string;
  punches: QueuedPunch[];
}

export type Sender = (body: SyncBody) => Promise<{ results: SyncResult[] }>;

export interface FlushOutcome {
  accepted: number;
  duplicates: number;
  refused: RefusedPunch[];
  /** Error that stopped the flush; the punches stay queued. */
  error?: { message: string; offline: boolean };
  remaining: number;
}

/** Errors after which the queue is kept and sent again later. */
const isRetryable = (err: unknown) => {
  const e = err as { status?: number };
  return e.status === undefined || e.status === 0 || e.status === 401 || e.status === 404 || e.status === 408 || e.status === 429 || e.status >= 500;
};

export class Outbox {
  private flushing: Promise<FlushOutcome> | null = null;

  constructor(
    private readonly kv: KeyValue,
    private readonly clock: Clock,
    private readonly scope: string,
  ) {}

  private key(name: string) {
    return `crew.outbox.${this.scope}.${name}`;
  }

  private async read<T>(name: string, fallback: T): Promise<T> {
    const raw = await this.kv.get(this.key(name));
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private write(name: string, value: unknown) {
    return this.kv.set(this.key(name), JSON.stringify(value));
  }

  pending(): Promise<QueuedPunch[]> {
    return this.read<QueuedPunch[]>('pending', []);
  }

  refused(): Promise<RefusedPunch[]> {
    return this.read<RefusedPunch[]>('refused', []);
  }

  async dismissRefused(sequence: number) {
    await this.write('refused', (await this.refused()).filter((r) => r.sequence !== sequence));
  }

  /** Records a punch on the phone. It is safe from here on, even if the app closes before it is sent. */
  async add(draft: PunchDraft): Promise<QueuedPunch> {
    const sequence = (await this.read<number>('sequence', 0)) + 1;
    await this.write('sequence', sequence);
    const punch: QueuedPunch = {
      ...draft,
      sequence,
      capturedAt: new Date(this.clock.now()).toISOString(),
      capturedElapsedMs: Math.round(this.clock.elapsed()),
      capturedRunId: this.clock.runId,
      offline: false,
    };
    await this.write('pending', [...(await this.pending()), punch]);
    return punch;
  }

  /** Sends everything queued, in batches. Only one flush runs at a time. */
  flush(send: Sender): Promise<FlushOutcome> {
    this.flushing ??= this.doFlush(send).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(send: Sender): Promise<FlushOutcome> {
    const out: FlushOutcome = { accepted: 0, duplicates: 0, refused: [], remaining: 0 };
    for (;;) {
      const queue = await this.pending();
      if (!queue.length) break;
      const batch = queue.slice(0, mobileSync.SYNC_BATCH_MAX);
      let results: SyncResult[];
      try {
        results = (await send({ sentElapsedMs: Math.round(this.clock.elapsed()), sentRunId: this.clock.runId, punches: batch })).results;
      } catch (err) {
        const e = err as { message?: string; status?: number };
        if (isRetryable(err)) {
          // Mark what is waiting as offline, so the server can flag it for review.
          await this.write('pending', queue.map((p) => (batch.some((b) => b.sequence === p.sequence) ? { ...p, offline: true } : p)));
          out.error = { message: e.message ?? 'Could not send punches', offline: e.status === 0 || e.status === undefined };
        } else {
          // The server refused the whole request (for example a validation error): show it, keep nothing hidden.
          const refused = batch.map((p) => ({ sequence: p.sequence, capturedAt: p.capturedAt, direction: p.direction, reason: 'refused', message: e.message ?? 'Refused by SampCrew' }));
          await this.settle(batch.map((p) => p.sequence), refused);
          out.refused.push(...refused);
          continue;
        }
        break;
      }
      const done: number[] = [];
      const refused: RefusedPunch[] = [];
      for (const r of results) {
        const p = batch.find((b) => b.sequence === r.sequence);
        if (!p) continue;
        done.push(r.sequence);
        if (r.status === 'accepted') out.accepted++;
        else if (r.status === 'duplicate') out.duplicates++;
        else refused.push({ sequence: p.sequence, capturedAt: p.capturedAt, direction: p.direction, reason: r.reason ?? 'rejected', message: r.message ?? 'Refused by SampCrew' });
      }
      await this.settle(done, refused);
      out.refused.push(...refused);
      // A server that answered for none of the batch would loop forever; stop and try again later.
      if (!done.length) {
        out.error = { message: 'SampCrew did not confirm these punches. They stay on the phone and will be sent again.', offline: false };
        break;
      }
    }
    out.remaining = (await this.pending()).length;
    return out;
  }

  private async settle(done: number[], refused: RefusedPunch[]) {
    const pending = await this.pending();
    await this.write('pending', pending.filter((p) => !done.includes(p.sequence)));
    if (refused.length) await this.write('refused', [...(await this.refused()), ...refused]);
  }
}
