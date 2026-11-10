import { type INestApplication, RequestMethod } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import helmet from 'helmet';
import { CONTROLLERS } from './app.module';
import { loadConfig } from './platform/config/config';
import { buildOpenApi } from './platform/openapi/openapi';

/** Shared HTTP setup for the server and integration tests. */
export function configureApp(app: INestApplication) {
  const config = loadConfig();
  // Attendance devices speaking the ZKTeco push protocol call fixed paths at the server root.
  app.setGlobalPrefix('api/v1', {
    exclude: ['cdata', 'getrequest', 'devicecmd'].map((p) => ({ path: `iclock/${p}`, method: RequestMethod.ALL })),
  });
  // Their bodies are plain text whatever content type the firmware sends, so read them raw before other parsers.
  app.use('/iclock', readTextBody);
  // SCIM clients (Okta, Entra ID) send application/scim+json, which the default JSON parser ignores.
  app.use('/api/v1/scim', readScimJson);
  // Payment webhooks are signed over the exact bytes sent, so keep them before JSON parsing.
  app.use('/api/v1/billing/webhooks', readRawJson);
  app.use(helmet());
  app.enableCors({ origin: config.corsOrigins, credentials: false, allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id', 'x-crew-client'] });
  const httpAdapter = app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void; get: (path: string, h: (req: unknown, res: { json: (b: unknown) => void }) => void) => void };
  httpAdapter.set('trust proxy', 1);
  httpAdapter.set('x-powered-by', false);
  const spec = buildOpenApi(CONTROLLERS);
  httpAdapter.get('/api/v1/openapi.json', (_req, res) => res.json(spec));
  return app;
}

const MAX_DEVICE_BODY = 2 * 1024 * 1024;
function readTextBody(req: IncomingMessage & { body?: unknown; _body?: boolean }, res: ServerResponse, next: (err?: unknown) => void) {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_DEVICE_BODY) {
      res.statusCode = 413;
      res.end('Payload too large');
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    req.body = Buffer.concat(chunks).toString('utf8');
    req._body = true; // tells body-parser the body is already read
    next();
  });
  req.on('error', next);
}

const MAX_SCIM_BODY = 1024 * 1024;
function readScimJson(req: IncomingMessage & { body?: unknown; _body?: boolean }, res: ServerResponse, next: (err?: unknown) => void) {
  if (!/application\/scim\+json/i.test(req.headers['content-type'] ?? '')) return next();
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_SCIM_BODY) {
      res.statusCode = 413;
      res.end('Payload too large');
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    try {
      const text = Buffer.concat(chunks).toString('utf8');
      req.body = text ? JSON.parse(text) : {};
    } catch {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/scim+json');
      res.end(JSON.stringify({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '400', scimType: 'invalidSyntax', detail: 'The body is not valid JSON' }));
      return;
    }
    req._body = true;
    next();
  });
  req.on('error', next);
}

const MAX_WEBHOOK_BODY = 512 * 1024;
function readRawJson(req: IncomingMessage & { body?: unknown; rawBody?: Buffer; _body?: boolean }, res: ServerResponse, next: (err?: unknown) => void) {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_WEBHOOK_BODY) {
      res.statusCode = 413;
      res.end('Payload too large');
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    try {
      req.body = req.rawBody.length ? JSON.parse(req.rawBody.toString('utf8')) : {};
    } catch {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'invalid_json', message: 'The body is not valid JSON' } }));
      return;
    }
    req._body = true;
    next();
  });
  req.on('error', next);
}
