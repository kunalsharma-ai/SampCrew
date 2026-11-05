import { z } from 'zod';

/**
 * Integrations: the public event catalogue for outgoing webhooks, the scopes an API key can have, and the
 * catalogue of connectors (what is available now and what is planned). Webhook payloads are deliberately thin:
 * they carry ids and the names of what changed, never personal details, so a receiver fetches what it needs
 * through the API with a key that has the right scopes.
 */

export interface WebhookEventDef {
  type: string;
  group: string;
  label: string;
  /** Keys copied from the internal event into the webhook's `data`; everything else is dropped. */
  dataKeys: readonly string[];
}

export const WEBHOOK_EVENTS = [
  { type: 'employee.created', group: 'People', label: 'An employee record is created', dataKeys: ['employeeId'] },
  { type: 'employee.changed', group: 'People', label: 'An employee record is edited', dataKeys: ['employeeId', 'fields'] },
  { type: 'employee.job_changed', group: 'People', label: 'An employee changes job (transfer, promotion, new manager)', dataKeys: ['employeeId', 'effectiveFrom', 'changed'] },
  { type: 'employee.confirmed', group: 'People', label: 'An employee is confirmed after probation', dataKeys: ['employeeId'] },
  { type: 'employee.exit_scheduled', group: 'People', label: 'An exit is scheduled', dataKeys: ['employeeId'] },
  { type: 'employee.exit_withdrawn', group: 'People', label: 'A scheduled exit is withdrawn', dataKeys: ['employeeId'] },
  { type: 'employee.exited', group: 'People', label: 'An employee leaves (last working day passed)', dataKeys: ['employeeId'] },
  { type: 'leave.requested', group: 'Leave', label: 'Someone applies for leave', dataKeys: ['leaveRequestId', 'employeeId'] },
  { type: 'leave.approved', group: 'Leave', label: 'A leave request is approved', dataKeys: ['leaveRequestId', 'employeeId'] },
  { type: 'helpdesk.case_created', group: 'Helpdesk', label: 'A helpdesk case is raised (never confidential ones)', dataKeys: ['caseId', 'employeeId'] },
  { type: 'payroll.run_finalised', group: 'Payroll', label: 'A payroll run is approved and finalised', dataKeys: ['runId', 'legalEntityId', 'periodStart', 'periodEnd'] },
  { type: 'workflow.webhook', group: 'Automation', label: 'A workflow step sends to this endpoint', dataKeys: ['workflowId', 'workflowName', 'runId', 'message', 'values'] },
] as const satisfies readonly WebhookEventDef[];

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number]['type'];
export const WEBHOOK_EVENT_TYPES = WEBHOOK_EVENTS.map((e) => e.type) as WebhookEventType[];
/** Sent by "Send test event"; every endpoint can receive it whatever it subscribes to. */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

export function webhookEvent(type: string): WebhookEventDef | undefined {
  return (WEBHOOK_EVENTS as readonly WebhookEventDef[]).find((e) => e.type === type);
}

/** The body CREW posts: { id, type, createdAt, workspaceId, data }. */
export function webhookBody(e: { id: string; type: string; occurredAt: string; tenantId: string; payload: Record<string, unknown> }) {
  const def = webhookEvent(e.type);
  const data = def ? Object.fromEntries(def.dataKeys.filter((k) => k in e.payload).map((k) => [k, e.payload[k]])) : e.payload;
  return { id: e.id, type: e.type, createdAt: e.occurredAt, workspaceId: e.tenantId, data };
}

/** Retry schedule after a failed attempt (attempt n waits RETRY_DELAYS_S[n-1] seconds). 6 attempts over about 13 hours. */
export const WEBHOOK_RETRY_DELAYS_S = [60, 300, 1800, 7200, 36000] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_S.length + 1;
/** An endpoint that fails this many attempts in a row is disabled and its owner told. */
export const WEBHOOK_DISABLE_AFTER = 15;
/** Signatures older than this are rejected by a careful receiver (replay protection). */
export const WEBHOOK_TOLERANCE_S = 300;

// API keys ---------------------------------------------------------------------------------------------------------

/** Read-only permissions an API key may carry. Anything needing two-step verification is not allowed. */
export const API_KEY_SCOPES = [
  'org:read', 'employees:read', 'leave:read', 'attendance:read', 'shifts:read', 'requisitions:read', 'candidates:read',
  'learning:read', 'performance:read', 'announcements:read', 'reports:read', 'audit:read',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const API_KEY_PREFIX = 'crew_';

/** crew_<10-char prefix>_<secret>. Returns null for anything else. */
export function parseApiKey(token: string): { prefix: string; secret: string } | null {
  const m = /^crew_([a-z0-9]{10})_([A-Za-z0-9_-]{32,64})$/.exec(token);
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}

export const apiKeyInput = z.object({
  name: z.string().trim().min(3).max(80),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length).refine((s) => new Set(s).size === s.length, 'Each scope once'),
  /** Days until the key stops working; null for no expiry. */
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365), z.null()]).default(90),
});
export type ApiKeyInput = z.infer<typeof apiKeyInput>;

// Webhooks ---------------------------------------------------------------------------------------------------------

export const webhookEndpointInput = z.object({
  name: z.string().trim().min(3).max(80),
  url: z.url({ protocol: /^https?$/ }).max(2000),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES as [WebhookEventType, ...WebhookEventType[]])).min(1).max(50).refine((s) => new Set(s).size === s.length, 'Each event once'),
});
export type WebhookEndpointInput = z.infer<typeof webhookEndpointInput>;

// Connectors -------------------------------------------------------------------------------------------------------

/** Slack incoming webhook URLs: https://hooks.slack.com/services/T…/B…/… */
export const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+$/;

export const slackConnectionInput = z.object({
  name: z.string().trim().min(3).max(80),
  webhookUrl: z.string().trim().max(500).regex(SLACK_WEBHOOK_RE, 'Paste the incoming webhook URL Slack gave you (it starts with https://hooks.slack.com/services/)'),
});
export type SlackConnectionInput = z.infer<typeof slackConnectionInput>;

export type ConnectorStatus = 'available' | 'planned';
export interface ConnectorDef { key: string; name: string; category: string; status: ConnectorStatus; description: string }

/** What the marketplace lists. "planned" connectors have no connect button: they are not built yet. */
export const CONNECTORS: readonly ConnectorDef[] = [
  { key: 'webhooks', name: 'Outgoing webhooks', category: 'Developer', status: 'available', description: 'Send signed events to your own systems when people join, change job, take leave, raise a case or get paid.' },
  { key: 'api_keys', name: 'REST API keys', category: 'Developer', status: 'available', description: 'Let another system read CREW data through the API, limited to the scopes you choose.' },
  { key: 'slack', name: 'Slack', category: 'Communication', status: 'available', description: 'Post messages to a Slack channel from Automation Studio workflows, using an incoming webhook you create in Slack.' },
  { key: 'microsoft_teams', name: 'Microsoft Teams', category: 'Communication', status: 'planned', description: 'Post to Teams channels and send approval cards.' },
  { key: 'google_workspace', name: 'Google Calendar and Gmail', category: 'Calendar and mail', status: 'planned', description: 'Book interviews in calendars and send mail from your domain.' },
  { key: 'microsoft_365', name: 'Microsoft 365 calendar and mail', category: 'Calendar and mail', status: 'planned', description: 'Book interviews in Outlook calendars and send mail from your domain.' },
  { key: 'whatsapp', name: 'WhatsApp Business', category: 'Communication', status: 'planned', description: 'Reach shop-floor staff on WhatsApp through the official Business Platform.' },
  { key: 'sms', name: 'SMS', category: 'Communication', status: 'planned', description: 'Text messages for sign-in codes and urgent notices.' },
  { key: 'accounting', name: 'Accounting (Tally, Zoho Books, Xero, QuickBooks)', category: 'Finance', status: 'planned', description: 'Post payroll journals to your ledger.' },
  { key: 'job_boards', name: 'Job boards', category: 'Recruitment', status: 'planned', description: 'Publish openings to job boards through their partner programmes.' },
];
