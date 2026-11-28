import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  careerAccessInput, type CareerAccessInput, careerAssignInput, careerCallInput, type CareerCallInput, careerEmailInput, careerFollowUpInput, careerIntegrationInput,
  type CareerIntegrationInput, careerInterviewInput, type CareerInterviewInput, careerInterviewUpdate, careerListQuery, type CareerListQuery, careerMappingInput, careerNoteInput,
  careerStagesInput, careerStatusInput,
} from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { PlatformRealm, Public, RequireFeature } from '../../platform/authz/decorators';
import { contentDisposition } from '../../platform/http/content-disposition';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { CareerAccessService } from './career-access.service';
import { CareerConsoleService } from './career-console.service';
import { CareerSettingsService } from './career-settings.service';
import { CareerSyncService } from './career-sync.service';
import { CareerService } from './career.service';

const INLINE = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const fileQuery = z.object({ inline: z.enum(['0', '1']).optional() });
const interviewsQuery = z.object({ when: z.enum(['upcoming', 'past']).default('upcoming') });
const logQuery = z.object({ status: z.enum(['pending', 'running', 'succeeded', 'failed']).optional(), direction: z.enum(['inbound', 'cv', 'outbound']).optional() });
const retryInput = z.object({ jobIds: z.array(z.uuid()).max(200).optional() }).strict();
const dashboardQuery = careerListQuery.partial();

function stream(res: Response, f: { stream: NodeJS.ReadableStream; size: number; contentType: string; fileName: string }, inline: boolean) {
  res.setHeader('content-type', f.contentType);
  res.setHeader('content-length', String(f.size));
  res.setHeader('content-disposition', contentDisposition(inline && INLINE.has(f.contentType) ? 'inline' : 'attachment', f.fileName));
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  f.stream.pipe(res);
}

/**
 * Career Enquiry: applications and enquiries from the company's website. Super Workspace always; an HR Workspace only
 * while Super Workspace has it switched on (all applications or only assigned ones, with the powers given).
 */
@Controller('career-enquiry')
@RequireFeature('recruitment')
export class CareerEnquiryController {
  constructor(
    private readonly access: CareerAccessService,
    private readonly career: CareerService,
    private readonly settings: CareerSettingsService,
  ) {}

  @Get('context')
  @Doc({ summary: 'Your Career Enquiry access: level, HR Workspaces, powers, pipeline stages, assignees and the website connection' })
  context() {
    return this.career.context();
  }

  @Get('dashboard')
  @Doc({ summary: 'Dashboard: summary cards, pipeline, weekly trend, recent applications, upcoming interviews, follow-ups and sync health', query: dashboardQuery })
  dashboard(@Query(new ZodPipe(dashboardQuery)) q: Partial<CareerListQuery>) {
    return this.career.dashboard(q);
  }

  @Get('applications')
  @Doc({ summary: 'Applications you can see, filtered and sorted', query: careerListQuery })
  list(@Query(new ZodPipe(careerListQuery)) q: CareerListQuery) {
    return this.career.list(q);
  }

  @Get('applications/export.csv')
  @Doc({ summary: 'The filtered applications as CSV (needs the reports power; audited)', query: careerListQuery })
  async export(@Query(new ZodPipe(careerListQuery)) q: CareerListQuery, @Res() res: Response) {
    const f = await this.career.exportCsv(q);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', contentDisposition('attachment', f.fileName));
    res.setHeader('cache-control', 'private, no-store');
    res.send(f.content);
  }

  @Get('interviews')
  @Doc({ summary: 'Upcoming or past interviews of the applications you can see', query: interviewsQuery })
  interviews(@Query(new ZodPipe(interviewsQuery)) q: z.infer<typeof interviewsQuery>) {
    return this.career.interviews(q);
  }

  @Get('applications/:id')
  @Doc({ summary: 'The candidate profile: details sent by the website, CV, calls, emails, notes, follow-ups, interviews, history and CRM link' })
  get(@Param('id', UuidPipe) id: string) {
    return this.career.get(id);
  }

  @Post('applications/:id/status')
  @HttpCode(200)
  @Doc({ summary: 'Change the recruitment status (history keeps from, to, who, when and the reason; the website is told)', body: careerStatusInput })
  status(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(careerStatusInput)) body: z.infer<typeof careerStatusInput>) {
    return this.career.setStatus(id, body.stage, body.comment);
  }

  @Post('applications/:id/assign')
  @HttpCode(200)
  @Doc({ summary: 'Assign the HR manager and recruiter (Super Workspace can also hand it to an HR Workspace)', body: careerAssignInput })
  assign(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(careerAssignInput)) body: z.infer<typeof careerAssignInput>) {
    return this.career.assign(id, body);
  }

  @Post('applications/:id/notes')
  @Doc({ summary: 'Add an internal note or a recruitment comment', body: careerNoteInput })
  note(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(careerNoteInput)) body: z.infer<typeof careerNoteInput>) {
    return this.career.addNote(id, body);
  }

  @Post('applications/:id/calls')
  @Doc({ summary: 'Log a call: outcome, duration, notes, the next follow-up and (optionally) a new status', body: careerCallInput })
  call(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(careerCallInput)) body: CareerCallInput) {
    return this.career.logCall(id, body);
  }

  @Post('applications/:id/email')
  @HttpCode(202)
  @Doc({ summary: 'Email the candidate through SampCrew (logged on the profile)', body: careerEmailInput })
  email(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(careerEmailInput)) body: z.infer<typeof careerEmailInput>) {
    return this.career.email(id, body);
  }

  @Post('applications/:id/follow-ups')
  @Doc({ summary: 'Schedule a follow-up (with a reminder in the bell)', body: careerFollowUpInput })
  followUp(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(careerFollowUpInput)) body: z.infer<typeof careerFollowUpInput>) {
    return this.career.addFollowUp(id, body);
  }

  @Post('applications/:id/follow-ups/:followUpId/complete')
  @HttpCode(200)
  @Doc({ summary: 'Mark a follow-up done' })
  completeFollowUp(@Param('id', UuidPipe) id: string, @Param('followUpId', UuidPipe) followUpId: string) {
    return this.career.completeFollowUp(id, followUpId);
  }

  @Post('applications/:id/interviews')
  @Doc({ summary: 'Schedule an interview (telephonic, video or in person); the interviewer and HR are notified', body: careerInterviewInput })
  interview(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(careerInterviewInput)) body: CareerInterviewInput) {
    return this.career.scheduleInterview(id, body);
  }

  @Post('applications/:id/interviews/:interviewId')
  @HttpCode(200)
  @Doc({ summary: 'Reschedule, cancel or complete an interview', body: careerInterviewUpdate })
  updateInterview(@Param('id', UuidPipe) id: string, @Param('interviewId', UuidPipe) interviewId: string, @Body(new ZodPipe(careerInterviewUpdate)) body: z.infer<typeof careerInterviewUpdate>) {
    return this.career.updateInterview(id, interviewId, body);
  }

  @Post('applications/:id/move-to-crm')
  @HttpCode(200)
  @Doc({ summary: 'Move to Candidate CRM: links to the existing CRM candidate or shows the new one there; CV, history and notes carried, no duplicates' })
  moveToCrm(@Param('id', UuidPipe) id: string) {
    return this.career.moveToCrm(id);
  }

  @Get('applications/:id/files/:fileId')
  @Doc({ summary: 'Open or download the CV or a supporting document (audited)', query: fileQuery })
  async file(@Param('id', UuidPipe) id: string, @Param('fileId', UuidPipe) fileId: string, @Query(new ZodPipe(fileQuery)) q: z.infer<typeof fileQuery>, @Res() res: Response) {
    stream(res, await this.career.openFile(id, fileId), q.inline === '1');
  }

  @Get('applications/:id/photo')
  @Doc({ summary: 'The candidate photo the website sent, if any' })
  async photo(@Param('id', UuidPipe) id: string, @Res() res: Response) {
    stream(res, await this.career.openPhoto(id), true);
  }

  // Settings (Super Workspace) ---------------------------------------------------------------------------------

  @Get('settings')
  @Doc({ summary: 'Career Integration settings: website connection, keys (hints only), mapping, pipeline and sync counts' })
  getSettings() {
    return this.settings.get();
  }

  @Put('settings/integration')
  @Doc({ summary: 'Save the website connection and recruitment defaults', body: careerIntegrationInput })
  saveIntegration(@Body(new ZodPipe(careerIntegrationInput)) body: CareerIntegrationInput) {
    return this.settings.save(body);
  }

  @Post('settings/keys')
  @HttpCode(200)
  @Doc({ summary: 'Make a new API key and webhook secret (shown once; the old ones stop working)' })
  keys() {
    return this.settings.generateKeys();
  }

  @Post('settings/test')
  @HttpCode(200)
  @Doc({ summary: 'Test the connection: a signed status update the website answers without changing anything' })
  test() {
    return this.settings.test();
  }

  @Put('settings/mapping')
  @Doc({ summary: 'Map website fields to SampCrew candidate fields', body: careerMappingInput })
  mapping(@Body(new ZodPipe(careerMappingInput)) body: z.infer<typeof careerMappingInput>) {
    return this.settings.saveMapping(body);
  }

  @Put('settings/stages')
  @Doc({ summary: 'Customise the recruitment pipeline stages', body: careerStagesInput })
  stages(@Body(new ZodPipe(careerStagesInput)) body: z.infer<typeof careerStagesInput>) {
    return this.settings.saveStages(body);
  }

  @Get('settings/log')
  @Doc({ summary: 'Sync log: applications received, files fetched, status updates sent, with errors', query: logQuery })
  log(@Query(new ZodPipe(logQuery)) q: z.infer<typeof logQuery>) {
    return this.settings.log(q);
  }

  @Post('settings/retry')
  @HttpCode(200)
  @Doc({ summary: 'Retry failed synchronisation (all, or the jobs given)', body: retryInput })
  retry(@Body(new ZodPipe(retryInput)) body: z.infer<typeof retryInput>) {
    return this.settings.retry(body.jobIds);
  }

  @Get('access')
  @Doc({ summary: 'Super Workspace: Career Enquiry access for each HR Workspace and the company-wide HR team' })
  accessList() {
    return this.access.accessList();
  }

  @Put('access')
  @Doc({ summary: 'Super Workspace: switch Career Enquiry on or off per HR Workspace, all or assigned applications, and the powers', body: careerAccessInput })
  setAccess(@Body(new ZodPipe(careerAccessInput)) body: CareerAccessInput) {
    return this.access.setAccess(body);
  }
}

/**
 * The website's door into SampCrew. The website (for Frequent Research, its SampCrew connector) posts each application
 * to {SAMPCREW_API_URL}/candidates with "Authorization: Bearer {SAMPCREW_API_KEY}".
 */
@Controller('public/career-intake')
@Public()
export class CareerIntakeController {
  constructor(private readonly sync: CareerSyncService) {}

  @Post(':id/candidates')
  @HttpCode(201)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Doc({ summary: 'Receive one career application or enquiry from the company website (Bearer API key from Settings > Career Integration)' })
  receive(@Param('id') id: string, @Headers('authorization') auth: string | undefined, @Body() body: unknown) {
    return this.sync.receive(String(id).slice(0, 40), auth, body);
  }
}

/** Console: each company's website connection health. Counts and states only, never candidates. */
@Controller('platform/career-integrations')
export class PlatformCareerController {
  constructor(private readonly console: CareerConsoleService) {}

  @PlatformRealm('tenants:read')
  @Get()
  @Doc({ summary: 'Career Enquiry website connections of every company: status, last received, errors and queue counts' })
  list() {
    return this.console.list();
  }

  @PlatformRealm('tenants:manage')
  @Post(':tenantId/retry')
  @HttpCode(200)
  @Doc({ summary: 'Retry a company\'s failed website synchronisation' })
  retry(@Param('tenantId', UuidPipe) tenantId: string) {
    return this.console.retry(tenantId);
  }
}
