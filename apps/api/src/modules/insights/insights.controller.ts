import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { attritionReviewInput, type AttritionReviewInput } from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { InsightsService } from './insights.service';

const bandQuery = z.object({ band: z.enum(['low', 'medium', 'high']).optional() });

@Controller('insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('attrition')
  @RequireFeature('workforce_analytics')
  @RequirePermission('insights:attrition')
  @Doc({ summary: 'Latest attrition risk score per person in scope, with the factors behind it. Advisory; viewing is audited.', query: bandQuery })
  attrition(@Query(new ZodPipe(bandQuery)) q: z.infer<typeof bandQuery>) {
    return this.insights.attrition(q);
  }

  @Post('attrition/recalculate')
  @HttpCode(200)
  @RequireFeature('workforce_analytics')
  @RequirePermission('insights:attrition')
  @Doc({ summary: "Recalculate today's attrition scores (they are also recalculated daily)" })
  recalculate() {
    return this.insights.recalculate();
  }

  @Get('attrition/:employeeId')
  @RequireFeature('workforce_analytics')
  @RequirePermission('insights:attrition')
  @Doc({ summary: "One person's score history, inputs and HR reviews" })
  attritionFor(@Param('employeeId', UuidPipe) id: string) {
    return this.insights.attritionFor(id);
  }

  @Post('attrition/:employeeId/reviews')
  @RequireFeature('workforce_analytics')
  @RequirePermission('insights:attrition')
  @Doc({ summary: 'Record what HR decided about the latest score (action planned, no action, not accurate)', body: attritionReviewInput })
  review(@Param('employeeId', UuidPipe) id: string, @Body(new ZodPipe(attritionReviewInput)) body: AttritionReviewInput) {
    return this.insights.review(id, body);
  }

  @Get('payroll-runs/:id')
  @RequireFeature('payroll')
  @RequirePermission('payroll:read')
  @Doc({ summary: "Checks before approving a payroll run: each person's pay against their own recent finalised months, and rule checks. Advisory." })
  payrollChecks(@Param('id', UuidPipe) id: string) {
    return this.insights.payrollChecks(id);
  }
}
