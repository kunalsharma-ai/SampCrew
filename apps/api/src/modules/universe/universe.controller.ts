import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../../platform/authz/decorators';
import { Doc } from '../../platform/openapi/openapi';
import { UniverseService } from './universe.service';

@Controller('insights')
export class UniverseController {
  constructor(private readonly universe: UniverseService) {}

  @Get('universe')
  @RequirePermission('employees:read')
  @Doc({ summary: 'Workforce Universe: the people you can see with their placement history, departments and locations, to replay the organization over time' })
  load() {
    return this.universe.load();
  }
}
