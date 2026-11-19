import { z } from 'zod';
import { email } from './schemas/common';

/**
 * Communication: HR's emails to people, internal chat (one to one, with HR, groups and departments) and the custom
 * groups both use. Announcements address people the same way (`audienceInput`).
 */

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const ids = (max: number) => z.array(z.uuid()).max(max).default([]);

/** Who something is sent to. `all` reaches everyone; otherwise the union of the lists (at least one person). */
export const audienceInput = z
  .object({
    all: z.boolean().default(false),
    membershipIds: ids(1000),
    departmentIds: ids(100),
    designationIds: ids(100),
    groupIds: ids(50),
  })
  .refine((a) => a.all || a.membershipIds.length + a.departmentIds.length + a.designationIds.length + a.groupIds.length > 0, {
    message: 'Choose who it is for',
    path: ['membershipIds'],
  });
export type AudienceInput = z.infer<typeof audienceInput>;
export const EMPTY_AUDIENCE: AudienceInput = { all: false, membershipIds: [], departmentIds: [], designationIds: [], groupIds: [] };

/** A named list of people HR keeps (for example "Night shift leads"). */
export const commGroupInput = z.object({
  name: text(2, 80),
  description: z.string().trim().max(300).default(''),
  membershipIds: z.array(z.uuid()).min(1).max(1000),
});
export type CommGroupInput = z.infer<typeof commGroupInput>;

// Files ------------------------------------------------------------------------------------------------------

export const COMM_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const COMM_FILE_TYPES = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
] as const;

export interface CommFile { id: string; name: string; type: string; size: number; href: string }

// Chat -------------------------------------------------------------------------------------------------------

export const CONVERSATION_KINDS = ['direct', 'group', 'department', 'hr'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const conversationInput = z.discriminatedUnion('kind', [
  /** One to one with another person; opening it again returns the same conversation. */
  z.object({ kind: z.literal('direct'), membershipId: z.uuid() }),
  /** A group the creator names and fills. */
  z.object({ kind: z.literal('group'), title: text(2, 80), membershipIds: z.array(z.uuid()).min(1).max(200) }),
  /** Everyone in a department (and its sub-departments), kept in step as people join and leave it. HR only. */
  z.object({ kind: z.literal('department'), departmentId: z.uuid(), title: z.string().trim().max(80).optional() }),
  /** An employee's conversation with the HR team. HR can start one with an employee (membershipId). */
  z.object({ kind: z.literal('hr'), membershipId: z.uuid().optional() }),
]);
export type ConversationInput = z.infer<typeof conversationInput>;

export const chatMessageInput = z
  .object({
    body: z.string().trim().max(4000).default(''),
    fileIds: z.array(z.uuid()).max(5).default([]),
    /** Client id for the message, so a retried send does not post it twice. */
    clientId: z.string().trim().max(64).optional(),
  })
  .refine((m) => m.body.length > 0 || m.fileIds.length > 0, { message: 'Write a message or attach a file', path: ['body'] });
export type ChatMessageInput = z.infer<typeof chatMessageInput>;

export const conversationMembersInput = z.object({ add: ids(200), remove: ids(200) });

export const chatMessagesQuery = z.object({
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const chatSearchQuery = z.object({ q: text(2, 100) });

/** Sent: saved. Delivered: every other member's app has received it. Read: every other member has opened it. */
export type MessageDelivery = 'sent' | 'delivered' | 'read';

export interface ChatMessageView {
  id: string;
  conversationId: string;
  senderMembershipId: string | null;
  senderName: string | null;
  body: string;
  files: CommFile[];
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  /** Only on your own messages. */
  delivery: MessageDelivery | null;
  system: boolean;
}

export interface ConversationView {
  id: string;
  kind: ConversationKind;
  title: string;
  subtitle: string | null;
  memberCount: number;
  members: { membershipId: string; name: string | null }[];
  lastMessage: { body: string; senderName: string | null; at: string } | null;
  unread: number;
  muted: boolean;
  /** You may rename it and change its members. */
  canManage: boolean;
  updatedAt: string;
}

// Email ------------------------------------------------------------------------------------------------------

export const EMAIL_STATUSES = ['draft', 'sending', 'sent', 'partly_failed', 'failed'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];
export const RECIPIENT_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const emailInput = z.object({
  subject: text(1, 200),
  /** Rich text as HTML; the server keeps only safe formatting (paragraphs, bold, lists, links...). */
  html: z.string().max(100_000).default(''),
  audience: audienceInput,
  cc: z.array(email).max(20).default([]),
  bcc: z.array(email).max(20).default([]),
  fileIds: z.array(z.uuid()).max(10).default([]),
});
export type EmailInput = z.infer<typeof emailInput>;

/** A draft may be saved half done: no audience and an empty body are fine until it is sent. */
export const emailDraftInput = z.object({
  subject: z.string().trim().max(200).default(''),
  html: z.string().max(100_000).default(''),
  audience: z.object({
    all: z.boolean().default(false), membershipIds: ids(1000), departmentIds: ids(100), designationIds: ids(100), groupIds: ids(50),
  }).default({ all: false, membershipIds: [], departmentIds: [], designationIds: [], groupIds: [] }),
  cc: z.array(email).max(20).default([]),
  bcc: z.array(email).max(20).default([]),
  fileIds: z.array(z.uuid()).max(10).default([]),
});
export type EmailDraftInput = z.infer<typeof emailDraftInput>;

export const emailListQuery = z.object({
  status: z.enum(EMAIL_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  /** Emails one employee was sent (their communication record). */
  employeeId: z.uuid().optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** Plain text from the rich-text HTML, for the text part of an email and for previews. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/(p|div|h[1-6]|blockquote)\s*>/gi, '\n\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_m, href: string, label: string) => (label === href ? href : `${label} (${href})`))
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
