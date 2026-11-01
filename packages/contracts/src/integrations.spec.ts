import { describe, expect, it } from 'vitest';
import { validateDefinition } from './automation';
import {
  API_KEY_SCOPES,
  apiKeyInput,
  CONNECTORS,
  parseApiKey,
  slackConnectionInput,
  WEBHOOK_EVENTS,
  WEBHOOK_MAX_ATTEMPTS,
  webhookBody,
  webhookEndpointInput,
} from './integrations';
import { PERMISSIONS } from './permissions';

describe('webhookBody', () => {
  it('keeps only the allow-listed keys of an event', () => {
    const b = webhookBody({ id: 'e1', type: 'employee.changed', occurredAt: '2026-11-01T00:00:00Z', tenantId: 't1', payload: { employeeId: 'x', fields: ['phone'], before: { phone: '9876543210' }, after: { phone: '9123456780' } } });
    expect(b).toEqual({ id: 'e1', type: 'employee.changed', createdAt: '2026-11-01T00:00:00Z', workspaceId: 't1', data: { employeeId: 'x', fields: ['phone'] } });
  });
  it('drops keys an event did not carry', () => {
    expect(webhookBody({ id: 'e', type: 'leave.requested', occurredAt: 'now', tenantId: 't', payload: { leaveRequestId: 'l' } }).data).toEqual({ leaveRequestId: 'l' });
  });
  it('lists only events with ids and names, never pay or personal details', () => {
    // workflow.webhook carries what the workflow's author chose to send, so it is checked when the workflow is saved.
    for (const e of WEBHOOK_EVENTS.filter((x) => x.type !== 'workflow.webhook')) for (const k of e.dataKeys) expect(k).not.toMatch(/salary|amount|email|phone|name|bank|pan/i);
  });
});

describe('API keys', () => {
  it('parses the key format and rejects anything else', () => {
    const secret = 'A'.repeat(43);
    expect(parseApiKey(`crew_abcde12345_${secret}`)).toEqual({ prefix: 'abcde12345', secret });
    expect(parseApiKey(`crew_ABCDE12345_${secret}`)).toBeNull();
    expect(parseApiKey(`crew_abcde1234_${secret}`)).toBeNull();
    expect(parseApiKey(`crew_abcde12345_short`)).toBeNull();
    expect(parseApiKey('Bearer eyJhbGciOi')).toBeNull();
  });
  it('allows only read permissions that do not need two-step verification', () => {
    for (const s of API_KEY_SCOPES) {
      const p = PERMISSIONS.find((x) => x.key === s);
      expect(p, s).toBeDefined();
      expect(s).toMatch(/:read$/);
      expect(p!.requiresMfa ?? false, s).toBe(false);
    }
  });
  it('validates input', () => {
    expect(apiKeyInput.parse({ name: 'Payroll bridge', scopes: ['employees:read'] }).expiresInDays).toBe(90);
    expect(apiKeyInput.safeParse({ name: 'Bridge', scopes: ['employees:write'] }).success).toBe(false);
    expect(apiKeyInput.safeParse({ name: 'Bridge', scopes: ['org:read', 'org:read'] }).success).toBe(false);
    expect(apiKeyInput.safeParse({ name: 'Bridge', scopes: ['org:read'], expiresInDays: 7 }).success).toBe(false);
    expect(apiKeyInput.safeParse({ name: 'Bridge', scopes: ['org:read'], expiresInDays: null }).success).toBe(true);
  });
});

describe('webhook endpoints and Slack', () => {
  it('accepts only known events and web addresses', () => {
    expect(webhookEndpointInput.safeParse({ name: 'Bridge', url: 'https://example.com/hook', events: ['employee.created'] }).success).toBe(true);
    expect(webhookEndpointInput.safeParse({ name: 'Bridge', url: 'ftp://example.com/hook', events: ['employee.created'] }).success).toBe(false);
    expect(webhookEndpointInput.safeParse({ name: 'Bridge', url: 'https://example.com/hook', events: ['payroll.salary'] }).success).toBe(false);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(6);
  });
  it('accepts only Slack incoming webhook addresses', () => {
    expect(slackConnectionInput.safeParse({ name: 'People team', webhookUrl: 'https://hooks.slack.com/services/T0001/B0002/abcDEF123' }).success).toBe(true);
    expect(slackConnectionInput.safeParse({ name: 'People team', webhookUrl: 'https://evil.example.com/services/T0001/B0002/abc' }).success).toBe(false);
    expect(slackConnectionInput.safeParse({ name: 'People team', webhookUrl: 'https://hooks.slack.com.evil.io/services/T0001/B0002/abc' }).success).toBe(false);
  });
  it('marks only built connectors as available', () => {
    expect(CONNECTORS.filter((c) => c.status === 'available').map((c) => c.key).sort()).toEqual(['api_keys', 'slack', 'webhooks']);
  });
});

describe('workflow steps for integrations', () => {
  const base = { trigger: { event: 'employee.created' } };
  const id = '00000000-0000-4000-8000-000000000001';
  it('accepts Slack and webhook steps with valid templates', () => {
    const r = validateDefinition({ ...base, steps: [{ id: 's1', type: 'slack', connectionId: id, text: 'Welcome {{employee.name}}' }, { id: 's2', type: 'webhook', endpointId: id, message: 'New joiner' }] });
    expect(r).toMatchObject({ ok: true });
  });
  it('checks placeholders in their text', () => {
    const r = validateDefinition({ ...base, steps: [{ id: 's1', type: 'slack', connectionId: id, text: 'Pay {{employee.salary}}' }] });
    expect(r.ok).toBe(false);
    expect(validateDefinition({ ...base, steps: [{ id: 's1', type: 'webhook', endpointId: 'not-a-uuid', message: 'x' }] }).ok).toBe(false);
  });
});
