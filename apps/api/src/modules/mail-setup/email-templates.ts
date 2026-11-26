import { Body, Controller, Get, HttpCode, Injectable, Param, Post, Put } from '@nestjs/common';
import {
  cleanEmailHtml, DEFAULT_EMAIL_LAYOUT, EMAIL_PLACEHOLDERS, EMAIL_TEMPLATE_KEYS, EMAIL_TEMPLATE_LABEL, emailTemplateGroup, emailTemplateInput, emailTemplatePreviewInput,
  emailTemplateTestInput, renderEmailSubject, renderEmailTemplate, SAMPLE_EMAIL_TEXT, textToHtml, type EmailTemplateInput, type EmailTemplateKey,
} from '@crew/contracts';
import { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { RequirePermission } from '../../platform/authz/decorators';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, membershipUserNames, type PlatformTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';

const keyPipe = new ZodPipe(z.enum(EMAIL_TEMPLATE_KEYS));

/** The finished email for a queued message: the company's template for its kind, else its layout, else unchanged. */
export async function applyCompanyEmailTemplate(tx: PlatformTx, m: { tenant_id?: string | null; template?: string | null; to_email: string; subject: string; text_body: string; html_body?: string | null }): Promise<{ subject: string; html: string | null }> {
  if (!m.tenant_id || m.template === 'email_template.test') return { subject: m.subject, html: m.html_body ?? null };
  const rows = await tx.collection('email_templates').find({ tenant_id: m.tenant_id, active: true, key: { $in: [emailTemplateGroup(m.template), 'layout'] } });
  const t = rows.find((r) => r.key !== 'layout') ?? rows[0];
  if (!t) return { subject: m.subject, html: m.html_body ?? null };
  const tenant = await tx.collection('tenants').findOne({ id: m.tenant_id }, { projection: { name: 1 } });
  const company = (tenant?.name as string | undefined) ?? '';
  const subject = renderEmailSubject(t.subject as string | null, { subject: m.subject, company_name: company });
  return { subject, html: renderEmailTemplate(t.html as string, { content: m.html_body ?? textToHtml(m.text_body), subject, company_name: company, recipient_email: m.to_email, year: String(new Date().getUTCFullYear()) }) };
}

@Injectable()
export class EmailTemplatesService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  list() {
    return this.db.tenant(async (tx) => {
      const rows = await tx.collection('email_templates').find({});
      const names = await membershipUserNames(tx, rows.map((r) => r.updated_by_membership_id).filter(Boolean));
      return {
        placeholders: EMAIL_PLACEHOLDERS,
        defaultHtml: DEFAULT_EMAIL_LAYOUT,
        templates: EMAIL_TEMPLATE_KEYS.map((key) => {
          const r = rows.find((x) => x.key === key);
          return {
            key, ...EMAIL_TEMPLATE_LABEL[key], saved: !!r, active: !!r?.active, subject: (r?.subject ?? null) as string | null, html: (r?.html ?? null) as string | null,
            version: (r?.version ?? 0) as number, sourceFileName: (r?.source_file_name ?? null) as string | null, updatedAt: r?.updated_at ? (r.updated_at as Date).toISOString() : null,
            updatedBy: r?.updated_by_membership_id ? names.get(r.updated_by_membership_id) ?? null : null,
          };
        }),
      };
    });
  }

  /** Saves (imports) a template. The earlier HTML is replaced; the change and its size are recorded in the audit log. */
  save(key: EmailTemplateKey, input: EmailTemplateInput) {
    return this.db.tenant(async (tx) => {
      const me = requestContext.tenantActor().membershipId;
      const html = cleanEmailHtml(input.html);
      if (!/\{\{\s*content\s*\}\}/.test(html)) throw Errors.validation([{ path: 'html', message: 'Put {{content}} where the message should go' }]);
      const prev = await tx.collection('email_templates').findOne({ key });
      const row = { name: input.name ?? null, subject: input.subject?.trim() || null, html, active: input.active, source_file_name: input.sourceFileName ?? null, updated_by_membership_id: me };
      if (prev) await tx.collection('email_templates').updateOne({ id: prev.id }, { $set: { ...row, updated_at: new Date() }, $inc: { version: 1 } });
      else await tx.collection('email_templates').insert({ key, ...row });
      await this.audit.record(tx, { action: prev ? 'email_template.changed' : 'email_template.imported', resourceType: 'email_template', resourceId: key, metadata: { key, active: input.active, chars: html.length, file: input.sourceFileName ?? null, scriptsRemoved: html.length !== input.html.length } });
    }).then(() => this.list());
  }

  /** Back to SampCrew's plain emails for this kind: the template is switched off and kept. */
  reset(key: EmailTemplateKey) {
    return this.db.tenant(async (tx) => {
      const prev = await tx.collection('email_templates').findOne({ key });
      if (!prev) return;
      await tx.collection('email_templates').updateOne({ id: prev.id }, { $set: { active: false, updated_by_membership_id: requestContext.tenantActor().membershipId, updated_at: new Date() } });
      await this.audit.record(tx, { action: 'email_template.reset', resourceType: 'email_template', resourceId: key, metadata: { key } });
    }).then(() => this.list());
  }

  preview(input: z.infer<typeof emailTemplatePreviewInput>) {
    return this.db.tenant(async (tx) => {
      const tenant = await tx.collection('tenants').findOne({});
      const company = (tenant?.name as string | undefined) ?? 'Your company';
      const subject = renderEmailSubject(input.subject, { subject: 'Leave approved', company_name: company });
      return { subject, html: renderEmailTemplate(input.html, { content: textToHtml(SAMPLE_EMAIL_TEXT), subject, company_name: company, recipient_email: 'priya@example.com', year: String(new Date().getUTCFullYear()) }) };
    });
  }

  /** Queues a real email through the company's email route, with the template given (or the saved one). */
  test(key: EmailTemplateKey, input: z.infer<typeof emailTemplateTestInput>) {
    return this.db.tenant(async (tx) => {
      const saved = await tx.collection('email_templates').findOne({ key });
      const html = input.html ?? (saved?.html as string | undefined);
      if (!html) throw Errors.badRequest('no_template', 'Import or write a template first');
      const tenant = await tx.collection('tenants').findOne({});
      const company = (tenant?.name as string | undefined) ?? '';
      const subject = `Test: ${renderEmailSubject(input.subject ?? (saved?.subject as string | undefined), { subject: 'Leave approved', company_name: company })}`;
      const out = renderEmailTemplate(html, { content: textToHtml(SAMPLE_EMAIL_TEXT), subject, company_name: company, recipient_email: input.sendTo, year: String(new Date().getUTCFullYear()) });
      await tx.collection('email_messages').insert({ tenant_id: tx.tenantId, to_email: input.sendTo, subject, text_body: SAMPLE_EMAIL_TEXT, html_body: out, template: 'email_template.test' });
      await this.audit.record(tx, { action: 'email_template.tested', resourceType: 'email_template', resourceId: key, metadata: { key, sendTo: input.sendTo } });
      return { ok: true, message: `A test email is on its way to ${input.sendTo}. Check Email setup for its delivery status.` };
    });
  }
}

/** Settings > Email templates: the company's own email design (Super Workspace). */
@Controller('settings/email-templates')
export class EmailTemplatesController {
  constructor(private readonly templates: EmailTemplatesService) {}

  @Get()
  @RequirePermission('mail:configure')
  @Doc({ summary: "The company's email templates (every email, and each kind of email) with the placeholders they can use" })
  list() {
    return this.templates.list();
  }

  @Put(':key')
  @RequirePermission('mail:configure')
  @Doc({ summary: 'Import or change a template (HTML with {{content}}). Scripts and event handlers are removed.', body: emailTemplateInput })
  save(@Param('key', keyPipe) key: EmailTemplateKey, @Body(new ZodPipe(emailTemplateInput)) body: EmailTemplateInput) {
    return this.templates.save(key, body);
  }

  @Post(':key/reset')
  @HttpCode(200)
  @RequirePermission('mail:configure')
  @Doc({ summary: "Go back to SampCrew's plain emails for this kind (the template is kept, switched off)" })
  reset(@Param('key', keyPipe) key: EmailTemplateKey) {
    return this.templates.reset(key);
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('mail:configure')
  @Doc({ summary: 'The template filled in with a sample message', body: emailTemplatePreviewInput })
  preview(@Body(new ZodPipe(emailTemplatePreviewInput)) body: z.infer<typeof emailTemplatePreviewInput>) {
    return this.templates.preview(body);
  }

  @Post(':key/test')
  @HttpCode(200)
  @RequirePermission('mail:configure')
  @Doc({ summary: 'Send a test email with this template', body: emailTemplateTestInput })
  test(@Param('key', keyPipe) key: EmailTemplateKey, @Body(new ZodPipe(emailTemplateTestInput)) body: z.infer<typeof emailTemplateTestInput>) {
    return this.templates.test(key, body);
  }
}
