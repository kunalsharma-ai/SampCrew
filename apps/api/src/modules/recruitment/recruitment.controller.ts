import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  applicationListQuery,
  applyInput,
  candidateInput,
  type CandidateInput,
  candidatePatch,
  careerSiteInput,
  type CareerSiteInput,
  feedbackInput,
  type FeedbackInput,
  hireInput,
  interviewInput,
  type InterviewInput,
  moveStageInput,
  noteInput,
  offerInput,
  type OfferInput,
  offerResponseInput,
  postingInput,
  type PostingInput,
  publicApplyInput,
  type PublicApplyInput,
  bulkApplicationsInput,
  type BulkApplicationsInput,
  rejectInput,
  REQUISITION_STATUSES,
  requisitionInput,
  type RequisitionInput,
  requisitionStatusInput,
  RESUME_MAX_BYTES,
  stageInput,
  stageOrderInput,
  patchOf,
} from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { Public, RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import type { UploadedFile } from '../documents/documents.service';
import { CandidatesService } from './candidates.service';
import { CareersService } from './careers.service';
import { InterviewsService } from './interviews.service';
import { OffersService } from './offers.service';
import { RequisitionsService } from './requisitions.service';

const requisitionPatch = patchOf(requisitionInput);
const listQuery = z.object({ status: z.enum(REQUISITION_STATUSES).optional(), scope: z.enum(['all', 'mine']).default('all') });
const candidateQuery = z.object({ q: z.string().trim().max(120).optional(), tag: z.string().trim().max(30).optional(), requisitionId: z.uuid().optional() });
const peopleQuery = z.object({ q: z.string().trim().max(120).optional() });
const reasonInput = z.object({ reason: z.string().trim().min(3).max(500) });
const renameInput = z.object({ name: z.string().trim().min(2).max(40) });
const fileQuery = z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(200) });
const noteBody = noteInput.extend({ applicationId: z.uuid().optional() });

const compareQuery = z.object({
  /** Two to four application ids, separated by commas. */
  applications: z.string().regex(/^[0-9a-f-]{36}(,[0-9a-f-]{36}){1,3}$/i, 'Choose two to four candidates to compare'),
});

@Controller('recruitment')
@RequireFeature('recruitment')
export class RecruitmentController {
  constructor(
    private readonly requisitions: RequisitionsService,
    private readonly candidates: CandidatesService,
    private readonly interviews: InterviewsService,
    private readonly offers: OffersService,
    private readonly careers: CareersService,
  ) {}

  // Requisitions ------------------------------------------------------------------------------------------

  @Get('requisitions')
  @RequirePermission('requisitions:read')
  @Doc({ summary: 'Job requisitions you can see', query: listQuery })
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.requisitions.list(q);
  }

  @Post('requisitions')
  @RequirePermission('requisitions:create')
  @Doc({ summary: 'Raise a requisition (saved as a draft)', body: requisitionInput })
  create(@Body(new ZodPipe(requisitionInput)) body: RequisitionInput) {
    return this.requisitions.create(body);
  }

  @Get('requisitions/:id')
  @RequirePermission('requisitions:read')
  @Doc({ summary: 'A requisition with its posting and what you can do with it' })
  get(@Param('id', UuidPipe) id: string) {
    return this.requisitions.get(id);
  }

  @Patch('requisitions/:id')
  @RequirePermission('requisitions:create')
  @Doc({ summary: 'Change a requisition. After approval only wording, scorecard, start date and hiring manager can change.', body: requisitionPatch })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(requisitionPatch)) body: Partial<RequisitionInput>) {
    return this.requisitions.update(id, body);
  }

  @Post('requisitions/:id/submit')
  @HttpCode(200)
  @RequirePermission('requisitions:create')
  @Doc({ summary: 'Send a draft requisition for approval' })
  submit(@Param('id', UuidPipe) id: string) {
    return this.requisitions.submit(id);
  }

  @Post('requisitions/:id/status')
  @HttpCode(200)
  @RequirePermission('requisitions:create')
  @Doc({ summary: 'Open, hold, reopen, close or cancel a requisition', body: requisitionStatusInput })
  status(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(requisitionStatusInput)) body: z.infer<typeof requisitionStatusInput>) {
    return this.requisitions.setStatus(id, body);
  }

  @Put('requisitions/:id/posting')
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Write or update the public job posting', body: postingInput })
  posting(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(postingInput)) body: PostingInput) {
    return this.requisitions.savePosting(id, body);
  }

  @Post('requisitions/:id/posting/publish')
  @HttpCode(200)
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Publish the posting on the career site (the requisition must be open)' })
  publish(@Param('id', UuidPipe) id: string) {
    return this.requisitions.publish(id, true);
  }

  @Post('requisitions/:id/posting/unpublish')
  @HttpCode(200)
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Take the posting off the career site' })
  unpublish(@Param('id', UuidPipe) id: string) {
    return this.requisitions.publish(id, false);
  }

  @Get('requisitions/:id/pipeline')
  @RequirePermission('candidates:read')
  @Doc({ summary: 'Stages and the applications in them', query: applicationListQuery })
  pipeline(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(applicationListQuery)) q: z.infer<typeof applicationListQuery>) {
    return this.candidates.pipeline(id, q);
  }

  @Post('requisitions/:id/applications/bulk')
  @HttpCode(200)
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Move, reject or email up to 100 candidates for a job at once; each is checked on its own and the result lists any skipped', body: bulkApplicationsInput })
  bulk(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(bulkApplicationsInput)) body: BulkApplicationsInput) {
    return this.candidates.bulk(id, body);
  }

  @Get('requisitions/:id/compare')
  @RequirePermission('candidates:read')
  @Doc({ summary: 'Compare 2 to 4 candidates for a job side by side: stage, time in process, scores per criterion and recommendations', query: compareQuery })
  compare(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(compareQuery)) q: z.infer<typeof compareQuery>) {
    return this.candidates.compare(id, [...new Set(q.applications.toLowerCase().split(','))]);
  }

  @Get('people')
  @Doc({ summary: 'Active members to pick as hiring manager or interviewer', query: peopleQuery })
  people(@Query(new ZodPipe(peopleQuery)) q: z.infer<typeof peopleQuery>) {
    return this.requisitions.people(q.q);
  }

  // Candidates and applications ---------------------------------------------------------------------------

  @Get('candidates')
  @RequirePermission('candidates:read')
  @Doc({ summary: 'Candidates you can see', query: candidateQuery })
  candidatesList(@Query(new ZodPipe(candidateQuery)) q: z.infer<typeof candidateQuery>) {
    return this.candidates.list(q);
  }

  @Post('candidates')
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Add a candidate, optionally straight into a job', body: candidateInput })
  addCandidate(@Body(new ZodPipe(candidateInput)) body: CandidateInput) {
    return this.candidates.create(body);
  }

  @Get('candidates/:id')
  @RequirePermission('candidates:read')
  @Doc({ summary: 'Candidate profile: applications, history, notes, interviews, offers and files' })
  candidate(@Param('id', UuidPipe) id: string) {
    return this.candidates.get(id);
  }

  @Patch('candidates/:id')
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Update a candidate', body: candidatePatch })
  updateCandidate(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(candidatePatch)) body: z.infer<typeof candidatePatch>) {
    return this.candidates.update(id, body);
  }

  @Post('candidates/:id/applications')
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Put an existing candidate forward for a job', body: applyInput })
  apply(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(applyInput)) body: z.infer<typeof applyInput>) {
    return this.candidates.apply(id, body.requisitionId);
  }

  @Post('candidates/:id/notes')
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Add a note', body: noteBody })
  note(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(noteBody)) body: z.infer<typeof noteBody>) {
    return this.candidates.addNote(id, body.body, body.applicationId);
  }

  @Post('candidates/:id/files')
  @RequirePermission('candidates:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: RESUME_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Upload a CV (PDF or Word, up to 5 MB). Send as multipart/form-data with a "file" part.' })
  upload(@Param('id', UuidPipe) id: string, @File() file?: UploadedFile) {
    return this.candidates.uploadResume(id, file);
  }

  @Post('candidates/:id/erase')
  @HttpCode(200)
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Erase a candidate’s personal data (for example on their request). Cannot be undone.', body: reasonInput })
  erase(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(reasonInput)) body: z.infer<typeof reasonInput>) {
    return this.candidates.erase(id, body.reason);
  }

  @Get('candidate-files/:id/link')
  @Doc({ summary: 'A 5-minute download link for a CV (audited)' })
  fileLink(@Param('id', UuidPipe) id: string) {
    return this.candidates.fileLink(id);
  }

  @Post('applications/:id/move')
  @HttpCode(200)
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Move an application to another stage', body: moveStageInput })
  move(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(moveStageInput)) body: z.infer<typeof moveStageInput>) {
    return this.candidates.move(id, body);
  }

  @Post('applications/:id/reject')
  @HttpCode(200)
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Reject an application, with a reason', body: rejectInput })
  reject(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(rejectInput)) body: z.infer<typeof rejectInput>) {
    return this.candidates.reject(id, body);
  }

  @Post('applications/:id/withdraw')
  @HttpCode(200)
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Record that the candidate withdrew' })
  withdraw(@Param('id', UuidPipe) id: string) {
    return this.candidates.withdraw(id);
  }

  @Post('applications/:id/reopen')
  @HttpCode(200)
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Reopen a rejected or withdrawn application' })
  reopen(@Param('id', UuidPipe) id: string) {
    return this.candidates.reopen(id);
  }

  @Post('applications/:id/interviews')
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Schedule an interview and notify the panel (and optionally the candidate)', body: interviewInput })
  schedule(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(interviewInput)) body: InterviewInput) {
    return this.interviews.schedule(id, body);
  }

  @Post('applications/:id/offers')
  @RequirePermission('offers:manage')
  @Doc({ summary: 'Draft an offer', body: offerInput })
  draftOffer(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(offerInput)) body: OfferInput) {
    return this.offers.create(id, body);
  }

  @Post('applications/:id/hire')
  @RequirePermission('employees:create')
  @Doc({ summary: 'Create the employee record from an accepted offer', body: hireInput })
  hire(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(hireInput)) body: z.infer<typeof hireInput>) {
    return this.offers.hire(id, body);
  }

  // Interviews --------------------------------------------------------------------------------------------

  @Get('interviews/mine')
  @RequirePermission('interviews:feedback')
  @Doc({ summary: 'Interviews where you are on the panel' })
  myInterviews() {
    return this.interviews.mine();
  }

  @Get('interviews/:id')
  @RequirePermission('interviews:feedback')
  @Doc({ summary: 'An interview with the scorecards you are allowed to see' })
  interview(@Param('id', UuidPipe) id: string) {
    return this.interviews.get(id);
  }

  @Post('interviews/:id/cancel')
  @HttpCode(200)
  @RequirePermission('candidates:manage')
  @Doc({ summary: 'Cancel an interview', body: reasonInput })
  cancelInterview(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(reasonInput)) body: z.infer<typeof reasonInput>) {
    return this.interviews.cancel(id, body.reason);
  }

  @Post('interviews/:id/feedback')
  @RequirePermission('interviews:feedback')
  @Doc({ summary: 'Submit your scorecard (once)', body: feedbackInput })
  feedback(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(feedbackInput)) body: FeedbackInput) {
    return this.interviews.submitFeedback(id, body);
  }

  // Offers ------------------------------------------------------------------------------------------------

  @Get('offers/:id')
  @RequirePermission('candidates:read')
  @Doc({ summary: 'Find the candidate and application an offer belongs to' })
  offer(@Param('id', UuidPipe) id: string) {
    return this.offers.locate(id);
  }

  @Put('offers/:id')
  @RequirePermission('offers:manage')
  @Doc({ summary: 'Change a draft or rejected offer', body: offerInput })
  updateOffer(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(offerInput)) body: OfferInput) {
    return this.offers.update(id, body);
  }

  @Post('offers/:id/submit')
  @HttpCode(200)
  @RequirePermission('offers:manage')
  @Doc({ summary: 'Send an offer for approval' })
  submitOffer(@Param('id', UuidPipe) id: string) {
    return this.offers.submit(id);
  }

  @Post('offers/:id/send')
  @HttpCode(200)
  @RequirePermission('offers:manage')
  @Doc({ summary: 'Mark an approved offer as sent and email the candidate its main terms' })
  sendOffer(@Param('id', UuidPipe) id: string) {
    return this.offers.send(id);
  }

  @Post('offers/:id/response')
  @HttpCode(200)
  @RequirePermission('offers:manage')
  @Doc({ summary: 'Record the candidate’s answer', body: offerResponseInput })
  respond(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(offerResponseInput)) body: z.infer<typeof offerResponseInput>) {
    return this.offers.respond(id, body);
  }

  @Post('offers/:id/withdraw')
  @HttpCode(200)
  @RequirePermission('offers:manage')
  @Doc({ summary: 'Withdraw an offer' })
  withdrawOffer(@Param('id', UuidPipe) id: string) {
    return this.offers.withdraw(id);
  }

  // Settings ----------------------------------------------------------------------------------------------

  @Get('settings/stages')
  @Doc({ summary: 'Pipeline stages' })
  stages() {
    return this.careers.stages();
  }

  @Post('settings/stages')
  @RequirePermission('recruitment:configure')
  @Doc({ summary: 'Add a stage (placed before Hired)', body: stageInput })
  addStage(@Body(new ZodPipe(stageInput)) body: z.infer<typeof stageInput>) {
    return this.careers.addStage(body);
  }

  @Patch('settings/stages/:id')
  @RequirePermission('recruitment:configure')
  @Doc({ summary: 'Rename a stage', body: renameInput })
  renameStage(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(renameInput)) body: z.infer<typeof renameInput>) {
    return this.careers.renameStage(id, body.name);
  }

  @Put('settings/stages/order')
  @RequirePermission('recruitment:configure')
  @Doc({ summary: 'Reorder stages (Applied first, Hired last)', body: stageOrderInput })
  reorder(@Body(new ZodPipe(stageOrderInput)) body: z.infer<typeof stageOrderInput>) {
    return this.careers.reorderStages(body.stageIds);
  }

  @Delete('settings/stages/:id')
  @HttpCode(204)
  @RequirePermission('recruitment:configure')
  @Doc({ summary: 'Remove an empty stage' })
  async archiveStage(@Param('id', UuidPipe) id: string) {
    await this.careers.archiveStage(id);
  }

  @Get('settings/career-site')
  @RequirePermission('recruitment:configure')
  @Doc({ summary: 'Career site settings' })
  site() {
    return this.careers.site();
  }

  @Put('settings/career-site')
  @RequirePermission('recruitment:configure')
  @Doc({ summary: 'Save career site settings', body: careerSiteInput })
  saveSite(@Body(new ZodPipe(careerSiteInput)) body: CareerSiteInput) {
    return this.careers.saveSite(body);
  }
}

/** The public career site. No sign-in; the workspace is found from the site's address. */
@Controller('public/careers')
@Public()
export class CareersPublicController {
  constructor(private readonly careers: CareersService) {}

  @Get(':site')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Doc({ summary: 'A career site and its open jobs' })
  site(@Param('site') site: string) {
    return this.careers.publicSite(String(site).slice(0, 40));
  }

  @Get(':site/jobs/:job')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Doc({ summary: 'One open job with the privacy notice applicants agree to' })
  job(@Param('site') site: string, @Param('job') job: string) {
    return this.careers.publicJob(String(site).slice(0, 40), String(job).slice(0, 40));
  }

  @Post(':site/jobs/:job/apply')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('cv', { limits: { fileSize: RESUME_MAX_BYTES, files: 1, fields: 20, fieldSize: 10_000 } }))
  @Doc({ summary: 'Apply for a job (multipart/form-data with the fields below and a "cv" file part)', body: publicApplyInput })
  apply(@Param('site') site: string, @Param('job') job: string, @Body(new ZodPipe(publicApplyInput)) body: PublicApplyInput, @File() file?: UploadedFile) {
    return this.careers.apply(String(site).slice(0, 40), String(job).slice(0, 40), body, file);
  }
}

@Controller('files/resumes')
export class ResumeFilesController {
  constructor(private readonly candidates: CandidatesService) {}

  @Get(':id')
  @Public()
  @Doc({ summary: 'Download a CV through a signed link', query: fileQuery })
  async file(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(fileQuery)) q: z.infer<typeof fileQuery>, @Res() res: Response) {
    const f = await this.candidates.openFile(id, q.exp, q.sig);
    res.setHeader('content-type', f.contentType);
    res.setHeader('content-length', String(f.size));
    res.setHeader('content-disposition', `attachment; filename="${f.fileName.replace(/"/g, '')}"`);
    res.setHeader('cache-control', 'private, no-store');
    f.stream.pipe(res);
  }
}
