import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import { CONTROLLERS } from './app.module';
import { loadConfig } from './platform/config/config';
import { buildOpenApi } from './platform/openapi/openapi';

/** Shared HTTP setup for the server and integration tests. */
export function configureApp(app: INestApplication) {
  const config = loadConfig();
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.enableCors({ origin: config.corsOrigins, credentials: false, allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id', 'x-crew-client'] });
  const httpAdapter = app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void; get: (path: string, h: (req: unknown, res: { json: (b: unknown) => void }) => void) => void };
  httpAdapter.set('trust proxy', 1);
  httpAdapter.set('x-powered-by', false);
  const spec = buildOpenApi(CONTROLLERS);
  httpAdapter.get('/api/v1/openapi.json', (_req, res) => res.json(spec));
  return app;
}
