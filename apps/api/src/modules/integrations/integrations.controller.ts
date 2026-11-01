import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  API_KEY_SCOPES, apiKeyInput, type ApiKeyInput, CONNECTORS, PERMISSIONS, slackConnectionInput, type SlackConnectionInput, WEBHOOK_EVENTS,
  WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_S, WEBHOOK_TOLERANCE_S, webhookEndpointInput, type WebhookEndpointInput,
} from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { DatabaseService, one } from '../../platform/database/database.service';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { ApiKeysService } from './api-keys.service';
import { ConnectionsService } from './connections.service';
import { WebhooksService } from './webhooks.service';

const deliveryQuery = z.object({ status: z.enum(['pending', 'sending', 'succeeded', 'failed']).optional() });

@Controller('integrations')
@RequireFeature('integrations_advanced')
@RequirePermission('integrations:manage')
export class IntegrationsController {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly webhooks: WebhooksService,
    private readonly connections: ConnectionsService,
    private readonly db: DatabaseService,
  ) {}

  @Get('catalogue')
  @Doc({ summary: 'Connectors (available and planned), webhook events, API key scopes and how many of each this workspace has' })
  async catalogue() {
    const counts = await this.db.tenant((tx) =>
      one<{ keys: number; endpoints: number; slack: number }>(
        tx,
        `select (select count(*) from api_keys where revoked_at is null and (expires_at is null or expires_at > now()))::int as keys,
                (select count(*) from webhook_endpoints)::int as endpoints,
                (select count(*) from integration_connections where provider = 'slack' and status <> 'disconnected')::int as slack`,
      ),
    );
    const perm = new Map(PERMISSIONS.map((p) => [p.key as string, p.description]));
    return {
      connectors: CONNECTORS.map((c) => ({ ...c, count: c.key === 'api_keys' ? counts!.keys : c.key === 'webhooks' ? counts!.endpoints : c.key === 'slack' ? counts!.slack : 0 })),
      events: WEBHOOK_EVENTS,
      scopes: API_KEY_SCOPES.map((s) => ({ key: s, description: perm.get(s) ?? s })),
      retry: { maxAttempts: WEBHOOK_MAX_ATTEMPTS, delaysSeconds: WEBHOOK_RETRY_DELAYS_S, toleranceSeconds: WEBHOOK_TOLERANCE_S },
    };
  }

  // API keys
  @Get('api-keys')
  @Doc({ summary: 'API keys with their scopes, owner and last use (the secret part is never returned)' })
  listKeys() {
    return this.keys.list();
  }

  @Post('api-keys')
  @Doc({ summary: 'Create an API key. The full key is in this response only; store it safely.', body: apiKeyInput })
  createKey(@Body(new ZodPipe(apiKeyInput)) body: ApiKeyInput) {
    return this.keys.create(body);
  }

  @Post('api-keys/:id/revoke')
  @HttpCode(200)
  @Doc({ summary: 'Revoke an API key. It stops working at once and cannot be restored.' })
  revokeKey(@Param('id', UuidPipe) id: string) {
    return this.keys.revoke(id);
  }

  // Webhooks
  @Get('webhooks')
  @Doc({ summary: 'Webhook endpoints with recent delivery counts' })
  listWebhooks() {
    return this.webhooks.list();
  }

  @Post('webhooks')
  @Doc({ summary: 'Add a webhook endpoint. The signing secret is in this response only.', body: webhookEndpointInput })
  createWebhook(@Body(new ZodPipe(webhookEndpointInput)) body: WebhookEndpointInput) {
    return this.webhooks.create(body);
  }

  @Get('webhooks/:id')
  @Doc({ summary: 'A webhook endpoint' })
  getWebhook(@Param('id', UuidPipe) id: string) {
    return this.webhooks.get(id);
  }

  @Put('webhooks/:id')
  @Doc({ summary: 'Change a webhook endpoint\'s name, address or events', body: webhookEndpointInput })
  updateWebhook(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(webhookEndpointInput)) body: WebhookEndpointInput) {
    return this.webhooks.update(id, body);
  }

  @Delete('webhooks/:id')
  @Doc({ summary: 'Delete a webhook endpoint and its delivery log' })
  deleteWebhook(@Param('id', UuidPipe) id: string) {
    return this.webhooks.remove(id);
  }

  @Post('webhooks/:id/enable')
  @HttpCode(200)
  @Doc({ summary: 'Switch an endpoint on (also after it was switched off for failing)' })
  enableWebhook(@Param('id', UuidPipe) id: string) {
    return this.webhooks.setStatus(id, 'active');
  }

  @Post('webhooks/:id/pause')
  @HttpCode(200)
  @Doc({ summary: 'Pause an endpoint. Nothing new is queued for it while paused.' })
  pauseWebhook(@Param('id', UuidPipe) id: string) {
    return this.webhooks.setStatus(id, 'paused');
  }

  @Post('webhooks/:id/rotate-secret')
  @HttpCode(200)
  @Doc({ summary: 'Replace the signing secret. The new secret is in this response only and is used from the next attempt.' })
  rotateSecret(@Param('id', UuidPipe) id: string) {
    return this.webhooks.rotateSecret(id);
  }

  @Post('webhooks/:id/test')
  @HttpCode(200)
  @Doc({ summary: 'Queue a webhook.test event to this endpoint' })
  testWebhook(@Param('id', UuidPipe) id: string) {
    return this.webhooks.test(id);
  }

  @Get('webhooks/:id/deliveries')
  @Doc({ summary: 'Recent deliveries to an endpoint, newest first', query: deliveryQuery })
  deliveries(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(deliveryQuery)) q: z.infer<typeof deliveryQuery>) {
    return this.webhooks.deliveries(id, q);
  }

  @Get('deliveries/:id')
  @Doc({ summary: 'A delivery with its payload and every attempt' })
  delivery(@Param('id', UuidPipe) id: string) {
    return this.webhooks.delivery(id);
  }

  @Post('deliveries/:id/redeliver')
  @HttpCode(200)
  @Doc({ summary: 'Send a finished delivery again (for example after fixing the receiver)' })
  redeliver(@Param('id', UuidPipe) id: string) {
    return this.webhooks.redeliver(id);
  }

  // Connections
  @Get('connections')
  @Doc({ summary: 'Connections to outside services (Slack)' })
  listConnections() {
    return this.connections.list();
  }

  @Post('connections/slack')
  @Doc({ summary: 'Connect a Slack channel with an incoming webhook URL. A confirmation message is posted first; nothing is saved if Slack refuses it.', body: slackConnectionInput })
  connectSlack(@Body(new ZodPipe(slackConnectionInput)) body: SlackConnectionInput) {
    return this.connections.connectSlack(body);
  }

  @Post('connections/:id/test')
  @HttpCode(200)
  @Doc({ summary: 'Post a test message through a connection' })
  testConnection(@Param('id', UuidPipe) id: string) {
    return this.connections.testSlack(id);
  }

  @Get('connections/:id/logs')
  @Doc({ summary: 'Recent calls made through a connection' })
  connectionLogs(@Param('id', UuidPipe) id: string) {
    return this.connections.logs(id);
  }

  @Post('connections/:id/disconnect')
  @HttpCode(200)
  @Doc({ summary: 'Disconnect and wipe the stored credentials' })
  disconnect(@Param('id', UuidPipe) id: string) {
    return this.connections.disconnect(id);
  }
}
