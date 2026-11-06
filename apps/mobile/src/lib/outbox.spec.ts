import { describe, expect, it } from 'vitest';
import { Outbox, type KeyValue, type SyncBody } from './outbox';

const memory = (): KeyValue & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) };
};

const clock = (start = Date.UTC(2026, 10, 1, 3, 30)) => {
  let wall = start;
  let mono = 1000;
  return { now: () => wall, elapsed: () => mono, runId: 'run-test-0001', tick: (ms: number) => { wall += ms; mono += ms; } };
};

describe('offline punch queue', () => {
  it('stores punches with a sequence and both clocks before sending', async () => {
    const kv = memory();
    const c = clock();
    const box = new Outbox(kv, c, 'device-1');
    const a = await box.add({ direction: 'in', latitude: 18.52, longitude: 73.85 });
    c.tick(60_000);
    const b = await box.add({ direction: 'out' });
    expect(a).toMatchObject({ sequence: 1, capturedElapsedMs: 1000, capturedRunId: 'run-test-0001', offline: false, capturedAt: '2026-11-01T03:30:00.000Z' });
    expect(b.sequence).toBe(2);
    // A new outbox over the same storage (the app restarted) keeps the queue and the counter.
    const again = new Outbox(kv, clock(), 'device-1');
    expect((await again.pending()).map((p) => p.sequence)).toEqual([1, 2]);
    expect((await again.add({})).sequence).toBe(3);
  });

  it('keeps punches when there is no connection and marks them offline', async () => {
    const box = new Outbox(memory(), clock(), 'd');
    await box.add({ direction: 'in' });
    const r = await box.flush(async () => { throw Object.assign(new Error('No connection to SampCrew.'), { status: 0 }); });
    expect(r).toMatchObject({ accepted: 0, remaining: 1, error: { offline: true } });
    expect((await box.pending())[0]!.offline).toBe(true);
  });

  it('sends the queue with the monotonic clock, removes confirmed punches and keeps refusals with their reason', async () => {
    const c = clock();
    const box = new Outbox(memory(), c, 'd');
    await box.add({ direction: 'in' });
    await box.add({ direction: 'out' });
    await box.add({ direction: 'in' });
    c.tick(5000);
    const sent: SyncBody[] = [];
    const r = await box.flush(async (body) => {
      sent.push(body);
      return { results: [
        { sequence: 1, status: 'accepted' },
        { sequence: 2, status: 'duplicate' },
        { sequence: 3, status: 'rejected', reason: 'too_old', message: 'Ask for an attendance correction instead.' },
      ] };
    });
    expect(sent[0]).toMatchObject({ sentElapsedMs: 6000, sentRunId: 'run-test-0001' });
    expect(r).toMatchObject({ accepted: 1, duplicates: 1, remaining: 0 });
    expect(await box.refused()).toEqual([{ sequence: 3, capturedAt: '2026-11-01T03:30:00.000Z', direction: 'in', reason: 'too_old', message: 'Ask for an attendance correction instead.' }]);
    await box.dismissRefused(3);
    expect(await box.refused()).toEqual([]);
  });

  it('sends large queues in batches of 50 and runs one flush at a time', async () => {
    const box = new Outbox(memory(), clock(), 'd');
    for (let i = 0; i < 120; i++) await box.add({});
    const sizes: number[] = [];
    const send = async (b: SyncBody) => {
      sizes.push(b.punches.length);
      return { results: b.punches.map((p) => ({ sequence: p.sequence, status: 'accepted' as const })) };
    };
    const [x, y] = await Promise.all([box.flush(send), box.flush(send)]);
    expect(x).toBe(y);
    expect(sizes).toEqual([50, 50, 20]);
    expect(x.accepted).toBe(120);
  });

  it('stops instead of looping when the server confirms nothing, and shows a request the server refused outright', async () => {
    const box = new Outbox(memory(), clock(), 'd');
    await box.add({});
    const r = await box.flush(async () => ({ results: [] }));
    expect(r.remaining).toBe(1);
    expect(r.error?.offline).toBe(false);
    const v = await box.flush(async () => { throw Object.assign(new Error('Some fields need attention'), { status: 422 }); });
    expect(v.refused).toHaveLength(1);
    expect(await box.pending()).toEqual([]);
  });

  it('keeps the queue when the device was signed out, so nothing is lost after signing in again', async () => {
    const box = new Outbox(memory(), clock(), 'd');
    await box.add({});
    const r = await box.flush(async () => { throw Object.assign(new Error('Device not found'), { status: 404 }); });
    expect(r.remaining).toBe(1);
  });
});
