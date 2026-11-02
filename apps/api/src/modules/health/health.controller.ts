import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
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
    try {
      await this.db.pool.query('select 1');
    } catch {
      // 503, not 500: load balancers and container health checks read it as "not ready, try again", and the
      // database error itself is not shown to whoever asked.
      throw new ServiceUnavailableException({ code: 'not_ready', message: 'The database cannot be reached' });
    }
    return { status: 'ok', database: { latencyMs: Date.now() - started } };
  }
}
