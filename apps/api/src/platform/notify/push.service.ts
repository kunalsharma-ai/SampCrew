import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import { PlatformIntegrationsService } from '../integrations/platform-integrations.service';

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
      await this.db.platform(async (tx) => {
        const { rows } = await tx.query<Due>(
          `select p.id, p.notification_id, n.link, d.push_token, d.revoked_at is not null as revoked, p.attempts, d.id as device_id
             from push_messages p join mobile_devices d on d.id = p.mobile_device_id left join notifications n on n.id = p.notification_id
            where p.status = 'queued' and p.next_attempt_at <= now() order by p.created_at limit $1 for update of p skip locked`,
          [batch],
        );
        const skip = async (id: string, reason: string) => {
          await tx.query(`update push_messages set status = 'skipped', last_error = $2 where id = $1`, [id, reason]);
          out.skipped++;
        };
        const sendable: Due[] = [];
        for (const m of rows) {
          if (!settings.enabled) await skip(m.id, 'Push delivery is not set up (Super Admin Console > Integrations > Mobile push)');
          else if (m.revoked || !m.push_token) await skip(m.id, 'The device was signed out or turned push off');
          else sendable.push(m);
        }
        if (!sendable.length) return;
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
            await tx.query(`update push_messages set status = 'sent', sent_at = now(), attempts = attempts + 1, ticket_id = $2, last_error = null where id = $1`, [m.id, t.id ?? null]);
            out.sent++;
            continue;
          }
          const error = t ? `${t.details?.error ?? 'error'}: ${t.message ?? ''}`.slice(0, 1000) : (failure ?? 'No answer for this message').slice(0, 1000);
          if (t?.details?.error === 'DeviceNotRegistered') {
            // The app was uninstalled or the token expired: stop sending to it.
            await tx.query(`update mobile_devices set push_token = null, push_token_updated_at = now() where id = $1`, [m.device_id]);
            await tx.query(`update push_messages set status = 'failed', attempts = attempts + 1, last_error = $2 where id = $1`, [m.id, error]);
            out.failed++;
            continue;
          }
          const attempts = m.attempts + 1;
          await tx.query(
            `update push_messages set attempts = $2, last_error = $3, status = case when $4 then 'failed' else 'queued' end,
               next_attempt_at = now() + make_interval(secs => $5) where id = $1`,
            [m.id, attempts, error, attempts >= MAX_ATTEMPTS, Math.min(30 * 2 ** attempts, 3600)],
          );
          out.failed++;
        }
        if (failure) this.logger.warn(`Push batch failed: ${failure}`);
      });
    } finally {
      this.running = false;
    }
    return out;
  }
}
