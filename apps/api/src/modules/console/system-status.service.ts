import { hostname } from 'node:os';
import { Injectable, Logger, type NestMiddleware, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { SystemComponent, SystemLevel, SystemStatus } from '@crew/contracts';
import type { NextFunction, Request, Response } from 'express';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { PlatformService } from '../platform-admin/platform.service';

/** Upper bounds (ms) of the response-time buckets; the last bucket is everything slower. */
export const LATENCY_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000];
const DAY = 86_400_000;

/** The route group a request belongs to, from the first part of its path. A fixed list keeps the table small. */
export function serviceOf(path: string): string | null {
  const first = path.replace(/^.*?\/api\/v\d+\//, '').split(/[/?]/)[0] ?? '';
  if (!first || first === 'health' || first === 'live') return null;
  if (first === 'platform') return 'Console';
  if (['auth', 'me', 'password-resets', 'identity', 'scim'].includes(first)) return 'Sign-in';
  if (first === 'billing') return 'Billing';
  if (['attendance', 'kiosk', 'shifts', 'devices', 'device-api', 'iclock', 'late-coming'].includes(first)) return 'Attendance';
  if (['payroll', 'payslips', 'expenses', 'receipts'].includes(first)) return 'Payroll';
  if (['leave', 'leave-penalties'].includes(first)) return 'Leave';
  if (['recruitment', 'careers', 'crm', 'resumes'].includes(first)) return 'Recruitment';
  if (['communication', 'notifications', 'support', 'help', 'helpdesk', 'announcements', 'comm-files'].includes(first)) return 'Communication';
  if (first === 'mobile') return 'Mobile app';
  return 'Workspaces';
}

/** p95 from a histogram of LATENCY_BUCKETS counts (the upper bound of the bucket that holds the 95th percentile). */
export function p95(histogram: number[]): number | null {
  const total = histogram.reduce((a, n) => a + n, 0);
  if (!total) return null;
  let seen = 0;
  for (let i = 0; i < histogram.length; i++) {
    seen += histogram[i] ?? 0;
    if (seen >= total * 0.95) return LATENCY_BUCKETS[i] ?? LATENCY_BUCKETS.at(-1)! * 2;
  }
  return null;
}

interface Cell { count: number; errors: number; clientErrors: number; totalMs: number; maxMs: number; histogram: number[] }

/**
 * Counts API requests per minute and route group (response time and errors) in memory and writes them to
 * platform_request_metrics once a minute, so System health can say how each part of the API is doing. Rows older
 * than 30 days are removed. Nothing about the request itself (who, what data) is kept.
 */
@Injectable()
export class RequestMetricsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('RequestMetrics');
  private readonly instance = `${hostname()}:${process.pid}`;
  private cells = new Map<string, Cell>();
  private timer?: NodeJS.Timeout;
  private lastPrune = 0;

  constructor(private readonly db: DatabaseService) {}

  onApplicationBootstrap() {
    if (process.env.CREW_ENV === 'test') return;
    this.timer = setInterval(() => void this.flush().catch((e: Error) => this.logger.warn(`Metrics not written: ${e.message}`)), 60_000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.flush().catch(() => undefined);
  }

  record(service: string, status: number, ms: number, at = new Date()) {
    const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString();
    const key = `${minute}|${service}`;
    const c = this.cells.get(key) ?? { count: 0, errors: 0, clientErrors: 0, totalMs: 0, maxMs: 0, histogram: LATENCY_BUCKETS.map(() => 0).concat(0) };
    c.count++;
    if (status >= 500) c.errors++;
    else if (status >= 400) c.clientErrors++;
    c.totalMs += Math.round(ms);
    c.maxMs = Math.max(c.maxMs, Math.round(ms));
    const i = LATENCY_BUCKETS.findIndex((b) => ms <= b);
    c.histogram[i === -1 ? LATENCY_BUCKETS.length : i]!++;
    this.cells.set(key, c);
  }

  /** Writes the counted minutes (adding to rows another flush of this instance already wrote). */
  async flush() {
    if (!this.cells.size) return;
    const cells = this.cells;
    this.cells = new Map();
    await this.db.platform(async (tx) => {
      const table = tx.collection<{ histogram: number[] }>('platform_request_metrics');
      for (const [key, c] of cells) {
        const [minute, service] = key.split('|') as [string, string];
        const filter = { minute: new Date(minute), service, instance: this.instance };
        const old = await table.findOne(filter, { projection: { histogram: 1 } });
        const histogram = c.histogram.map((n, i) => n + (old?.histogram?.[i] ?? 0));
        await table.upsert(filter, { ...filter, count: c.count, errors: c.errors, client_errors: c.clientErrors, total_ms: c.totalMs, max_ms: c.maxMs, histogram }, {
          $inc: { count: c.count, errors: c.errors, client_errors: c.clientErrors, total_ms: c.totalMs }, $max: { max_ms: c.maxMs }, $set: { histogram },
        });
      }
      if (Date.now() - this.lastPrune > 3_600_000) {
        this.lastPrune = Date.now();
        await table.delete({ minute: { $lt: new Date(Date.now() - 30 * DAY) } });
      }
    });
  }
}

/** Times every API request for RequestMetricsService. */
@Injectable()
export class RequestMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: RequestMetricsService) {}
  use(req: Request, res: Response, next: NextFunction) {
    const service = serviceOf(req.originalUrl ?? req.url ?? '');
    if (service) {
      const started = process.hrtime.bigint();
      res.once('finish', () => this.metrics.record(service, res.statusCode, Number(process.hrtime.bigint() - started) / 1e6));
    }
    next();
  }
}

const worst = (levels: SystemLevel[]): SystemLevel => (levels.includes('critical') ? 'critical' : levels.includes('warning') ? 'warning' : 'operational');

/**
 * System health as Operational, Warning or Critical: the API (error rate and response times per route group), the
 * database and its replicas, backups, migrations, the event outbox, the audit chain and upload scanning. Built from
 * the existing detailed health check and the request metrics; each component says why it has its level.
 */
@Injectable()
export class SystemStatusService {
  constructor(private readonly db: DatabaseService, private readonly platform: PlatformService, private readonly metrics: RequestMetricsService) {}

  async status(): Promise<SystemStatus> {
    await this.metrics.flush().catch(() => undefined);
    const h = await this.platform.health().catch((e: Error) => ({ error: e.message }) as const);
    const components: SystemComponent[] = [];
    const now = Date.now();
    const rows = await this.db.platform((tx) => tx.collection<{ minute: Date; service: string; count: number; errors: number; total_ms: number; histogram: number[] }>('platform_request_metrics').find({ minute: { $gte: new Date(now - DAY) } }));
    const services = [...new Set(rows.map((r) => r.service))].sort();
    const traffic = services.map((service) => {
      const day = rows.filter((r) => r.service === service);
      const hour = day.filter((r) => r.minute.getTime() >= now - 3_600_000);
      const sum = (list: typeof rows, k: 'count' | 'errors') => list.reduce((a, r) => a + r[k], 0);
      const hist = LATENCY_BUCKETS.map(() => 0).concat(0).map((_, i) => hour.reduce((a, r) => a + (r.histogram?.[i] ?? 0), 0));
      const req1 = sum(hour, 'count');
      const req24 = sum(day, 'count');
      return {
        service, requests1h: req1, errorRate1h: req1 ? Math.round((sum(hour, 'errors') / req1) * 1000) / 10 : 0, p95Ms1h: p95(hist),
        requests24h: req24, errorRate24h: req24 ? Math.round((sum(day, 'errors') / req24) * 1000) / 10 : 0,
      };
    });
    const apiLevels = traffic.map((t): SystemLevel => (t.requests1h >= 20 && t.errorRate1h >= 5 ? 'critical' : (t.requests1h >= 20 && t.errorRate1h >= 1) || (t.p95Ms1h ?? 0) > 2500 ? 'warning' : 'operational'));
    const badApi = traffic.filter((_, i) => apiLevels[i] !== 'operational').map((t) => `${t.service}: ${t.errorRate1h}% errors, p95 ${t.p95Ms1h ?? '?'} ms`);
    components.push({ key: 'api', name: 'API', level: worst(apiLevels), detail: badApi.length ? badApi.join('; ') : traffic.length ? `${traffic.reduce((a, t) => a + t.requests1h, 0)} requests in the last hour, errors under 1%` : 'No traffic recorded in the last day yet' });

    if ('error' in h) {
      components.push({ key: 'database', name: 'Database', level: 'critical', detail: `Health check failed: ${h.error}` });
    } else {
      const lat = h.database.latencyMs;
      components.push({ key: 'database', name: 'Database', level: lat > 1000 ? 'critical' : lat > 200 ? 'warning' : 'operational', detail: `Answers in ${lat} ms` });
      if (h.replication) {
        const down = h.replication.members.filter((m) => !m.healthy);
        const lag = Math.max(0, ...h.replication.members.map((m) => m.lagSeconds ?? 0));
        components.push({ key: 'replication', name: 'Database replicas', level: down.length ? 'critical' : lag > 60 ? 'warning' : 'operational', detail: down.length ? `${down.map((m) => m.name).join(', ')} not healthy` : `${h.replication.members.length} members, at most ${lag}s behind` });
      }
      const ago = h.backups.archives.lastSuccessHoursAgo;
      components.push({ key: 'backups', name: 'Backups', level: ago === null ? 'warning' : ago > 72 ? 'critical' : ago > 26 ? 'warning' : 'operational', detail: ago === null ? 'No successful backup recorded yet' : `Last good backup ${ago} hours ago${h.backups.pointInTime ? `, point-in-time ${h.backups.pointInTime.minutesBehind ?? '?'} min behind` : ''}` });
      components.push({ key: 'migrations', name: 'Database migrations', level: h.migrations.pending.length ? 'critical' : 'operational', detail: h.migrations.pending.length ? `Not applied: ${h.migrations.pending.join(', ')}` : `${h.migrations.applied} applied` });
      const old = h.outbox.oldestPendingSeconds ?? 0;
      components.push({ key: 'outbox', name: 'Background events', level: old > 3600 ? 'critical' : old > 300 || h.outbox.retrying > 20 ? 'warning' : 'operational', detail: h.outbox.pending ? `${h.outbox.pending} waiting, oldest ${old}s, ${h.outbox.retrying} retrying` : 'Nothing waiting' });
      components.push({ key: 'audit', name: 'Audit chain', level: h.platformAuditChain.intact ? 'operational' : 'critical', detail: h.platformAuditChain.intact ? `${h.platformAuditChain.checked} Console events verified` : 'The Console audit chain is broken: an event was changed or removed' });
      if (h.uploadScanning.configured) components.push({ key: 'scanning', name: 'Upload virus scanning', level: h.uploadScanning.reachable ? 'operational' : 'warning', detail: h.uploadScanning.reachable ? 'Scanner answers' : 'Scanner is set up but not answering' });
      const off = h.integrations.filter((i) => !i.on);
      components.push({ key: 'integrations', name: 'Integrations', level: 'operational', detail: off.length ? `Not switched on: ${off.map((i) => i.name).join(', ')}` : 'All switched on' });
    }
    // Requests and server errors per hour over the last day, all route groups together.
    const series = Array.from({ length: 24 }, (_, i) => {
      const start = Math.floor(now / 3_600_000) * 3_600_000 - (23 - i) * 3_600_000;
      const inHour = rows.filter((r) => r.minute.getTime() >= start && r.minute.getTime() < start + 3_600_000);
      return { label: `${String(new Date(start).getUTCHours()).padStart(2, '0')}:00`, start: new Date(start).toISOString(), values: { requests: inHour.reduce((a, r) => a + r.count, 0), errors: inHour.reduce((a, r) => a + r.errors, 0) } };
    });
    return { level: worst(components.map((c) => c.level)), checkedAt: new Date().toISOString(), components, traffic, series };
  }
}
