import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { workflowDraftInput, workflowInput, type WorkflowInput, workflowTestInput, type WorkflowTestInput } from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { AutomationService } from './automation.service';

const runQuery = z.object({
  workflowId: z.uuid().optional(),
  status: z.enum(['running', 'waiting', 'succeeded', 'stopped', 'failed', 'cancelled']).optional(),
  mode: z.enum(['live', 'test']).optional(),
});

@Controller('automation')
@RequireFeature('automation')
@RequirePermission('automation:manage')
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Get('catalogue')
  @Doc({ summary: 'Triggers with their fields, step types, condition operators, roles and courses for the workflow editor' })
  catalogue() {
    return this.automation.catalogue();
  }

  @Get('workflows')
  @Doc({ summary: 'Workflows with their status, versions and run counts' })
  list() {
    return this.automation.list();
  }

  @Post('workflows')
  @Doc({ summary: 'Create a workflow (saved as version 1, inactive until tested and activated)', body: workflowInput })
  create(@Body(new ZodPipe(workflowInput)) body: WorkflowInput) {
    return this.automation.create(body);
  }

  @Get('workflows/:id')
  @Doc({ summary: 'A workflow with its latest version, version history and whether it can be activated' })
  get(@Param('id', UuidPipe) id: string) {
    return this.automation.get(id);
  }

  @Put('workflows/:id')
  @Doc({ summary: 'Save a new version. An active workflow keeps running its active version until the new one is tested and activated.', body: workflowInput })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(workflowInput)) body: WorkflowInput) {
    return this.automation.update(id, body);
  }

  @Post('workflows/:id/test')
  @HttpCode(200)
  @Doc({ summary: 'Test-run the latest version with sample values. Notifications, approvals and assignments are described, not done; delays are skipped.', body: workflowTestInput })
  test(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(workflowTestInput)) body: WorkflowTestInput) {
    return this.automation.test(id, body);
  }

  @Post('workflows/:id/activate')
  @HttpCode(200)
  @Doc({ summary: 'Activate the latest version (it must have passed a test run). The workflow then acts with your permissions.' })
  activate(@Param('id', UuidPipe) id: string) {
    return this.automation.activate(id);
  }

  @Post('workflows/:id/pause')
  @HttpCode(200)
  @Doc({ summary: 'Pause a workflow. Runs under way stop at their next step.' })
  pause(@Param('id', UuidPipe) id: string) {
    return this.automation.setStatus(id, 'paused');
  }

  @Post('workflows/:id/archive')
  @HttpCode(200)
  @Doc({ summary: 'Archive a workflow. Its runs and versions are kept.' })
  archive(@Param('id', UuidPipe) id: string) {
    return this.automation.setStatus(id, 'archived');
  }

  @Get('runs')
  @Doc({ summary: 'Workflow runs, newest first; filter by workflow, status (status=failed is the failed-runs view) or mode', query: runQuery })
  runs(@Query(new ZodPipe(runQuery)) q: z.infer<typeof runQuery>) {
    return this.automation.runs(q);
  }

  @Get('runs/:id')
  @Doc({ summary: 'A run with its plan and the step-by-step trace' })
  run(@Param('id', UuidPipe) id: string) {
    return this.automation.run(id);
  }

  @Post('runs/:id/retry')
  @HttpCode(200)
  @Doc({ summary: 'Retry a failed run from the step that failed' })
  retry(@Param('id', UuidPipe) id: string) {
    return this.automation.retry(id);
  }

  @Post('runs/:id/cancel')
  @HttpCode(200)
  @Doc({ summary: 'Cancel a run that is under way (and its pending approval)' })
  cancel(@Param('id', UuidPipe) id: string) {
    return this.automation.cancel(id);
  }

  @Post('drafts')
  @HttpCode(200)
  @RequireFeature('ai_copilot')
  @Doc({ summary: 'Draft a workflow from a plain-English description with AI. Nothing is saved; the result is checked and must still be tested.', body: workflowDraftInput })
  draft(@Body(new ZodPipe(workflowDraftInput)) body: z.infer<typeof workflowDraftInput>) {
    return this.automation.draft(body.description);
  }
}
