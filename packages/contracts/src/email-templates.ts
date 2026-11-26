import { z } from 'zod';

/**
 * Company email templates (issue #89 point 13): a company imports its own HTML design, for every email it sends
 * (layout) or for one kind of email. The message SampCrew writes goes where the template has {{content}}.
 * Without an active template an email goes out as plain text, as before.
 */
export const EMAIL_TEMPLATE_KEYS = ['layout', 'account', 'notification', 'recruitment', 'communication'] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];
export const EMAIL_TEMPLATE_LABEL: Record<EmailTemplateKey, { name: string; description: string }> = {
  layout: { name: 'Every email', description: 'Used for every email your company sends, unless a kind below has its own template.' },
  account: { name: 'Logins and invitations', description: 'Invitations to SampCrew, new logins and workspace setup emails.' },
  notification: { name: 'Notifications', description: 'Approvals, reminders, leave, attendance, documents and other notices sent by email.' },
  recruitment: { name: 'Candidates', description: 'Emails to job applicants: application received, interviews, offers and messages.' },
  communication: { name: 'Emails from HR', description: 'Emails HR writes to employees from Communication.' },
};

/** The kind of template an email uses, from the template name the email was queued with. */
export function emailTemplateGroup(template: string | null | undefined): Exclude<EmailTemplateKey, 'layout'> {
  const t = template ?? '';
  if (t.startsWith('candidate.')) return 'recruitment';
  if (t.startsWith('communication.')) return 'communication';
  if (t === 'invitation' || t.startsWith('membership.') || t.startsWith('tenant.') || t.startsWith('auth.')) return 'account';
  return 'notification';
}

export const EMAIL_PLACEHOLDERS = [
  { key: 'content', description: 'The message itself. Required.' },
  { key: 'subject', description: 'The email subject.' },
  { key: 'company_name', description: 'Your company name.' },
  { key: 'recipient_email', description: 'Who the email is going to.' },
  { key: 'year', description: 'The current year, for a copyright line.' },
] as const;

export const EMAIL_TEMPLATE_MAX_CHARS = 200_000;

/** Takes out what email clients block anyway and what could run code in a preview: scripts, handlers, javascript: links. */
export function cleanEmailHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<(iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(iframe|object|embed|form|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

export const emailTemplateInput = z.object({
  name: z.string().trim().max(120).optional(),
  /** The subject line; {{subject}} keeps the one SampCrew wrote. Empty keeps it unchanged. */
  subject: z.string().trim().max(300).optional(),
  html: z.string().max(EMAIL_TEMPLATE_MAX_CHARS, 'The template is too large: keep it under 200 KB').refine((h) => /\{\{\s*content\s*\}\}/.test(h), 'Put {{content}} where the message should go'),
  active: z.boolean().default(true),
  sourceFileName: z.string().trim().max(200).optional(),
}).strict();
export type EmailTemplateInput = z.infer<typeof emailTemplateInput>;
export const emailTemplatePreviewInput = z.object({ html: z.string().max(EMAIL_TEMPLATE_MAX_CHARS), subject: z.string().max(300).optional() }).strict();
export const emailTemplateTestInput = z.object({ sendTo: z.email().max(254), html: z.string().max(EMAIL_TEMPLATE_MAX_CHARS).optional(), subject: z.string().max(300).optional() }).strict();

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** Plain text as HTML paragraphs, with links clickable. */
export function textToHtml(text: string): string {
  return text.trim().split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join('\n');
}

export interface EmailVars { content: string; subject: string; company_name: string; recipient_email: string; year: string }

/** Fills a template. {{content}} is HTML already; every other value is escaped. Unknown placeholders are left empty. */
export function renderEmailTemplate(html: string, vars: EmailVars): string {
  return cleanEmailHtml(html).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => (k === 'content' ? vars.content : k in vars ? escapeHtml(String(vars[k as keyof EmailVars])) : ''));
}

export function renderEmailSubject(subject: string | null | undefined, vars: Pick<EmailVars, 'subject' | 'company_name'>): string {
  if (!subject?.trim()) return vars.subject;
  return subject.replace(/\{\{\s*(subject|company_name)\s*\}\}/g, (_, k: 'subject' | 'company_name') => vars[k]).slice(0, 300);
}

/** The starting point offered in the editor: a clean, branded layout to adjust or replace with an imported file. */
export const DEFAULT_EMAIL_LAYOUT = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2430">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden">
          <tr><td style="background:#1f2a44;color:#ffffff;padding:20px 28px;font-size:18px;font-weight:bold">{{company_name}}</td></tr>
          <tr><td style="padding:28px;font-size:15px;line-height:1.55">{{content}}</td></tr>
          <tr><td style="padding:16px 28px;border-top:1px solid #e6e8ec;color:#6b7280;font-size:12px">&copy; {{year}} {{company_name}}. This email was sent to {{recipient_email}}.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

export const SAMPLE_EMAIL_TEXT = 'Hello Priya,\n\nYour leave request for 2 days from 12 December was approved.\n\nOpen SampCrew: https://app.sampcrew.com/leave';
