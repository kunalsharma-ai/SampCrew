import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { changeSubscriptionRequest, planRequestCreate, type ChangeSubscriptionRequest } from '@crew/contracts';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  @Doc({ summary: 'Available plans with prices, features and limits' })
  plans() {
    return this.billing.plans();
  }

  @Get('subscription')
  @RequirePermission('billing:read')
  @Doc({ summary: 'Current subscription and usage against plan limits' })
  subscription() {
    return this.billing.subscription();
  }

  @Put('subscription')
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Change plan, billing cycle or seats. Downgrades are blocked when current usage does not fit.', body: changeSubscriptionRequest })
  change(@Body(new ZodPipe(changeSubscriptionRequest)) body: ChangeSubscriptionRequest) {
    return this.billing.change(body);
  }

  @Get('plan-requests')
  @RequirePermission('billing:read')
  @Doc({ summary: 'Requests this workspace sent SAMPLEDGE for a quote-only plan, with their answers' })
  planRequests() {
    return this.billing.planRequests();
  }

  @Post('plan-requests')
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Ask SAMPLEDGE for a quote-only plan (such as Enterprise). SAMPLEDGE approves it in the Console and the plan is applied.', body: planRequestCreate })
  requestPlan(@Body(new ZodPipe(planRequestCreate)) body: z.infer<typeof planRequestCreate>) {
    return this.billing.requestPlan(body);
  }

  @Post('plan-requests/:id/withdraw')
  @HttpCode(200)
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Withdraw a plan request SAMPLEDGE has not answered yet' })
  withdrawPlanRequest(@Param('id', UuidPipe) id: string) {
    return this.billing.withdrawPlanRequest(id);
  }

  @Get('invoices')
  @RequirePermission('billing:read')
  @Doc({ summary: 'Invoices for this workspace' })
  invoices() {
    return this.billing.invoices();
  }
}
