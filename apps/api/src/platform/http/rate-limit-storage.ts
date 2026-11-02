import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { type ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import Redis from 'ioredis';

type StorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Rate-limit counters shared by every API server through Redis (REDIS_URL), so a limit means the same with one
 * replica or ten. Counters are keyed by route and caller and expire with their window.
 *
 * If Redis cannot be reached, each server falls back to its own in-memory counters and logs a warning, so an outage
 * of Redis weakens the limits (each replica counts separately) but never takes the API down. It switches back as
 * soon as Redis answers again.
 */
export class SharedRateLimitStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger('RateLimit');
  private readonly redis: Redis;
  private readonly shared: ThrottlerStorageRedisService;
  private readonly local = new ThrottlerStorageService();
  private degraded = false;

  constructor(url: string) {
    this.redis = new Redis(url, {
      keyPrefix: 'crew:rl:',
      // Fail fast instead of holding requests while Redis is away.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2_000,
      lazyConnect: false,
    });
    this.redis.on('error', (err: Error) => {
      if (!this.degraded) this.logger.warn(`Redis unavailable for rate limits, using per-server counters: ${err.message}`);
      this.degraded = true;
    });
    this.redis.on('ready', () => {
      if (this.degraded) this.logger.log('Redis back: rate limits are shared again');
      this.degraded = false;
    });
    this.shared = new ThrottlerStorageRedisService(this.redis);
  }

  get usingRedis() {
    return this.redis.status === 'ready';
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<StorageRecord> {
    if (this.redis.status === 'ready') {
      try {
        return await this.shared.increment(key, ttl, limit, blockDuration, throttlerName);
      } catch (err) {
        if (!this.degraded) this.logger.warn(`Rate limit counter failed in Redis, using per-server counters: ${(err as Error).message}`);
        this.degraded = true;
      }
    }
    return this.local.increment(key, ttl, limit, blockDuration, throttlerName);
  }

  onApplicationShutdown() {
    this.redis.disconnect(false);
    this.local.onApplicationShutdown();
  }
}
