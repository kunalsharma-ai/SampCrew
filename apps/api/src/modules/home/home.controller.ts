import { Controller, Get, Query } from '@nestjs/common';
import { employeeHomeQuery, trendQuery, workforceHomeQuery } from '@crew/contracts';
import { z } from 'zod';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { HomeService } from './home.service';

/**
 * Home dashboards for the Employee, HR and Super Workspace levels (the Console's is /platform/home). Each route
 * checks the caller's level and scope itself; see packages/contracts/src/home.ts for what each one returns.
 */
@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get('employee')
  @Doc({ summary: 'Your own Home: attendance month and calendar, leave, learning, announcements, what needs you and recent activity', query: employeeHomeQuery })
  employee(@Query(new ZodPipe(employeeHomeQuery)) q: z.infer<typeof employeeHomeQuery>) {
    return this.home.employee(q.month);
  }

  @Get('workforce')
  @Doc({ summary: 'Today\'s workforce for HR and the Super Workspace: attendance, actions, leave, people, learning and communication, limited to the people you look after', query: workforceHomeQuery })
  workforce(@Query(new ZodPipe(workforceHomeQuery)) q: z.infer<typeof workforceHomeQuery>) {
    return this.home.workforceHome(q);
  }

  @Get('workforce/trend')
  @Doc({ summary: 'Daily attendance, absence, late, leave and missing punches over the last 7, 14 or 30 days for the people you look after', query: trendQuery })
  trend(@Query(new ZodPipe(trendQuery)) q: z.infer<typeof trendQuery>) {
    return this.home.trend(q);
  }

  @Get('organization')
  @Doc({ summary: 'Super Workspace only: every HR Workspace\'s attendance, pending actions, learning and communication, with alerts' })
  organization() {
    return this.home.organization();
  }
}
