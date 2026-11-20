import type { AudienceInput, ChatMessageView, CommFile, ConversationView, EmailStatus } from '@crew/contracts';

export interface Person { membershipId: string; name: string; department: string | null; designation: string | null }
export interface ConversationList { items: ConversationView[]; unread: number; isHr: boolean }
export interface ConversationDetail { conversation: ConversationView & { asHr: boolean }; messages: ChatMessageView[]; hasOlder: boolean }

export interface EmailRow {
  id: string; subject: string; status: EmailStatus; preview: string; audience: AudienceInput; audienceLabel: string; cc: string[]; bcc: string[];
  recipientCount: number; sentCount: number; failedCount: number; fileCount: number; createdByName: string | null; sentByName: string | null;
  createdAt: string; updatedAt: string; sentAt: string | null;
}
export interface EmailDetail extends EmailRow {
  html: string; text: string; files: CommFile[];
  recipients: { id: string; kind: 'to' | 'cc' | 'bcc'; address: string; name: string | null; employeeId: string | null; status: 'queued' | 'sent' | 'failed' | 'skipped'; error: string | null; sentAt: string | null }[];
}
export interface InboxEmail { id: string; subject: string; html: string; sentAt: string | null; sentByName: string | null; files: CommFile[] }
export interface Group { id: string; name: string; description: string; updatedAt: string; chatConversationId?: string | null; members: { membershipId: string; name: string | null }[] }

export interface Dashboard {
  email: { sent30: number; recipients30: number; delivered30: number; failed30: number; drafts: number; deliveryRate: number | null };
  chat: { messages7: number; activeConversations7: number; waitingForHr: number };
  helpdesk: { openCases: number };
  hrTeamSize: number;
  youAreInHrTeam: boolean;
  waiting: { conversationId: string; employeeName: string; preview: string; at: string | null }[];
  recentEmails: { id: string; subject: string; status: EmailStatus; recipientCount: number; sentCount: number; failedCount: number; audienceLabel: string; sentAt: string | null; sentByName: string | null }[];
}

export interface EmployeeRecord {
  employeeId: string; membershipId: string | null; name: string;
  emails: { emailId: string; subject: string; preview: string; status: string; address: string; error: string | null; sentAt: string | null }[];
  hrConversation: { id: string; lastMessage: string | null; at: string | null } | null;
  cases: { id: string; subject: string; status: string; number: number; createdAt: string | null }[];
}

export const EMAIL_STATUS_LABEL: Record<string, string> = { draft: 'Draft', sending: 'Sending', sent: 'Sent', partly_failed: 'Partly failed', failed: 'Failed' };
export const EMAIL_STATUS_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = { draft: 'neutral', sending: 'info', sent: 'success', partly_failed: 'warning', failed: 'danger' };
export const RECIPIENT_LABEL: Record<string, string> = { queued: 'Queued', sent: 'Sent', failed: 'Failed', skipped: 'Not sent' };
export const RECIPIENT_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = { queued: 'info', sent: 'success', failed: 'danger', skipped: 'warning' };
