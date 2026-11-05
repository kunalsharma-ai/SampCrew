import 'reflect-metadata';
import { CONTROLLERS } from './app.module';
import { buildOpenApi } from './platform/openapi/openapi';

process.stdout.write(JSON.stringify(buildOpenApi(CONTROLLERS), null, 2));
