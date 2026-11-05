import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { onboardingTaskUpdate, onboardingTemplateInput } from '@crew/contracts';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { OnboardingService } from './onboarding.service';

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('templates')
  @RequirePermission('employees:create')
  @Doc({ summary: 'Onboarding checklist templates' })
  templates() {
    return this.onboarding.listTemplates();
  }

  @Post('templates')
  @RequirePermission('employees:create')
  @Doc({ summary: 'Create an onboarding template', body: onboardingTemplateInput })
  create(@Body(new ZodPipe(onboardingTemplateInput)) body: z.infer<typeof onboardingTemplateInput>) {
    return this.onboarding.createTemplate(body);
  }

  @Put('templates/:id')
  @RequirePermission('employees:create')
  @Doc({ summary: 'Replace an onboarding template (existing checklists are not changed)', body: onboardingTemplateInput })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(onboardingTemplateInput)) body: z.infer<typeof onboardingTemplateInput>) {
    return this.onboarding.updateTemplate(id, body);
  }

  @Delete('templates/:id')
  @RequirePermission('employees:create')
  @HttpCode(204)
  @Doc({ summary: 'Archive an onboarding template' })
  async archive(@Param('id', UuidPipe) id: string) {
    await this.onboarding.archiveTemplate(id);
  }

  @Get('employees/:employeeId/tasks')
  @Doc({ summary: "An employee's onboarding checklist" })
  forEmployee(@Param('employeeId', UuidPipe) id: string) {
    return this.onboarding.forEmployee(id);
  }

  @Get('my-tasks')
  @Doc({ summary: 'Open onboarding tasks assigned to you' })
  mine() {
    return this.onboarding.mine();
  }

  @Patch('tasks/:id')
  @Doc({ summary: 'Complete, skip or reopen a task (assignee, or someone who manages the employee)', body: onboardingTaskUpdate })
  setStatus(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(onboardingTaskUpdate)) body: z.infer<typeof onboardingTaskUpdate>) {
    return this.onboarding.setStatus(id, body.status);
  }
}
