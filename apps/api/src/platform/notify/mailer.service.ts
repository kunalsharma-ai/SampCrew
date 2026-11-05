import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import { PlatformIntegrationsService } from '../integrations/platform-integrations.service';
import { StorageService } from '../storage/storage.service';

/** A stored file sent with an email (for example a proposal PDF). */
export interface EmailAttachment { filename: string; contentType: string; storageKey: string }

const MAX_ATTEMPTS = 5;

/**
 * Sends queued email over SMTP, with the email settings SAMPLEDGE saved in the Super Admin Console (Integrations),
 * else SMTP_URL from the environment. While email is not set up nothing is sent: messages are marked 'skipped' with
 * a clear reason, so the product never claims an email went out when it did not.
 */
@Injectable()
export class MailerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Mailer');
  private built?: { hash: string; transport: Transporter; from: string };
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly storage: StorageService,
    private readonly integrations: PlatformIntegrationsService,
  ) {}

  async isConfigured() {
    return Boolean(await this.integrations.email());
  }

  /** The SMTP transport for the settings in effect, rebuilt only when they change. */
  private async transport(): Promise<{ transport: Transporter; from: string } | null> {
    const e = await this.integrations.email();
    if (!e) return null;
    if (this.built?.hash !== e.hash) {
      this.built?.transport.close();
      this.built = { hash: e.hash, transport: createTransport(e.transport), from: e.from };
    }
    return this.built;
  }

  onApplicationBootstrap() {
    if (this.config.CREW_DISABLE_DISPATCHER === 'true') return;
    // Like the outbox: a database blip is logged and retried on the next tick, never an unhandled rejection.
    this.timer = setInterval(() => void this.sendBatch().catch((err: Error) => this.logger.error(`Email batch failed: ${err.message}`)), 2000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.built?.transport.close();
  }

  private async read(key: string): Promise<Buffer> {
    const { stream } = await this.storage.open(key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  /** Sends one batch of due messages. Exposed for tests and for a dedicated worker process. */
  async sendBatch(batch = 25): Promise<{ sent: number; failed: number; skipped: number }> {
    const out = { sent: 0, failed: 0, skipped: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      const smtp = await this.transport();
      await this.db.platform(async (tx) => {
        const { rows } = await tx.query<{ id: string; to_email: string; subject: string; text_body: string; attempts: number; attachments: EmailAttachment[] }>(
          `select id, to_email::text, subject, text_body, attempts, attachments from email_messages
            where status = 'queued' and next_attempt_at <= now() order by created_at limit $1 for update skip locked`,
          [batch],
        );
        for (const m of rows) {
          if (!smtp) {
            await tx.query(`update email_messages set status = 'skipped', last_error = 'Email delivery is not set up (Super Admin Console > Integrations > Email)' where id = $1`, [m.id]);
            out.skipped++;
            continue;
          }
          try {
            const attachments = await Promise.all((m.attachments ?? []).map(async (a) => ({ filename: a.filename, contentType: a.contentType, content: await this.read(a.storageKey) })));
            await smtp.transport.sendMail({ from: smtp.from, to: m.to_email, subject: m.subject, text: m.text_body, attachments });
            await tx.query(`update email_messages set status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = null where id = $1`, [m.id]);
            out.sent++;
          } catch (err) {
            const attempts = m.attempts + 1;
            const final = attempts >= MAX_ATTEMPTS;
            await tx.query(
              `update email_messages set attempts = $2, last_error = $3, status = case when $4 then 'failed' else 'queued' end,
                 next_attempt_at = now() + make_interval(secs => $5) where id = $1`,
              [m.id, attempts, (err as Error).message.slice(0, 1000), final, Math.min(30 * 2 ** attempts, 3600)],
            );
            this.logger.warn(`Email ${m.id} failed (attempt ${attempts}): ${(err as Error).message}`);
            out.failed++;
          }
        }
      });
    } finally {
      this.running = false;
    }
    return out;
  }
}
