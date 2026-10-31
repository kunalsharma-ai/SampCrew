import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../platform/authz/decorators';
import { DatabaseService } from '../../platform/database/database.service';
import { Doc } from '../../platform/openapi/openapi';

@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get('live')
  @Doc({ summary: 'Liveness probe' })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @Doc({ summary: 'Readiness probe (database reachable)' })
  async ready() {
    const started = Date.now();
    await this.db.pool.query('select 1');
    return { status: 'ok', database: { latencyMs: Date.now() - started } };
  }
}
