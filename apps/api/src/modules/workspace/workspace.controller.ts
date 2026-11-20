import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import { rewardGrantInput, rewardMonthQuery, rewardRevokeInput, rewardRuleInput, type RewardRuleInput } from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { RequireFeature } from '../../platform/authz/decorators';
import { sendFile, toXlsx } from '../../platform/export/tabular';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { WorkspaceService } from './workspace.service';

const rewardsQuery = rewardMonthQuery.extend({ history: z.enum(['0', '1']).optional() });

/** The employee's own workspace: attendance rewards and the month calendar. */
@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get('rewards')
  @RequireFeature('attendance_basic')
  @Doc({ summary: 'My attendance rewards for a month (this month by default) and, unless history=0, the last six months', query: rewardsQuery })
  rewards(@Query(new ZodPipe(rewardsQuery)) q: z.infer<typeof rewardsQuery>) {
    return this.workspace.rewards(q.month, q.history !== '0');
  }

  @Get('reward-rules')
  @RequireFeature('attendance_basic')
  @Doc({ summary: 'The attendance reward rules HR has set' })
  rules() {
    return this.workspace.rules();
  }

  @Post('reward-rules')
  @RequireFeature('attendance_basic')
  @Doc({ summary: 'Add an attendance reward rule (attendance:configure)', body: rewardRuleInput })
  create(@Body(new ZodPipe(rewardRuleInput)) body: RewardRuleInput) {
    return this.workspace.createRule(body);
  }

  @Post('reward-rules/defaults')
  @RequireFeature('attendance_basic')
  @Doc({ summary: 'Add the standard perfect attendance and punctuality rules, with sick leave excused' })
  defaults() {
    return this.workspace.addDefaults();
  }

  @Put('reward-rules/:id')
  @RequireFeature('attendance_basic')
  @Doc({ summary: 'Change an attendance reward rule', body: rewardRuleInput })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(rewardRuleInput)) body: RewardRuleInput) {
    return this.workspace.updateRule(id, body);
  }

  @Delete('reward-rules/:id')
  @RequireFeature('attendance_basic')
  @Doc({ summary: 'Remove an attendance reward rule' })
  remove(@Param('id', UuidPipe) id: string) {
    return this.workspace.deleteRule(id);
  }

  @Get('reward-winners')
  @RequireFeature('attendance_basic')
  @Doc({ summary: 'Who earned each active reward rule in a finished month, last month by default (attendance:configure)', query: rewardMonthQuery })
  winners(@Query(new ZodPipe(rewardMonthQuery)) q: z.infer<typeof rewardMonthQuery>) {
    return this.workspace.winners(q.month);
  }

  @Get('reward-winners/export.xlsx')
  @RequireFeature('attendance_basic')
  @Doc({ summary: 'The reward winners for a finished month as an Excel workbook', query: rewardMonthQuery })
  async winnersExport(@Query(new ZodPipe(rewardMonthQuery)) q: z.infer<typeof rewardMonthQuery>, @Res() res: Response) {
    const w = await this.workspace.winnerRows(q.month);
    sendFile(res, { fileName: `attendance-rewards-${w.month}.xlsx`, content: toXlsx('Attendance rewards', w.rows) }, 'xlsx');
  }

  @Post('reward-winners/grant')
  @RequireFeature('attendance_basic')
  @Doc({ summary: 'Grant a finished month’s winners their payout: a bonus in the next payroll run or leave days credited now (attendance:configure)', body: rewardGrantInput })
  grant(@Body(new ZodPipe(rewardGrantInput)) body: z.infer<typeof rewardGrantInput>) {
    return this.workspace.grant(body);
  }

  @Post('reward-grants/:id/revoke')
  @RequireFeature('attendance_basic')
  @Doc({ summary: 'Take a granted reward back, with a reason (not once its bonus is paid)', body: rewardRevokeInput })
  revoke(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(rewardRevokeInput)) body: z.infer<typeof rewardRevokeInput>) {
    return this.workspace.revoke(id, body.reason);
  }

  @Get('calendar')
  @RequireFeature('core_hr')
  @Doc({ summary: 'My month: working days, weekly offs, holidays, my leave, task and appraisal deadlines', query: rewardMonthQuery })
  calendar(@Query(new ZodPipe(rewardMonthQuery)) q: z.infer<typeof rewardMonthQuery>) {
    return this.workspace.calendar(q.month);
  }
}
