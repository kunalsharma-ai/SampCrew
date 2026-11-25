import { z } from 'zod';
import { SMTP_SECURITY } from './platform-integrations';

/**
 * Settings > Email setup (issue #83): the company's own outgoing email server. When it is switched on, every email
 * SampCrew sends for this company (invitations, password resets, notices, payslips...) goes out through it, from the
 * company's own address. Without it, the email server SAMPLEDGE set up in the Super Admin Console is used, and when
 * neither exists nothing is sent: the message is kept as "not sent" with the reason, never reported as delivered.
 *
 * The password is stored only in the database, encrypted with the field encryption key, and is never sent back to the
 * browser (only its last characters are shown), the same as the Console's own integrations.
 */
const host = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, 'Enter a host name such as smtp.office365.com (no protocol or port)');
const address = z.email('Enter an email address such as hr@yourcompany.com').max(200);

export const tenantMailInput = z.object({
  enabled: z.boolean(),
  host,
  port: z.number().int().min(1).max(65535),
  security: z.enum(SMTP_SECURITY),
  username: z.string().trim().max(200).optional(),
  /** Empty or missing keeps the password already saved; null removes it. */
  password: z.string().max(2000).nullable().optional(),
  /** The name people see the email from, such as "Northwind HR". */
  fromName: z.string().trim().max(100).regex(/^[^<>"@\r\n]*$/, 'Use letters and spaces, without < > " or @').default(''),
  fromAddress: address,
  /** Where replies go, when not the From address. */
  replyTo: z.union([z.literal(''), address]).default(''),
}).strict();
export type TenantMailInput = z.infer<typeof tenantMailInput>;

export const tenantMailTestInput = z.object({ sendTo: address }).strict();

/** How email leaves SampCrew for this company right now. */
export type MailDeliveryRoute = 'company' | 'sampcrew' | 'none';

export interface TenantMailView {
  enabled: boolean;
  host: string | null;
  port: number;
  security: (typeof SMTP_SECURITY)[number];
  username: string | null;
  /** The saved password's last characters (null: none saved). */
  passwordHint: string | null;
  fromName: string;
  fromAddress: string | null;
  replyTo: string;
  updatedAt: string | null;
  updatedBy: string | null;
  lastTest: { at: string; ok: boolean; message: string } | null;
  /** The route in effect: the company's own server, SampCrew's (set up by SAMPLEDGE), or none (nothing is sent). */
  route: MailDeliveryRoute;
  /** The latest emails SampCrew tried to send for this company, newest first (no message bodies). */
  recent: { id: string; to: string; subject: string; status: 'queued' | 'sent' | 'failed' | 'skipped'; at: string; error: string | null }[];
}

/** The From line of a company's emails: `Name <address>`, or the address alone. */
export const mailFromLine = (name: string, address: string) => (name.trim() ? `${name.trim().replace(/["<>]/g, '')} <${address}>` : address);
