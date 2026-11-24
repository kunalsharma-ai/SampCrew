import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { mailFromLine, type TenantMailInput, type TenantMailView } from '@crew/contracts';
import { createTransport } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { decryptField, encryptField } from '../../platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { AuditService } from '../../platform/audit/audit.service';
import { PlatformIntegrationsService } from '../../platform/integrations/platform-integrations.service';
import { isPrivateAddress } from '../integrations/safe-http';

const hint = (v: string) => (v.length <= 8 ? '••••' : `••••${v.slice(-4)}`);

/** A company's own SMTP settings, ready for nodemailer, or null when it has none switched on. */
export interface CompanyMailRuntime { transport: SMTPTransport.Options; from: string; replyTo: string | null; hash: string }

/**
 * Settings > Email setup (issue #83). The company's own outgoing email server, saved by the Super Workspace: the
 * Mailer sends every message of this company through it while it is switched on. The server's name must not point
 * into a private network (checked when it connects), unless the installation allows that for local development.
 */
@Injectable()
export class MailSetupService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly platform: PlatformIntegrationsService,
  ) {}

  private get allowPrivate() {
    return this.config.INTEGRATIONS_ALLOW_PRIVATE_URLS === 'true';
  }

  async get(): Promise<TenantMailView> {
    const tenantId = requestContext.tenantActor().tenantId;
    const row = await this.db.tenant((tx) => tx.collection('tenant_mail_settings').findOne({}));
    // The outgoing queue is a platform table: this company's latest messages, read for it alone, without their bodies.
    const recent = await this.db.platform((tx) => tx.collection('email_messages').find({ tenant_id: tenantId }, { sort: { created_at: -1 }, limit: 15, projection: { to_email: 1, subject: 1, status: 1, created_at: 1, sent_at: 1, last_error: 1 } }));
    const platformOn = Boolean(await this.platform.email());
    return {
      enabled: Boolean(row?.enabled),
      host: (row?.host as string | undefined) ?? null,
      port: (row?.port as number | undefined) ?? 587,
      security: (row?.security as TenantMailView['security'] | undefined) ?? 'starttls',
      username: (row?.username as string | null | undefined) ?? null,
      passwordHint: (row?.secret_hint as string | null | undefined) ?? null,
      fromName: (row?.from_name as string | undefined) ?? '',
      fromAddress: (row?.from_address as string | undefined) ?? null,
      replyTo: (row?.reply_to as string | undefined) ?? '',
      updatedAt: row?.updated_at ? new Date(row.updated_at as string).toISOString() : null,
      updatedBy: (row?.updated_by_name as string | null | undefined) ?? null,
      lastTest: (row?.last_test as TenantMailView['lastTest'] | undefined) ?? null,
      route: row?.enabled ? 'company' : platformOn ? 'sampcrew' : 'none',
      recent: recent.map((m) => ({
        id: m.id as string, to: m.to_email as string, subject: m.subject as string, status: (m.status === 'cancelled' ? 'skipped' : m.status) as TenantMailView['recent'][number]['status'],
        at: new Date((m.sent_at ?? m.created_at) as string).toISOString(), error: (m.last_error as string | null | undefined) ?? null,
      })),
    };
  }

  async save(input: TenantMailInput): Promise<TenantMailView> {
    const actor = requestContext.tenantActor();
    if (this.config.isProductionLike && input.security === 'none') throw Errors.validation([{ path: 'security', message: 'Use STARTTLS or TLS: the password and email would otherwise cross the network unencrypted' }]);
    await this.db.tenant(async (tx) => {
      const table = tx.collection('tenant_mail_settings');
      const before = await table.findOne({});
      const oldSecret = before?.secrets_enc ? (JSON.parse(decryptField(before.secrets_enc as string, this.config.fieldKeys)) as { password?: string }).password : undefined;
      const password = input.password === null ? undefined : input.password ? input.password : oldSecret;
      if (input.enabled && input.username && !password) throw Errors.validation([{ path: 'password', message: 'Enter the password (or API key) for this user name' }]);
      const values = {
        enabled: input.enabled, host: input.host, port: input.port, security: input.security, username: input.username || null,
        from_name: input.fromName, from_address: input.fromAddress, reply_to: input.replyTo,
        secrets_enc: password ? encryptField(JSON.stringify({ password }), this.config.fieldKeys) : '', secret_hint: password ? hint(password) : null,
        updated_by: actor.membershipId, updated_by_name: actor.label,
      };
      if (before) await table.updateOne({ id: before.id }, { $set: values });
      else await table.insert(values);
      const plain = (r: Record<string, unknown> | null | undefined) => (r ? { enabled: r.enabled, host: r.host, port: r.port, security: r.security, username: r.username ?? null, fromName: r.from_name, fromAddress: r.from_address, replyTo: r.reply_to } : null);
      await this.audit.record(tx, {
        action: 'workspace.mail_settings_saved', resourceType: 'tenant', resourceId: actor.tenantId,
        changes: { before: plain(before), after: plain(values), passwordChanged: password !== oldSecret },
      });
    });
    return this.get();
  }

  /** Signs in to the server with the saved settings and, given an address, sends a real test email. */
  async test(sendTo: string): Promise<{ ok: boolean; message: string; view: TenantMailView }> {
    const row = await this.db.tenant((tx) => tx.collection('tenant_mail_settings').findOne({}));
    if (!row) throw Errors.badRequest('mail_not_set_up', 'Save your email server first, then test it.');
    let ok = false;
    let message: string;
    const workspace = await this.db.tenant((tx) => tx.collection('tenants').findOne({}));
    try {
      const options = await connectable(optionsOf(row, this.config), this.allowPrivate);
      const t = createTransport({ ...options, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
      try {
        await t.verify();
        const info = await t.sendMail({
          from: mailFromLine(row.from_name as string, row.from_address as string), to: sendTo, subject: `${workspace?.name ?? 'SampCrew'}: test email from SampCrew`,
          text: `This is a test email from SampCrew for ${workspace?.name ?? 'your company'}. If you can read it, SampCrew can send your invitations, password resets and notices with these settings.`,
          ...(row.reply_to ? { replyTo: row.reply_to as string } : {}),
        });
        ok = true;
        message = `Signed in to ${row.host as string}:${row.port as number} and sent a test email to ${sendTo}${info.response ? ` (server said: ${String(info.response).slice(0, 120)})` : ''}`;
      } finally {
        t.close();
      }
    } catch (e) {
      message = `Email server ${row.host as string}:${row.port as number}: ${(e as Error).message}`.slice(0, 500);
    }
    await this.db.tenant(async (tx) => {
      await tx.collection('tenant_mail_settings').updateOne({ id: row.id }, { $set: { last_test: { at: new Date().toISOString(), ok, message } } });
      await this.audit.record(tx, { action: 'workspace.mail_settings_tested', resourceType: 'tenant', resourceId: requestContext.tenantActor().tenantId, metadata: { ok, sendTo } });
    });
    return { ok, message, view: await this.get() };
  }

}

/** The company's switched-on settings for the Mailer, or null. Called outside any request, by the sender. */
export async function companyMailRuntime(
  tx: { collection: (name: string) => { findOne: (f: Record<string, unknown>) => Promise<Record<string, unknown> | null | undefined> } },
  tenantId: string,
  config: Pick<AppConfig, 'fieldKeys' | 'INTEGRATIONS_ALLOW_PRIVATE_URLS'>,
): Promise<CompanyMailRuntime | null> {
  const row = await tx.collection('tenant_mail_settings').findOne({ tenant_id: tenantId, enabled: true });
  if (!row) return null;
  return {
    transport: await connectable(optionsOf(row, config), config.INTEGRATIONS_ALLOW_PRIVATE_URLS === 'true'),
    from: mailFromLine(row.from_name as string, row.from_address as string),
    replyTo: (row.reply_to as string) || null,
    hash: `${row.id as string}:${new Date(row.updated_at as string).getTime()}`,
  };
}

function optionsOf(row: Record<string, unknown>, config: Pick<AppConfig, 'fieldKeys'>): SMTPTransport.Options {
  const secrets = row.secrets_enc ? (JSON.parse(decryptField(row.secrets_enc as string, config.fieldKeys)) as { password?: string }) : {};
  const security = row.security as 'starttls' | 'tls' | 'none';
  return {
    host: row.host as string, port: row.port as number, secure: security === 'tls', requireTLS: security === 'starttls', ignoreTLS: security === 'none',
    ...(row.username ? { auth: { user: row.username as string, pass: secrets.password ?? '' } } : {}),
  };
}

/**
 * Resolves the server's name once and connects to that address (keeping the name for the TLS certificate check),
 * so a company's settings cannot reach into the installation's private network, also not by changing DNS later.
 */
async function connectable(o: SMTPTransport.Options, allowPrivate: boolean): Promise<SMTPTransport.Options> {
  const name = o.host as string;
  const address = isIP(name) ? name : (await lookup(name)).address;
  if (!allowPrivate && isPrivateAddress(address)) throw new Error(`${name} points to a private network address, which SampCrew does not connect to`);
  return { ...o, host: address, tls: { ...(isIP(name) ? {} : { servername: name }) } };
}
