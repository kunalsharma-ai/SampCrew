import { Controller, Get } from '@nestjs/common';
import { Doc } from '../../platform/openapi/openapi';
import { WorkspaceLimitsService } from './workspace-limits.service';

/**
 * The company's plan-based workspace limits: HR Workspaces and Employee Workspaces, Used / Maximum Allowed, and the
 * plans and add-ons that give more. Readable by those who create workspaces or logins, or look after billing.
 */
@Controller('workspace-limits')
export class WorkspaceLimitsController {
  constructor(private readonly limits: WorkspaceLimitsService) {}

  @Get()
  @Doc({ summary: 'HR Workspaces and Employee Workspaces in use and allowed by the plan, with upgrade options' })
  mine() {
    return this.limits.mine();
  }
}
