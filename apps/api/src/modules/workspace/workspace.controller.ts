import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { rewardMonthQuery, rewardRuleInput, type RewardRuleInput } from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature } from '../../platform/authz/decorators';
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

  @Get('calendar')
  @RequireFeature('core_hr')
  @Doc({ summary: 'My month: working days, weekly offs, holidays, my leave, task and appraisal deadlines', query: rewardMonthQuery })
  calendar(@Query(new ZodPipe(rewardMonthQuery)) q: z.infer<typeof rewardMonthQuery>) {
    return this.workspace.calendar(q.month);
  }
}
