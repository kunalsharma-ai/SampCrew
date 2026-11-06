import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadConfig } from './platform/config/config';

async function main() {
  const config = loadConfig();
  const logger = new ConsoleLogger({ json: config.isProductionLike, prefix: 'SampCrew' });
  const app = await NestFactory.create(AppModule, { logger, bodyParser: true });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(config.API_PORT);
  logger.log(`SampCrew API listening on :${config.API_PORT} (${config.CREW_ENV}). OpenAPI at /api/v1/openapi.json`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
