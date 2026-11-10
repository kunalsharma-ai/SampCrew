import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { MongoService as DatabaseService } from '../database/mongo.service';
import { PlatformIntegrationsService } from '../integrations/platform-integrations.service';

const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 5;

interface Due {
  id: string;
  notification_id: string;
  link: string | null;
  push_token: string | null;
  revoked: boolean;
  attempts: number;
  device_id: string;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Sends queued push messages to the mobile app through the Expo push service. Each push says only that there
 * is something new and carries the notification id and in-app link; the text is loaded by the signed-in app,
 * so no personal data passes through Apple, Google or Expo. Push is switched on by SAMPLEDGE in the Super Admin
 * Console (Integrations > Mobile push), else by EXPO_PUSH_ENABLED=true in the environment. While it is off nothing is sent and
 * messages are marked skipped with the reason. A device the push service reports as no longer registered has
 * its token removed.
 */
@Injectable()
export class PushService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Push');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly integrations: PlatformIntegrationsService,
  ) {}

  async enabled() {
    return (await this.integrations.push()).enabled;
  }

  onApplicationBootstrap() {
    if (this.config.CREW_DISABLE_DISPATCHER === 'true') return;
    this.timer = setInterval(() => void this.sendBatch().catch((err: Error) => this.logger.error(`Push batch failed: ${err.message}`)), 3000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Sends one batch of due pushes. Exposed for tests and for a dedicated worker process. */
  async sendBatch(batch = 100): Promise<{ sent: number; failed: number; skipped: number }> {
    const out = { sent: 0, failed: 0, skipped: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      const settings = await this.integrations.push();
      // Due messages are taken under a short lease, sent outside any transaction (a retried transaction must not
      // push twice), and their outcome is written afterwards.
      const rows = await this.claim(batch);
      const outcomes: Array<{ id: string; set: Record<string, unknown>; inc?: boolean; clearDevice?: string }> = [];
      const skip = (id: string, reason: string) => {
        outcomes.push({ id, set: { status: 'skipped', last_error: reason } });
        out.skipped++;
      };
      const sendable: Due[] = [];
      for (const m of rows) {
        if (!settings.enabled) skip(m.id, 'Push delivery is not set up (Super Admin Console > Integrations > Mobile push)');
        else if (m.revoked || !m.push_token) skip(m.id, 'The device was signed out or turned push off');
        else sendable.push(m);
      }
      if (sendable.length) {
        let tickets: ExpoTicket[] | null = null;
        let failure: string | null = null;
        try {
          const res = await fetch(this.config.EXPO_PUSH_URL, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              ...(settings.accessToken ? { authorization: `Bearer ${settings.accessToken}` } : {}),
            },
            body: JSON.stringify(sendable.map((m) => ({
              to: m.push_token,
              title: 'SampCrew',
              body: 'You have something new in SampCrew.',
              sound: 'default',
              data: { notificationId: m.notification_id, link: m.link },
            }))),
            signal: AbortSignal.timeout(10_000),
          });
          const json = (await res.json().catch(() => null)) as { data?: ExpoTicket[]; errors?: { message: string }[] } | null;
          if (!res.ok || !Array.isArray(json?.data)) failure = `Push service answered ${res.status}${json?.errors?.[0]?.message ? `: ${json.errors[0].message}` : ''}`;
          else tickets = json.data;
        } catch (err) {
          failure = (err as Error).message;
        }
        for (const [i, m] of sendable.entries()) {
          const t = tickets?.[i];
          if (t?.status === 'ok') {
            outcomes.push({ id: m.id, set: { status: 'sent', sent_at: new Date(), ticket_id: t.id ?? null, last_error: null }, inc: true });
            out.sent++;
            continue;
          }
          const error = t ? `${t.details?.error ?? 'error'}: ${t.message ?? ''}`.slice(0, 1000) : (failure ?? 'No answer for this message').slice(0, 1000);
          if (t?.details?.error === 'DeviceNotRegistered') {
            // The app was uninstalled or the token expired: stop sending to it.
            outcomes.push({ id: m.id, set: { status: 'failed', last_error: error }, inc: true, clearDevice: m.device_id });
            out.failed++;
            continue;
          }
          const attempts = m.attempts + 1;
          outcomes.push({
            id: m.id,
            set: { attempts, last_error: error, status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', next_attempt_at: new Date(Date.now() + Math.min(30 * 2 ** attempts, 3600) * 1000) },
          });
          out.failed++;
        }
        if (failure) this.logger.warn(`Push batch failed: ${failure}`);
      }
      if (outcomes.length) {
        await this.db.platform(async (tx) => {
          for (const o of outcomes) {
            await tx.collection('push_messages').updateOne({ id: o.id }, { $set: o.set, ...(o.inc ? { $inc: { attempts: 1 } } : {}) });
            if (o.clearDevice) await tx.collection('mobile_devices').updateOne({ id: o.clearDevice }, { $set: { push_token: null, push_token_updated_at: new Date() } });
          }
        });
      }
    } finally {
      this.running = false;
    }
    return out;
  }

  private claim(batch: number): Promise<Due[]> {
    return this.db.platform(async (tx) => {
      const now = new Date();
      const pushes = tx.collection('push_messages');
      const due = await pushes.find({ status: 'queued', next_attempt_at: { $lte: now } }, { sort: { created_at: 1 }, limit: batch });
      if (!due.length) return [];
      // Concurrent senders taking the same message write the same document; MongoDB lets only one commit.
      await pushes.update({ id: { $in: due.map((p) => p.id) } }, { $set: { next_attempt_at: new Date(now.getTime() + LEASE_SECONDS * 1000) } });
      const devices = new Map((await tx.collection('mobile_devices').find({ id: { $in: due.map((p) => p.mobile_device_id) } })).map((d) => [d.id as string, d]));
      const links = new Map((await tx.collection('notifications').find({ id: { $in: due.map((p) => p.notification_id).filter(Boolean) } }, { projection: { link: 1 } })).map((n) => [n.id as string, n.link]));
      return due.map((p) => {
        const d = devices.get(p.mobile_device_id);
        return { id: p.id, notification_id: p.notification_id, link: links.get(p.notification_id) ?? null, push_token: d?.push_token ?? null, revoked: !d || !!d.revoked_at, attempts: p.attempts, device_id: p.mobile_device_id } as Due;
      });
    });
  }
}
