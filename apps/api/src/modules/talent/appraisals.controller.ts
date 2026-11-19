import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { appraisalAnswersInput, appraisalCycleInput, type AppraisalCycleInput, appraisalFormInput, type AppraisalFormInput, appraisalHrInput, appraisalReopenInput } from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { AppraisalsService } from './appraisals.service';

const templateKey = z.object({ key: z.enum(['frequent_research']) });

/** Appraisal forms, cycles and the three-stage appraisal workflow. Access is decided per appraisal (employee, manager, HR). */
@Controller('appraisals')
@RequireFeature('performance')
export class AppraisalsController {
  constructor(private readonly appraisals: AppraisalsService) {}

  @Get('forms')
  @Doc({ summary: 'Appraisal forms and the built-in templates (HR)' })
  forms() {
    return this.appraisals.listForms();
  }

  @Post('forms')
  @Doc({ summary: 'Create an appraisal form (HR)', body: appraisalFormInput })
  createForm(@Body(new ZodPipe(appraisalFormInput)) body: AppraisalFormInput) {
    return this.appraisals.createForm(body);
  }

  @Post('forms/from-template')
  @Doc({ summary: 'Add a built-in template, such as the Frequent Research evaluation, as a form (HR)', body: templateKey })
  fromTemplate(@Body(new ZodPipe(templateKey)) body: z.infer<typeof templateKey>) {
    return this.appraisals.fromTemplate(body.key);
  }

  @Get('forms/:id')
  @Doc({ summary: 'One appraisal form (HR)' })
  form(@Param('id', UuidPipe) id: string) {
    return this.appraisals.getForm(id);
  }

  @Put('forms/:id')
  @Doc({ summary: 'Change a form. Running appraisals keep the version they started with.', body: appraisalFormInput })
  updateForm(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(appraisalFormInput)) body: AppraisalFormInput) {
    return this.appraisals.updateForm(id, body);
  }

  @Post('forms/:id/duplicate')
  @Doc({ summary: 'Copy a form (HR)' })
  duplicate(@Param('id', UuidPipe) id: string) {
    return this.appraisals.duplicateForm(id);
  }

  @Delete('forms/:id')
  @HttpCode(204)
  @Doc({ summary: 'Remove a form no draft or running cycle uses (HR)' })
  async archive(@Param('id', UuidPipe) id: string) {
    await this.appraisals.archiveForm(id);
  }

  @Get('cycles')
  @Doc({ summary: 'Appraisal cycles with progress by stage (HR)' })
  cycles() {
    return this.appraisals.listCycles();
  }

  @Post('cycles')
  @Doc({ summary: 'Create an appraisal cycle (HR)', body: appraisalCycleInput })
  createCycle(@Body(new ZodPipe(appraisalCycleInput)) body: AppraisalCycleInput) {
    return this.appraisals.createCycle(body);
  }

  @Get('cycles/:id')
  @Doc({ summary: 'A cycle and every appraisal in it (HR)' })
  cycle(@Param('id', UuidPipe) id: string) {
    return this.appraisals.getCycle(id);
  }

  @Put('cycles/:id')
  @Doc({ summary: 'Change a cycle. After launch only the name, dates and HR reviewers change.', body: appraisalCycleInput })
  updateCycle(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(appraisalCycleInput)) body: AppraisalCycleInput) {
    return this.appraisals.updateCycle(id, body);
  }

  @Post('cycles/:id/launch')
  @HttpCode(200)
  @Doc({ summary: 'Launch the cycle: everyone in it gets their appraisal and a notification (HR)' })
  launch(@Param('id', UuidPipe) id: string) {
    return this.appraisals.launch(id);
  }

  @Post('cycles/:id/publish')
  @HttpCode(200)
  @Doc({ summary: 'Publish every finalised appraisal in the cycle to its employee (HR)' })
  publishCycle(@Param('id', UuidPipe) id: string) {
    return this.appraisals.publishCycle(id);
  }

  @Post('cycles/:id/close')
  @HttpCode(200)
  @Doc({ summary: 'Close a running cycle (HR)' })
  close(@Param('id', UuidPipe) id: string) {
    return this.appraisals.closeCycle(id);
  }

  @Get('mine')
  @Doc({ summary: 'My appraisals, current first' })
  mine() {
    return this.appraisals.mine();
  }

  @Get('reviews')
  @Doc({ summary: "Appraisals I review: my team's (as manager) and those in HR review" })
  reviews() {
    return this.appraisals.toReview();
  }

  @Get(':id')
  @Doc({ summary: 'One appraisal, showing only what my part in it allows' })
  get(@Param('id', UuidPipe) id: string) {
    return this.appraisals.get(id);
  }

  @Put(':id/answers')
  @Doc({ summary: 'Save a draft of my part: self-appraisal, manager evaluation, or HR review', body: appraisalAnswersInput })
  save(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(appraisalHrInput)) body: z.infer<typeof appraisalHrInput>) {
    return this.appraisals.saveDraft(id, body.answers, body);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Doc({ summary: 'Submit my part; it locks and the appraisal moves to the next stage (HR submitting finalises it)' })
  submit(@Param('id', UuidPipe) id: string) {
    return this.appraisals.submit(id);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Doc({ summary: 'Share a finalised appraisal with the employee (HR)' })
  publish(@Param('id', UuidPipe) id: string) {
    return this.appraisals.publish(id);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @Doc({ summary: 'Send an appraisal back to a stage with a reason (HR)', body: appraisalReopenInput })
  reopen(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(appraisalReopenInput)) body: z.infer<typeof appraisalReopenInput>) {
    return this.appraisals.reopen(id, body);
  }
}
