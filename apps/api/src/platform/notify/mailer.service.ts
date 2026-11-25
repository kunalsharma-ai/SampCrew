import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { MongoService as DatabaseService } from '../database/mongo.service';
import { PlatformIntegrationsService } from '../integrations/platform-integrations.service';
import { StorageService } from '../storage/storage.service';
import { companyMailRuntime } from '../../modules/mail-setup/mail-setup.service';

/** A stored file sent with an email (for example a proposal PDF). */
export interface EmailAttachment { filename: string; contentType: string; storageKey: string }

const MAX_ATTEMPTS = 5;
/** How long a sender holds a message it took, so another server does not send it too. */
const LEASE_SECONDS = 120;

interface QueuedEmail { id: string; tenant_id?: string | null; to_email: string; subject: string; text_body: string; html_body?: string | null; attempts: number; attachments: EmailAttachment[]; next_attempt_at: Date }

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

  /** Whether an email for this company (or, without one, a platform email) would be sent now. */
  async isConfigured(tenantId?: string | null) {
    if (await this.integrations.email()) return true;
    if (!tenantId) return false;
    return this.db.platform(async (tx) => Boolean(await tx.collection('tenant_mail_settings').findOne({ tenant_id: tenantId, enabled: true })));
  }

  /** Companies' own email servers (Settings > Email setup), rebuilt only when their settings change. */
  private readonly companies = new Map<string, { hash: string; transport: Transporter; from: string; replyTo: string | null }>();
  private async companyTransport(tenantId: string) {
    const r = await this.db.platform((tx) => companyMailRuntime(tx, tenantId, this.config));
    const cached = this.companies.get(tenantId);
    if (!r) {
      cached?.transport.close();
      this.companies.delete(tenantId);
      return null;
    }
    if (cached?.hash === r.hash) return cached;
    cached?.transport.close();
    const built = { hash: r.hash, transport: createTransport(r.transport), from: r.from, replyTo: r.replyTo };
    this.companies.set(tenantId, built);
    return built;
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
    for (const c of this.companies.values()) c.transport.close();
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
      const update = (id: string, set: Record<string, unknown>, inc?: Record<string, number>) =>
        this.db.platform((tx) => tx.collection('email_messages').updateOne({ id }, { $set: set, ...(inc ? { $inc: inc } : {}) }));
      for (let n = 0; n < batch; n++) {
        // Each message is taken under a short lease and sent outside any transaction, so a retried transaction
        // never sends an email twice.
        const m = await this.claim();
        if (!m) break;
        // A company with its own email server (Settings > Email setup) sends through it, from its own address.
        let company: Awaited<ReturnType<MailerService['companyTransport']>> = null;
        try {
          company = m.tenant_id ? await this.companyTransport(m.tenant_id) : null;
        } catch (err) {
          // The company's server name did not resolve or points somewhere SampCrew does not connect to: retry later.
          const attempts = m.attempts + 1;
          await update(m.id, { attempts, last_error: (err as Error).message.slice(0, 1000), status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', next_attempt_at: new Date(Date.now() + Math.min(30 * 2 ** attempts, 3600) * 1000) });
          out.failed++;
          continue;
        }
        const via = company ?? smtp;
        if (!via) {
          await update(m.id, { status: 'skipped', last_error: 'Email delivery is not set up (Settings > Email setup in the workspace, or Super Admin Console > Integrations > Email)' });
          out.skipped++;
          continue;
        }
        try {
          const attachments = await Promise.all((m.attachments ?? []).map(async (a) => ({ filename: a.filename, contentType: a.contentType, content: await this.read(a.storageKey) })));
          await via.transport.sendMail({ from: via.from, ...(company?.replyTo ? { replyTo: company.replyTo } : {}), to: m.to_email, subject: m.subject, text: m.text_body, ...(m.html_body ? { html: m.html_body } : {}), attachments });
          await update(m.id, { status: 'sent', sent_at: new Date(), last_error: null }, { attempts: 1 });
          out.sent++;
        } catch (err) {
          const attempts = m.attempts + 1;
          const final = attempts >= MAX_ATTEMPTS;
          await update(m.id, {
            attempts, last_error: (err as Error).message.slice(0, 1000), status: final ? 'failed' : 'queued',
            next_attempt_at: new Date(Date.now() + Math.min(30 * 2 ** attempts, 3600) * 1000),
          });
          this.logger.warn(`Email ${m.id} failed (attempt ${attempts}): ${(err as Error).message}`);
          out.failed++;
        }
      }
    } finally {
      this.running = false;
    }
    return out;
  }

  /** Takes the oldest message that is due, moving next_attempt_at past the lease. */
  private claim(): Promise<QueuedEmail | undefined> {
    return this.db.platform(async (tx) => {
      const messages = tx.collection<QueuedEmail>('email_messages');
      const now = new Date();
      const m = await messages.findOne({ status: 'queued', next_attempt_at: { $lte: now } }, { sort: { created_at: 1 } });
      if (!m) return undefined;
      // Two senders taking the same message write the same document; MongoDB lets only one transaction commit.
      await messages.updateOne({ id: m.id, next_attempt_at: m.next_attempt_at }, { $set: { next_attempt_at: new Date(now.getTime() + LEASE_SECONDS * 1000) } });
      return m;
    });
  }
}
