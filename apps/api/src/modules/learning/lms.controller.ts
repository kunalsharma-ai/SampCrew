import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, Res, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  assignModuleInput, type AssignModuleInput, blockProgressInput, gradeAttemptInput, LEARNING_MEDIA_MAX_BYTES, learningCategoryInput, learningModuleInput, type LearningModuleInput,
  learningPermissionsInput, learningReportQuery, type LearningReportQuery, moduleListQuery, publishModuleInput, quizAnswersInput, reviewSubmissionInput, submissionInput, SUBMISSION_STATUSES,
} from '@crew/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public, RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { contentDisposition } from '../../platform/http/content-disposition';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { sendFile, toXlsx } from '../../platform/export/tabular';
import type { UploadedFile } from '../documents/documents.service';
import { LearnerService } from './learner.service';
import { LearningReportsService } from './learning-reports.service';
import { LmsService } from './lms.service';

const fileQuery = z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(200) });
const uploadQuery = z.object({ purpose: z.enum(['content', 'submission']).default('content') });
const blockParam = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const reasonInput = z.object({ reason: z.string().trim().min(3).max(500) });
const reviewQuery = z.object({ status: z.enum([...SUBMISSION_STATUSES, 'all']).default('submitted') });
const archiveInput = z.object({ restore: z.boolean().default(false) });

/**
 * Learning & Development. Every route needs the Learning module and learning:read; what each person can do beyond
 * their own learning is decided in the services by their level (Super Workspace, or the powers the Super Workspace
 * gave their HR Workspace), never by the screen.
 */
@Controller('learning')
@RequireFeature('learning')
export class LmsController {
  constructor(private readonly lms: LmsService, private readonly learner: LearnerService, private readonly reports: LearningReportsService) {}

  @Get('access')
  @RequirePermission('learning:read')
  @Doc({ summary: 'What you can do in Learning: your level and the powers the Super Workspace gave your HR Workspace' })
  access() {
    return this.lms.myAccess();
  }

  @Get('options')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Categories, skills, languages and (for managers) the people and groups you can assign to' })
  options() {
    return this.lms.options();
  }

  @Post('categories')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Add a learning category (Super Workspace)', body: learningCategoryInput })
  addCategory(@Body(new ZodPipe(learningCategoryInput)) body: z.infer<typeof learningCategoryInput>) {
    return this.lms.addCategory(body.name);
  }

  @Delete('categories/:id')
  @HttpCode(204)
  @RequirePermission('learning:read')
  @Doc({ summary: 'Remove a learning category from the list (Super Workspace); modules keep their category' })
  removeCategory(@Param('id', UuidPipe) id: string) {
    return this.lms.removeCategory(id);
  }

  @Get('permissions')
  @RequirePermission('learning:read')
  @Doc({ summary: 'What each HR Workspace may do in Learning (Super Workspace)' })
  permissions() {
    return this.lms.permissions();
  }

  @Put('permissions')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Switch Learning powers on or off for an HR Workspace, or for company-wide HR (Super Workspace)', body: learningPermissionsInput })
  setPermissions(@Body(new ZodPipe(learningPermissionsInput)) body: z.infer<typeof learningPermissionsInput>) {
    return this.lms.setPermissions(body.hrWorkspaceId, body.caps);
  }

  // Modules ------------------------------------------------------------------------------------------------------

  @Get('modules')
  @RequirePermission('learning:read')
  @Doc({ summary: 'The learning library for managers, with search and filters', query: moduleListQuery })
  modules(@Query(new ZodPipe(moduleListQuery)) q: z.infer<typeof moduleListQuery>) {
    return this.lms.library(q);
  }

  @Post('modules')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Create a learning module (a draft)', body: learningModuleInput })
  create(@Body(new ZodPipe(learningModuleInput)) body: LearningModuleInput) {
    return this.lms.createModule(body);
  }

  @Get('modules/:id')
  @RequirePermission('learning:read')
  @Doc({ summary: 'A learning module with its content (for people who may edit it), versions and assignments' })
  module(@Param('id', UuidPipe) id: string) {
    return this.lms.module(id);
  }

  @Put('modules/:id')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Change a module. A published module keeps serving its published version until the changes are published.', body: learningModuleInput })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(learningModuleInput)) body: LearningModuleInput) {
    return this.lms.updateModule(id, body);
  }

  @Post('modules/:id/publish')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Publish the module now as its next version, or schedule the first publication', body: publishModuleInput })
  publish(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(publishModuleInput)) body: z.infer<typeof publishModuleInput>) {
    return this.lms.publish(id, body.publishAt, body.note);
  }

  @Post('modules/:id/unschedule')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Take a scheduled module back to draft' })
  unschedule(@Param('id', UuidPipe) id: string) {
    return this.lms.unschedule(id);
  }

  @Post('modules/:id/archive')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Archive a module (records stay; nobody new is enrolled), or restore it', body: archiveInput })
  archive(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(archiveInput)) body: z.infer<typeof archiveInput>) {
    return this.lms.archive(id, body.restore);
  }

  @Post('modules/:id/assign')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Assign a published module to people, HR Workspaces, departments, job roles, locations or employment types', body: assignModuleInput })
  assign(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(assignModuleInput)) body: AssignModuleInput) {
    return this.lms.assign(id, body);
  }

  @Post('modules/:id/audiences/:audienceId/stop')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Stop enrolling new people into an assignment that keeps enrolling' })
  stop(@Param('id', UuidPipe) id: string, @Param('audienceId', UuidPipe) audienceId: string) {
    return this.lms.stopAudience(id, audienceId);
  }

  @Get('modules/:id/learners')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Learners of a module that you can see, with progress and scores' })
  learners(@Param('id', UuidPipe) id: string) {
    return this.reports.moduleLearners(id);
  }

  @Post('modules/:id/enrol')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Enrol yourself in a module open to everyone' })
  enrol(@Param('id', UuidPipe) id: string) {
    return this.learner.enrol(id);
  }

  @Get('enrolments/:id')
  @RequirePermission('learning:read')
  @Doc({ summary: 'One learner’s enrolment in detail: each item, quiz attempts and submissions (HR and Super Workspace)' })
  enrolment(@Param('id', UuidPipe) id: string) {
    return this.reports.enrolment(id);
  }

  @Post('enrolments/:id/cancel')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Remove a person’s unfinished enrolment (history stays)', body: reasonInput })
  cancel(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(reasonInput)) body: z.infer<typeof reasonInput>) {
    return this.lms.cancelEnrolment(id, body.reason);
  }

  // My learning ---------------------------------------------------------------------------------------------------

  @Get('my')
  @RequirePermission('learning:read')
  @Doc({ summary: 'My learning: assigned and finished modules with progress, scores and deadlines, and modules I can enrol in' })
  my() {
    return this.learner.my();
  }

  @Get('my/:id')
  @RequirePermission('learning:read')
  @Doc({ summary: 'A module I am enrolled in: its content in order and my progress' })
  player(@Param('id', UuidPipe) id: string) {
    return this.learner.player(id);
  }

  @Post('my/:id/items/:blockId/progress')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Report what I did with a video, audio, reading or link (the server decides whether it is complete)', body: blockProgressInput })
  progress(@Param('id', UuidPipe) id: string, @Param('blockId', new ZodPipe(blockParam)) blockId: string, @Body(new ZodPipe(blockProgressInput)) body: z.infer<typeof blockProgressInput>) {
    return this.learner.progress(id, blockId, body);
  }

  @Post('my/:id/items/:blockId/attempts')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Start (or continue) a quiz attempt' })
  start(@Param('id', UuidPipe) id: string, @Param('blockId', new ZodPipe(blockParam)) blockId: string) {
    return this.learner.startAttempt(id, blockId);
  }

  @Put('my/:id/items/:blockId/attempts')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Save quiz answers so far', body: quizAnswersInput })
  save(@Param('id', UuidPipe) id: string, @Param('blockId', new ZodPipe(blockParam)) blockId: string, @Body(new ZodPipe(quizAnswersInput)) body: z.infer<typeof quizAnswersInput>) {
    return this.learner.saveAnswers(id, blockId, body);
  }

  @Post('my/:id/items/:blockId/attempts/submit')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Submit a quiz attempt; it is marked on the server', body: quizAnswersInput })
  submitQuiz(@Param('id', UuidPipe) id: string, @Param('blockId', new ZodPipe(blockParam)) blockId: string, @Body(new ZodPipe(quizAnswersInput)) body: z.infer<typeof quizAnswersInput>) {
    return this.learner.submitAttempt(id, blockId, body);
  }

  @Post('my/:id/items/:blockId/submissions')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Submit an assignment', body: submissionInput })
  submit(@Param('id', UuidPipe) id: string, @Param('blockId', new ZodPipe(blockParam)) blockId: string, @Body(new ZodPipe(submissionInput)) body: z.infer<typeof submissionInput>) {
    return this.learner.submit(id, blockId, body);
  }

  @Get('my/:id/certificate')
  @RequirePermission('learning:read')
  @Doc({ summary: 'My completion record and certificate for a finished module' })
  certificate(@Param('id', UuidPipe) id: string) {
    return this.learner.certificate(id);
  }

  // Files ---------------------------------------------------------------------------------------------------------

  @Post('files')
  @RequirePermission('learning:read')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LEARNING_MEDIA_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Upload a learning file (content for module creators, or a file for your own assignment)', query: uploadQuery })
  upload(@File() file: UploadedFile | undefined, @Query(new ZodPipe(uploadQuery)) q: z.infer<typeof uploadQuery>) {
    return this.lms.upload(file, q.purpose);
  }

  @Post('files/:id/link')
  @RequirePermission('learning:read')
  @Doc({ summary: 'A short signed link to a learning file you may see' })
  link(@Param('id', UuidPipe) id: string) {
    return this.lms.link(id);
  }

  // Dashboards, reports and reviews -------------------------------------------------------------------------------

  @Get('dashboard')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Learning dashboard for the Super Workspace or an HR Workspace, from the records it may see' })
  dashboard() {
    return this.reports.dashboard();
  }

  @Get('reports')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Learning report: every enrolment you may report on, with filters', query: learningReportQuery })
  report(@Query(new ZodPipe(learningReportQuery)) q: LearningReportQuery) {
    return this.reports.report(q);
  }

  @Get('reports/workspaces')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Learning by HR Workspace, department and job role' })
  byWorkspace() {
    return this.reports.workspaces();
  }

  @Get('reports/export.xlsx')
  @RequirePermission('learning:read')
  @Doc({ summary: 'The learning report as Excel (same filters and limits as the report)', query: learningReportQuery })
  async export(@Query(new ZodPipe(learningReportQuery)) q: LearningReportQuery, @Res() res: Response) {
    const rows = await this.reports.exportRows(q);
    sendFile(res, { fileName: `learning-report-${new Date().toISOString().slice(0, 10)}.xlsx`, content: toXlsx('Learning', rows) }, 'xlsx');
  }

  @Get('learners/:employeeId')
  @RequirePermission('learning:read')
  @Doc({ summary: 'One employee’s learning profile (HR and Super Workspace)' })
  learnerProfile(@Param('employeeId', UuidPipe) employeeId: string) {
    return this.reports.learner(employeeId);
  }

  @Get('reviews/submissions')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Assignment submissions to review', query: reviewQuery })
  submissions(@Query(new ZodPipe(reviewQuery)) q: z.infer<typeof reviewQuery>) {
    return this.reports.submissions(q.status);
  }

  @Post('reviews/submissions/:id')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Approve, reject or ask for a resubmission, with a score and feedback', body: reviewSubmissionInput })
  review(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(reviewSubmissionInput)) body: z.infer<typeof reviewSubmissionInput>) {
    return this.reports.review(id, body);
  }

  @Get('reviews/attempts')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Quiz attempts with written answers waiting for marks' })
  attempts() {
    return this.reports.pendingAttempts();
  }

  @Post('reviews/attempts/:id')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Mark the written answers of a quiz attempt', body: gradeAttemptInput })
  grade(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(gradeAttemptInput)) body: z.infer<typeof gradeAttemptInput>) {
    return this.reports.gradeAttempt(id, body.marks, body.feedback);
  }
}

/** Learning files through a short signed link; supports byte ranges so videos and audio can be seeked. */
@Controller('files/learning')
export class LearningFilesController {
  constructor(private readonly lms: LmsService) {}

  @Get(':id')
  @Public()
  @Doc({ summary: 'Open a learning file through a signed link (supports Range requests)', query: fileQuery })
  async file(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(fileQuery)) q: z.infer<typeof fileQuery>, @Req() req: Request, @Res() res: Response) {
    const f = await this.lms.open(id, q.exp, q.sig);
    const media = /^(video|audio|image)\//.test(f.contentType) || f.contentType === 'application/pdf';
    res.setHeader('content-type', f.contentType);
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-disposition', contentDisposition(media ? 'inline' : 'attachment', f.fileName));
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, f.size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : f.size - 1;
      end = Math.min(end, f.size - 1);
      if (start > end || start >= f.size) {
        res.status(416).setHeader('content-range', `bytes */${f.size}`);
        res.end();
        return;
      }
      start = Math.max(0, start);
      const { stream } = await this.lms.openRange(f.key, start, end);
      res.status(206);
      res.setHeader('content-range', `bytes ${start}-${end}/${f.size}`);
      res.setHeader('content-length', String(end - start + 1));
      stream.pipe(res);
      return;
    }
    const { stream, size } = await this.lms.openRange(f.key);
    res.setHeader('content-length', String(size));
    stream.pipe(res);
  }
}
