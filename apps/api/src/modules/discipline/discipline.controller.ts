import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { latePolicyInput, type LatePolicyInput, leavePenaltyInput, manualReminderInput, monthQuery, sameDayLeavePolicyInput, type SameDayLeavePolicyInput, withdrawInput } from '@crew/contracts';
import type { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { DisciplineService } from './discipline.service';

/** Late-coming reminders and the attendance penalties (late coming, same-day leave) payroll deducts. */
@Controller('attendance')
@RequireFeature('attendance_basic')
export class LateComingController {
  constructor(private readonly discipline: DisciplineService) {}

  @Get('late/policy')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Late-coming reminder and same-day leave penalty rules', description: 'Everyone can read them, so employees know when a deduction applies.' })
  policy() {
    return this.discipline.policy();
  }

  @Put('late/policy')
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Set the late-coming rules: automatic reminders, email, and deduction tiers by reminders in a month', body: latePolicyInput })
  savePolicy(@Body(new ZodPipe(latePolicyInput)) body: LatePolicyInput) {
    return this.discipline.saveLatePolicy(body);
  }

  @Get('late/month')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Late arrivals, reminders and penalties in a month for everyone I can see (or one employee)', query: monthQuery })
  month(@Query(new ZodPipe(monthQuery)) q: z.infer<typeof monthQuery>) {
    return this.discipline.month(q);
  }

  @Post('late/reminders')
  @RequirePermission('attendance:approve')
  @Doc({ summary: 'Send a late-arrival reminder by hand (in-app, and email when the workspace wants it)', body: manualReminderInput })
  remind(@Body(new ZodPipe(manualReminderInput)) body: z.infer<typeof manualReminderInput>) {
    return this.discipline.remind(body);
  }

  @Post('late/reminders/:id/withdraw')
  @RequirePermission('attendance:approve')
  @Doc({ summary: 'Withdraw a late reminder; the month’s deduction is worked out again', body: withdrawInput })
  withdraw(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(withdrawInput)) body: z.infer<typeof withdrawInput>) {
    return this.discipline.withdrawReminder(id, body.reason);
  }

  @Post('penalties/:id/waive')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Waive a late-coming or same-day leave penalty (needs approval rights over the person)', body: withdrawInput })
  waive(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(withdrawInput)) body: z.infer<typeof withdrawInput>) {
    return this.discipline.waive(id, body.reason);
  }
}

/** Same-day leave: the workspace rule and a manager's penalty on one request. */
@Controller('leave')
@RequireFeature('leave')
export class LeavePenaltiesController {
  constructor(private readonly discipline: DisciplineService) {}

  @Put('same-day-policy')
  @RequirePermission('leave:configure')
  @Doc({ summary: 'Set the same-day leave penalty: automatic or by the manager, and the days of pay deducted', body: sameDayLeavePolicyInput })
  savePolicy(@Body(new ZodPipe(sameDayLeavePolicyInput)) body: SameDayLeavePolicyInput) {
    return this.discipline.saveSameDayPolicy(body);
  }

  @Post('requests/:id/penalty')
  @RequirePermission('leave:approve')
  @Doc({ summary: 'Apply or change a penalty of some days of pay (0.5 steps) on a leave request', body: leavePenaltyInput })
  penalty(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(leavePenaltyInput)) body: z.infer<typeof leavePenaltyInput>) {
    return this.discipline.setLeavePenalty(id, body);
  }
}
