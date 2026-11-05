import type { INestApplication } from '@nestjs/common';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './helpers';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
const hasRedisServer = (() => {
  try {
    execFileSync('redis-server', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Two API instances with their own Redis connections share one set of counters, so the limit holds across replicas.
 * CI provides Redis as a service (REDIS_TEST_URL); locally a throwaway redis-server is started.
 */
describe.skipIf(!process.env.REDIS_TEST_URL && !hasRedisServer)('Rate limits shared across API servers', () => {
  let redis: ChildProcess | undefined;
  let url: string;
  const apps: INestApplication[] = [];
  const saved = { REDIS_URL: process.env.REDIS_URL, CREW_TEST_RATE_LIMITS: process.env.CREW_TEST_RATE_LIMITS };

  beforeAll(async () => {
    if (process.env.REDIS_TEST_URL) url = process.env.REDIS_TEST_URL;
    else {
      const port = await freePort();
      redis = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
      url = `redis://127.0.0.1:${port}/0`;
      await wait(300);
    }
    process.env.CREW_TEST_RATE_LIMITS = 'true';
    process.env.REDIS_URL = url;
    apps.push(await createApp(), await createApp());
    // A third server whose Redis is unreachable.
    process.env.REDIS_URL = 'redis://127.0.0.1:1/0';
    apps.push(await createApp());
    await wait(300);
  });

  afterAll(async () => {
    for (const a of apps) await a.close();
    redis?.kill();
    process.env.REDIS_URL = saved.REDIS_URL;
    process.env.CREW_TEST_RATE_LIMITS = saved.CREW_TEST_RATE_LIMITS;
  });

  // Single sign-on start allows 10 calls a minute per caller.
  const start = (app: INestApplication) => request(app.getHttpServer()).post('/api/v1/auth/sso/start').set('x-forwarded-for', '203.0.113.7').send({ email: `nobody-${Date.now()}@nowhere.test` });

  it('counts calls to either server against one limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await start(apps[i % 2]!)).status);
    // Ten answered (no workspace uses that domain), then both servers refuse.
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(404));
    expect(statuses.slice(10)).toEqual([429, 429]);
    const r = await start(apps[1]!);
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('keeps serving with per-server counters when Redis cannot be reached', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await start(apps[2]!)).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(404));
    expect(statuses[10]).toBe(429);
  });
});
