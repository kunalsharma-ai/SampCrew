import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { approvalDecisionInput, approvalPolicyInput } from '@crew/contracts';
import { z } from 'zod';
import { Doc } from '../../platform/openapi/openapi';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { ApprovalsService, type StepDef } from './approvals.service';

const resourceType = z.string().regex(/^[a-z_]{1,40}$/);

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('inbox')
  @Doc({ summary: 'Requests waiting for my approval (only those I am allowed to decide)' })
  inbox() {
    return this.approvals.inbox();
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Doc({ summary: 'Approve the current step of a request', body: approvalDecisionInput })
  approve(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(approvalDecisionInput)) body: z.infer<typeof approvalDecisionInput>) {
    return this.approvals.decide(id, 'approve', body.comment);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Doc({ summary: 'Reject a request', body: approvalDecisionInput })
  reject(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(approvalDecisionInput)) body: z.infer<typeof approvalDecisionInput>) {
    return this.approvals.decide(id, 'reject', body.comment);
  }

  @Get('policies/:type')
  @Doc({ summary: 'Approval chain for a request type' })
  policy(@Param('type', new ZodPipe(resourceType)) type: string) {
    return this.approvals.policy(type);
  }

  @Put('policies/:type')
  @Doc({ summary: 'Change the approval chain for a request type', body: approvalPolicyInput })
  setPolicy(@Param('type', new ZodPipe(resourceType)) type: string, @Body(new ZodPipe(approvalPolicyInput)) body: z.infer<typeof approvalPolicyInput>) {
    return this.approvals.setPolicy(type, body.steps as StepDef[]);
  }
}
