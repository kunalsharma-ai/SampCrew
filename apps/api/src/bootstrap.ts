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
