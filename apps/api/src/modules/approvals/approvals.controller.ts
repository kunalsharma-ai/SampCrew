import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { APPROVAL_VIEWS, approvalCategoryInput, approvalDecisionInput, approvalListQuery, approvalPolicyInput } from '@crew/contracts';
import { z } from 'zod';
import { Doc } from '../../platform/openapi/openapi';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { ApprovalsService, type StepDef } from './approvals.service';

const resourceType = z.string().regex(/^[a-z_]{1,40}$/);
const categoryKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const viewQuery = z.object({ view: z.enum(APPROVAL_VIEWS).default('waiting') });

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('inbox')
  @Doc({ summary: 'Requests waiting for my approval (only those I am allowed to decide)' })
  inbox() {
    return this.approvals.inbox();
  }

  @Get('overview')
  @Doc({ summary: 'Approval category cards (total, pending, approved, rejected, latest) for a view: waiting for me, decided by me, or mine', query: viewQuery })
  overview(@Query(new ZodPipe(viewQuery)) q: z.infer<typeof viewQuery>) {
    return this.approvals.overview(q.view);
  }

  @Get('requests')
  @Doc({ summary: 'Requests in a view, optionally one category or status, with their status message', query: approvalListQuery })
  list(@Query(new ZodPipe(approvalListQuery)) q: z.infer<typeof approvalListQuery>) {
    return this.approvals.list(q);
  }

  @Get('requests/:id')
  @Doc({ summary: 'One request: details, supporting documents, approval chain with remarks, final decision' })
  detail(@Param('id', UuidPipe) id: string) {
    return this.approvals.detail(id);
  }

  @Get('categories')
  @Doc({ summary: 'Approval categories: the workspace own ones and the built-in ones' })
  categories() {
    return this.approvals.categories();
  }

  @Post('categories')
  @Doc({ summary: 'Add an approval category (Approval settings)', body: approvalCategoryInput })
  addCategory(@Body(new ZodPipe(approvalCategoryInput)) body: z.infer<typeof approvalCategoryInput>) {
    return this.approvals.saveCategory(body);
  }

  @Put('categories/:key')
  @Doc({ summary: 'Change an approval category', body: approvalCategoryInput })
  updateCategory(@Param('key', new ZodPipe(categoryKey)) key: string, @Body(new ZodPipe(approvalCategoryInput)) body: z.infer<typeof approvalCategoryInput>) {
    return this.approvals.saveCategory(body, key);
  }

  @Delete('categories/:key')
  @HttpCode(204)
  @Doc({ summary: 'Remove an approval category; its requests move to the built-in categories' })
  async deleteCategory(@Param('key', new ZodPipe(categoryKey)) key: string) {
    await this.approvals.deleteCategory(key);
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
