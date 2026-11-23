import { z } from 'zod';
import { PLATFORM_LEVEL_LABEL } from './hierarchy';

/**
 * SampCrew Support chat: a private, persistent conversation between one Super Workspace (the customer company) and
 * the Console Admin team (SAMPLEDGE). Only the Super Workspace level of that company and authorised Console Admins
 * can reach it; HR Workspace, Employee Workspace and other companies cannot. Any Console Admin may answer, and each
 * message records who actually sent it.
 *
 * Sender identity is shared with the internal chat: every message carries the sender's name, level (Super, HR or
 * Employee Workspace, or Console Admin) and workspace (the company, or the HR Workspace a person belongs to).
 */

/** What the Console Admin team is called on screen. */
export const CONSOLE_ADMIN_LABEL = 'Console Admin';
export const CONSOLE_TEAM_NAME = 'SampCrew Support';

/** Levels a message sender can have. */
export const SENDER_LEVELS = ['console', 'super', 'hr', 'employee'] as const;
export type SenderLevel = (typeof SENDER_LEVELS)[number];
export const SENDER_LEVEL_LABEL: Record<SenderLevel, string> = {
  console: CONSOLE_ADMIN_LABEL,
  super: PLATFORM_LEVEL_LABEL.super,
  hr: PLATFORM_LEVEL_LABEL.hr,
  employee: PLATFORM_LEVEL_LABEL.employee,
};

/** Who sent a message: name, level and the workspace they belong to (company or HR Workspace name). */
export interface SenderIdentity {
  name: string;
  level: SenderLevel;
  levelLabel: string;
  workspace: string | null;
}

/** "Super Workspace · Acme Corp": the line shown under a sender's name. */
export function senderLine(s: Pick<SenderIdentity, 'levelLabel' | 'workspace'> | null | undefined): string {
  if (!s) return '';
  return s.workspace ? `${s.levelLabel} · ${s.workspace}` : s.levelLabel;
}

export function senderIdentity(name: string, level: SenderLevel, workspace: string | null): SenderIdentity {
  return { name, level, levelLabel: SENDER_LEVEL_LABEL[level], workspace };
}

export const SUPPORT_CATEGORIES = ['question', 'technical', 'account', 'billing', 'feature', 'other'] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export const SUPPORT_CATEGORY_LABEL: Record<SupportCategory, string> = {
  question: 'Question',
  technical: 'Technical issue',
  account: 'Account',
  billing: 'Billing',
  feature: 'Product feedback',
  other: 'Other',
};

export const SUPPORT_STATUSES = ['open', 'resolved'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/**
 * Where a conversation stands for the side looking at it.
 * unread: new messages from the other side you have not opened. waiting: your side owes a reply (Console) or the
 * Console team owes one (workspace). replied: the last message is your side's. resolved: closed (a new message reopens it).
 */
export const SUPPORT_STATES = ['unread', 'waiting', 'replied', 'resolved'] as const;
export type SupportState = (typeof SUPPORT_STATES)[number];
export const SUPPORT_STATE_LABEL: Record<SupportState, string> = { unread: 'Unread', waiting: 'Waiting for reply', replied: 'Replied', resolved: 'Resolved' };

const body = z.string().trim().min(1, 'Write a message').max(4000);

export const supportConversationInput = z.object({
  subject: z.string().trim().min(3, 'Give the conversation a short subject').max(120),
  category: z.enum(SUPPORT_CATEGORIES).default('question'),
  body,
  clientId: z.string().trim().max(64).optional(),
});
export type SupportConversationInput = z.infer<typeof supportConversationInput>;

export const supportMessageInput = z.object({
  body,
  /** Client id for the message, so a retried send does not post it twice. */
  clientId: z.string().trim().max(64).optional(),
});
export type SupportMessageInput = z.infer<typeof supportMessageInput>;

export const supportStatusInput = z.object({ status: z.enum(SUPPORT_STATUSES) });

export const supportListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  state: z.enum(SUPPORT_STATES).optional(),
  /** Console only: one Super Workspace's conversations. */
  tenantId: z.uuid().optional(),
});
export type SupportListQuery = z.infer<typeof supportListQuery>;

/** Sent: saved. Delivered: the other side's app has it. Read: someone on the other side opened it. */
export type SupportDelivery = 'sent' | 'delivered' | 'read';

export interface SupportMessageView {
  id: string;
  conversationId: string;
  sender: SenderIdentity;
  fromConsole: boolean;
  /** Sent by the person looking at it. */
  mine: boolean;
  /** Sent by the side looking at it (your team), so it shows on the right. */
  ourSide: boolean;
  body: string;
  createdAt: string;
  /** Only on your side's messages. */
  delivery: SupportDelivery | null;
  system: boolean;
}

export interface SupportConversationView {
  id: string;
  number: number;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  state: SupportState;
  workspace: { id: string; name: string; slug: string };
  startedBy: SenderIdentity | null;
  lastMessage: { body: string; senderName: string; fromConsole: boolean; at: string } | null;
  unread: number;
  /** Console only: the Console Admin who answered last. */
  handledBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportConversationDetail {
  conversation: SupportConversationView;
  messages: SupportMessageView[];
  hasOlder: boolean;
  /** Console only: about the Super Workspace that wrote. */
  workspaceInfo?: { status: string; plan: string | null; country: string | null; superWorkspace: { name: string }[]; people: number; createdAt: string } | null;
}
