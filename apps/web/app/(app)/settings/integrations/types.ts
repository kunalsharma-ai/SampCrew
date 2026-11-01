export interface Connector { key: string; name: string; category: string; status: 'available' | 'planned'; description: string; count: number }
export interface WebhookEventDef { type: string; group: string; label: string; dataKeys: readonly string[] }
export interface IntegrationsCatalogue {
  connectors: Connector[];
  events: WebhookEventDef[];
  scopes: { key: string; description: string }[];
  retry: { maxAttempts: number; delaysSeconds: number[]; toleranceSeconds: number };
}
export interface ApiKey {
  id: string; name: string; prefix: string; scopes: string[]; expiresAt: string | null; lastUsedAt: string | null; lastUsedIp: string | null;
  useCount: number; revokedAt: string | null; createdAt: string; createdBy: string; status: 'active' | 'revoked' | 'expired' | 'owner_inactive';
}
export interface WebhookEndpoint {
  id: string; name: string; url: string; events: string[]; status: 'active' | 'paused' | 'disabled'; statusReason: string | null; consecutiveFailures: number;
  createdAt: string; createdBy: string; deliveries7d?: number; failed7d?: number; lastDeliveredAt?: string | null;
}
export interface WebhookDelivery {
  id: string; eventId: string; eventType: string; status: 'pending' | 'sending' | 'succeeded' | 'failed'; attempts: number; nextAttemptAt: string | null;
  lastStatusCode: number | null; lastError: string | null; lastDurationMs: number | null; deliveredAt: string | null; createdAt: string;
}
export interface WebhookAttempt { attempt: number; statusCode: number | null; ok: boolean; error: string | null; response: string | null; durationMs: number; createdAt: string }
export interface WebhookDeliveryDetail extends Omit<WebhookDelivery, 'lastStatusCode' | 'lastDurationMs'> {
  endpointId: string; endpointName: string; url: string; payload: unknown; attemptLog: WebhookAttempt[]; maxAttempts: number;
}
export interface Connection {
  id: string; provider: 'slack'; name: string; display: { webhook?: string }; status: 'active' | 'error'; statusReason: string | null;
  verifiedAt: string | null; lastUsedAt: string | null; createdAt: string; createdBy: string;
}
export interface ConnectionLog { action: string; ok: boolean; detail: string | null; durationMs: number | null; createdAt: string }
